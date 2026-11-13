'use strict';

const crypto = require('crypto');
const GraphSubscription = require('../models/GraphSubscription');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const { signalMailboxSync } = require('../services/supportEmail/mailboxSyncService');
const { buildWebhookDedupeKey } = require('../services/supportEmail/dedupeService');
const { SubscriptionService, timingSafeCompare, hashClientState } = require('../services/supportEmail/subscriptionService');

const defaultSubscriptionService = new SubscriptionService();

/**
 * Handles incoming Microsoft Graph Webhook requests.
 *
 * Paths:
 * 1. Validation Handshake: Graph sends `validationToken` in query parameter.
 *    Responds with exact text/plain decoded token within 10s without accessing MongoDB.
 * 2. Notification Processing: Graph sends JSON array of change/lifecycle events in `req.body.value`.
 *    Authenticates `clientState`, persists events in SupportEmailWebhookEvent,
 *    and signals `mailboxSyncService` monotonically.
 */
async function handleGraphWebhook(req, res, { subscriptionSvc = defaultSubscriptionService } = {}) {
  // 1. Validation Handshake
  // Express query parser already performs standard URL decoding once.
  // We send the exact token string without secondary decoding to avoid double-decoding bugs.
  if (req.query && typeof req.query.validationToken !== 'undefined') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(String(req.query.validationToken));
  }

  // 2. Notification Payload Validation
  if (!req.body || !Array.isArray(req.body.value)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid Graph notification payload (missing value array)'
    });
  }

  const notifications = req.body.value;
  if (notifications.length === 0) {
    return res.status(202).json({ success: true, message: 'Empty notification array' });
  }

  // 3. Process and Authenticate Each Notification
  try {
    for (const item of notifications) {
      const { subscriptionId, clientState, resource, changeType, resourceData, lifecycleEvent } = item;

      if (!subscriptionId) {
        return res.status(400).json({
          success: false,
          message: 'Notification item missing required subscriptionId'
        });
      }

      // Look up subscription to verify mailbox mapping and expected clientStateHash
      const subscription = await GraphSubscription.findOne({ subscriptionId }).lean();
      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: 'Unknown or unregistered subscription'
        });
      }

      // Security: Validate clientState using constant-time comparison against stored cryptographic hash
      const expectedHash = subscription.clientStateHash;
      const incomingHmac = hashClientState(clientState, process.env.MS_GRAPH_CLIENT_STATE_SECRET);
      const incomingSha256 = crypto.createHash('sha256').update(clientState || '').digest('hex');
      const isValid = Boolean(
        clientState &&
        expectedHash &&
        (timingSafeCompare(incomingHmac, expectedHash) || timingSafeCompare(incomingSha256, expectedHash))
      );

      if (!isValid) {
        // Reject unauthorized requests without leaking the expected secret
        return res.status(401).json({
          success: false,
          message: 'Unauthorized (invalid or missing clientState)'
        });
      }

      const mailbox = subscription.mailbox;
      const folder = subscription.folder || 'inbox';

      // Verify mailbox is enabled for ingestion
      if (mailbox) {
        const policy = await EmailIngestionPolicy.findOne({
          mailbox: mailbox.toLowerCase(),
          enabled: true
        }).lean();

        if (!policy) {
          // Mailbox is disabled or not found in policy; ignore gracefully
          continue;
        }
      }

      // 4. Handle Lifecycle Notifications (missed, reauth, subscriptionRemoved)
      if (lifecycleEvent) {
        await subscriptionSvc.handleLifecycleNotification(item);

        // Record lifecycle event in database
        const lifecycleDedupeKey = `lifecycle:${subscriptionId}:${lifecycleEvent}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;
        try {
          await SupportEmailWebhookEvent.create({
            subscriptionId,
            resource: resource || subscription.resource,
            changeType: 'lifecycle',
            lifecycleEventType: lifecycleEvent,
            tenantId: item.tenantId || null,
            dedupeKey: lifecycleDedupeKey,
            receivedAt: new Date(),
            status: 'processed',
            processedAt: new Date(),
            metadata: { mailbox, folder, lifecycleEvent }
          });
        } catch (err) {
          if (err.code !== 11000) throw err;
        }
        continue;
      }

      // 5. Handle Standard Change Notifications
      // Compute deduplication key:
      // If message-level: resourceData.id provides permanent deduplication per message.
      // If collection-level: a 5-minute timeBucket bounds deduplication so future changes are NOT permanently suppressed.
      const resourceId = resourceData?.id || null;
      const timeBucket = resourceId ? null : Math.floor(Date.now() / (5 * 60 * 1000));

      const dedupeKey = buildWebhookDedupeKey({
        subscriptionId,
        resource: resource || subscription.resource,
        changeType: changeType || 'updated',
        resourceId,
        timeBucket
      });

      try {
        await SupportEmailWebhookEvent.create({
          subscriptionId,
          resource: resource || subscription.resource,
          changeType: changeType || 'updated',
          tenantId: item.tenantId || null,
          dedupeKey,
          resourceDataId: resourceId,
          clientStateHash: subscription.clientStateHash || null,
          receivedAt: new Date(),
          status: 'received',
          metadata: {
            mailbox,
            folder
          }
        });

        // New notification successfully persisted! Wake up sync engine monotonically
        if (mailbox) {
          await signalMailboxSync({
            mailbox,
            folder
          });
        }
      } catch (err) {
        if (err.code === 11000) {
          // Safe duplicate notification: already recorded and signaled within dedupe window
          // Do not signal duplicate sync, do not fail HTTP response
          continue;
        }
        // If MongoDB persistence failed, throw so outer catch block returns 500 for Graph retry
        throw err;
      }
    }

    // Acknowledge quickly to Microsoft Graph
    return res.status(202).json({
      success: true,
      message: 'Notifications accepted'
    });
  } catch (err) {
    console.error('[handleGraphWebhook] Notification processing failure:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Notification persistence error; retry requested'
    });
  }
}

module.exports = {
  handleGraphWebhook
};
