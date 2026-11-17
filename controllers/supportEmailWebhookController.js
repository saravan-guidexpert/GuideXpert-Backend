'use strict';

const GraphSubscription = require('../models/GraphSubscription');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const { signalMailboxSync } = require('../services/supportEmail/mailboxSyncService');
const { buildWebhookDedupeKey } = require('../services/supportEmail/dedupeService');
const { SubscriptionService, verifySubscriptionClientState } = require('../services/supportEmail/subscriptionService');
const {
  logOperationalEvent,
  incrementMetric,
  summarizeError
} = require('../services/supportEmail/observability');

const defaultSubscriptionService = new SubscriptionService();

/**
 * Extracts the mailbox/user segment from a Microsoft Graph resource path.
 *
 * Supports both path styles Graph emits:
 *   users/support@example.com/mailFolders('inbox')/messages
 *   users('support@example.com')/messages('AAMk...')
 *
 * @param {string} resource
 * @returns {string|null} Lower-cased decoded mailbox, or null when the path is unrecognized
 */
function extractMailboxFromGraphResource(resource) {
  if (!resource || typeof resource !== 'string') return null;
  const match = /(?:^|\/)users(?:\(|%28)?['"]?\/?([^'")\/]+)/i.exec(resource.trim());
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim().toLowerCase();
  } catch {
    return match[1].trim().toLowerCase();
  }
}

function normalizeResource(resource) {
  return String(resource || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Validates that an incoming notification resource belongs to the registered subscription.
 *
 * The clientState proves the notification came from Graph for this subscription. This check adds
 * a second boundary: a notification must not name a different mailbox/user than the subscription
 * it claims to belong to. Graph may report message-level resources
 * (users('x')/messages('id')) rather than the folder-scoped subscription path, so exact-prefix
 * matching alone would incorrectly reject valid notifications.
 *
 * @param {Object} params
 * @param {string} params.notificationResource
 * @param {Object} params.subscription Stored GraphSubscription
 * @returns {boolean}
 */
function resourceBelongsToSubscription({ notificationResource, subscription }) {
  if (!notificationResource || !subscription) return false;

  const normalizedNotification = normalizeResource(notificationResource);
  const normalizedSubscription = normalizeResource(subscription.resource);

  // Exact match of the subscribed resource is always valid.
  if (normalizedSubscription && normalizedNotification === normalizedSubscription) {
    return true;
  }

  const notificationMailbox = extractMailboxFromGraphResource(notificationResource);
  if (!notificationMailbox) return false;

  const expectedMailbox = subscription.mailbox
    ? String(subscription.mailbox).trim().toLowerCase()
    : extractMailboxFromGraphResource(subscription.resource);

  if (!expectedMailbox) return false;
  return notificationMailbox === expectedMailbox;
}

/**
 * Handles incoming Microsoft Graph Webhook requests.
 *
 * Paths:
 * 1. Validation Handshake: Graph sends `validationToken` in query parameter.
 *    Responds with exact text/plain decoded token within 10s without accessing MongoDB.
 * 2. Notification Processing: Graph sends JSON array of change/lifecycle events in `req.body.value`.
 *    Authenticates `clientState` and resource scope, persists events in SupportEmailWebhookEvent,
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

  incrementMetric('webhook_notifications_received', notifications.length);
  logOperationalEvent('info', 'support_email_webhook_batch_received', {
    notificationCount: notifications.length
  });

  // 3. Authenticate the ENTIRE batch before persisting anything.
  // Rejecting a mixed batch after partially persisting it would make retry semantics ambiguous.
  const subscriptionCache = new Map();
  const policyCache = new Map();
  const validated = [];

  try {
    for (const item of notifications) {
      const { subscriptionId, clientState, resource, changeType, resourceData, lifecycleEvent } = item;

      if (!subscriptionId) {
        incrementMetric('webhook_notifications_rejected', 1, { reason: 'missing_subscription_id' });
        logOperationalEvent('warn', 'support_email_webhook_rejected', { reason: 'missing_subscription_id' });
        return res.status(400).json({
          success: false,
          message: 'Notification item missing required subscriptionId'
        });
      }

      let subscription = subscriptionCache.get(subscriptionId);
      if (!subscription) {
        subscription = await GraphSubscription.findOne({ subscriptionId }).lean();
        if (!subscription) {
          incrementMetric('webhook_notifications_rejected', 1, { reason: 'unknown_subscription' });
          logOperationalEvent('warn', 'support_email_webhook_rejected', {
            reason: 'unknown_subscription',
            subscriptionId
          });
          return res.status(404).json({
            success: false,
            message: 'Unknown or unregistered subscription'
          });
        }
        subscriptionCache.set(subscriptionId, subscription);
      }

      // Security: Validate clientState using trusted persisted subscription metadata and versioned keys.
      const isValid = verifySubscriptionClientState({
        clientState,
        subscription,
        env: process.env
      });

      if (!isValid) {
        // Reject unauthorized requests without leaking the expected secret.
        incrementMetric('webhook_notifications_rejected', 1, { reason: 'invalid_client_state' });
        logOperationalEvent('warn', 'support_email_webhook_rejected', {
          reason: 'invalid_client_state',
          subscriptionId,
          mailbox: subscription.mailbox
        });
        return res.status(401).json({
          success: false,
          message: 'Unauthorized (invalid or missing clientState)'
        });
      }

      // Do not trust the notification's resource path. Lifecycle events may omit it; for change
      // notifications the resource must resolve to the same mailbox as the subscription.
      if (!lifecycleEvent) {
        const resourceIsValid = resourceBelongsToSubscription({
          notificationResource: resource,
          subscription
        });
        if (!resourceIsValid) {
          incrementMetric('webhook_notifications_rejected', 1, { reason: 'resource_scope_mismatch' });
          logOperationalEvent('warn', 'support_email_webhook_rejected', {
            reason: 'resource_scope_mismatch',
            subscriptionId,
            mailbox: subscription.mailbox
          });
          return res.status(400).json({
            success: false,
            message: 'Notification resource does not belong to the registered subscription'
          });
        }
      }

      const mailbox = subscription.mailbox;
      const folder = subscription.folder || 'inbox';

      // Verify mailbox is enabled for ingestion.
      let policyEnabled = true;
      if (mailbox) {
        let policy = policyCache.get(mailbox.toLowerCase());
        if (policy === undefined) {
          policy = await EmailIngestionPolicy.findOne({
            mailbox: mailbox.toLowerCase(),
            enabled: true
          }).lean();
          policyCache.set(mailbox.toLowerCase(), policy);
        }
        policyEnabled = Boolean(policy);
      }

      if (!policyEnabled) {
        // Mailbox is disabled or not found in policy; acknowledge but ignore gracefully.
        continue;
      }

      validated.push({
        item,
        subscription,
        mailbox,
        folder,
        changeType,
        resourceData,
        lifecycleEvent
      });
    }
  } catch (err) {
    incrementMetric('webhook_notifications_rejected', 1, { reason: 'validation_error' });
    logOperationalEvent('error', 'support_email_webhook_validation_error', summarizeError(err));
    return res.status(500).json({
      success: false,
      message: 'Notification validation error; retry requested'
    });
  }

  // 4. Persist and signal each authenticated notification.
  try {
    for (const entry of validated) {
      const {
        item,
        subscription,
        mailbox,
        folder,
        changeType,
        resourceData,
        lifecycleEvent
      } = entry;
      const subscriptionId = subscription.subscriptionId;
      const resource = item.resource || subscription.resource;

      if (lifecycleEvent) {
        await subscriptionSvc.handleLifecycleNotification(item);

        // Record lifecycle event in database. A 5-minute bucket bounds duplicate suppression
        // while still allowing a later lifecycle transition to be recorded.
        const lifecycleDedupeKey = `lifecycle:${subscriptionId}:${lifecycleEvent}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;
        try {
          await SupportEmailWebhookEvent.create({
            subscriptionId,
            resource,
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

      // Handle Standard Change Notifications.
      // Compute deduplication key:
      // If message-level: resourceData.id provides permanent deduplication per message.
      // If collection-level: a 5-minute timeBucket bounds deduplication so future changes are
      // NOT permanently suppressed.
      const resourceId = resourceData?.id || null;
      const timeBucket = resourceId ? null : Math.floor(Date.now() / (5 * 60 * 1000));

      const dedupeKey = buildWebhookDedupeKey({
        subscriptionId,
        resource,
        changeType: changeType || 'updated',
        resourceId,
        timeBucket
      });

      let eventRecord;
      try {
        eventRecord = await SupportEmailWebhookEvent.create({
          subscriptionId,
          resource,
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
      } catch (err) {
        if (err.code === 11000) {
          incrementMetric('webhook_notifications_duplicate', 1);
          logOperationalEvent('info', 'support_email_webhook_duplicate', {
            subscriptionId,
            mailbox,
            folder
          });

          // Duplicate delivery. Normally no new signal is needed because the original delivery
          // signalled sync. If the original delivery failed BETWEEN persistence and signalling,
          // repair that gap so a webhook is never acknowledged without a pending sync.
          const existing = await SupportEmailWebhookEvent.findOne({ dedupeKey }).lean();
          if (
            existing &&
            existing.status === 'failed' &&
            existing.errorCategory === 'sync_signal_failed' &&
            mailbox
          ) {
            await signalMailboxSync({ mailbox, folder });
            await SupportEmailWebhookEvent.updateOne(
              { _id: existing._id },
              {
                $set: {
                  status: 'received',
                  errorCategory: null,
                  error: null,
                  processedAt: null
                }
              }
            );
          }
          continue;
        }
        // If MongoDB persistence failed, throw so outer catch block returns 500 for Graph retry.
        throw err;
      }

      // New notification successfully persisted! Wake up sync engine monotonically.
      incrementMetric('webhook_notifications_accepted', 1);
      if (mailbox) {
        try {
          await signalMailboxSync({ mailbox, folder });
        } catch (signalErr) {
          // Persisted but not signalled: mark the event so a duplicate retry repairs the gap.
          await SupportEmailWebhookEvent.updateOne(
            { _id: eventRecord._id },
            {
              $set: {
                status: 'failed',
                errorCategory: 'sync_signal_failed',
                error: signalErr.message
              }
            }
          ).catch(() => {});
          throw signalErr;
        }
      }
    }

    // Acknowledge quickly to Microsoft Graph only after every accepted event is durable.
    return res.status(202).json({
      success: true,
      message: 'Notifications accepted'
    });
  } catch (err) {
    incrementMetric('webhook_notifications_rejected', 1, { reason: 'persistence_error' });
    logOperationalEvent('error', 'support_email_webhook_persistence_error', summarizeError(err));
    return res.status(500).json({
      success: false,
      message: 'Notification persistence error; retry requested'
    });
  }
}

module.exports = {
  handleGraphWebhook,
  resourceBelongsToSubscription,
  extractMailboxFromGraphResource
};
