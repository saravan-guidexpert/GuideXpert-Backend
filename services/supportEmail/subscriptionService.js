'use strict';

const crypto = require('crypto');
const GraphSubscription = require('../../models/GraphSubscription');
const { GraphClient } = require('./graphClient');
const { signalMailboxSync } = require('./mailboxSyncService');
const { SUBSCRIPTION_STATUSES } = require('../../constants/supportEmail');

// Microsoft Graph subscription limits:
// For message resources, maximum lifetime is 4230 minutes (~2.93 days).
// Default expiration: 4200 minutes (~2.91 days).
const DEFAULT_EXPIRATION_MINUTES = 4200;
const MIN_EXPIRATION_MARGIN_HOURS = 24;

/**
 * Computes SHA-256 hash of clientState for secure storage and lookup.
 */
function hashClientState(clientState) {
  if (!clientState || typeof clientState !== 'string') return '';
  return crypto.createHash('sha256').update(clientState).digest('hex');
}

/**
 * Generates a cryptographically strong random clientState string.
 */
function generateClientState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time comparison for secrets to prevent timing attacks.
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Formats standard Microsoft Graph mailbox message resource path.
 */
function formatGraphResource(mailbox, folder = 'inbox') {
  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();
  return `users/${encodeURIComponent(normMailbox)}/mailFolders('${encodeURIComponent(normFolder)}')/messages`;
}

/**
 * Subscription Lifecycle Service for Microsoft Graph
 */
class SubscriptionService {
  constructor(config = {}) {
    this.graphClient = config.graphClient || new GraphClient();
    this.defaultNotificationUrl =
      config.notificationUrl ||
      process.env.MS_GRAPH_WEBHOOK_URL ||
      '';
    this.defaultLifecycleUrl =
      config.lifecycleUrl ||
      process.env.MS_GRAPH_LIFECYCLE_URL ||
      this.defaultNotificationUrl;
  }

  /**
   * Creates a new Microsoft Graph subscription for a mailbox folder.
   *
   * @param {Object} params
   * @param {string} params.mailbox Target mailbox address
   * @param {string} [params.folder='inbox'] Mailbox folder
   * @param {string} [params.notificationUrl] Public webhook URL
   * @param {string} [params.lifecycleUrl] Public lifecycle notification URL
   * @param {string} [params.clientState] Optional pre-configured secret; auto-generated if omitted
   * @param {string} [params.changeType='created,updated'] Graph change types
   * @param {number} [params.expirationMinutes=4200] Subscription duration in minutes
   * @param {boolean} [params.force=false] Force creation even if active subscription exists
   * @returns {Promise<Object>} Subscription outcome
   */
  async createSubscription({
    mailbox,
    folder = 'inbox',
    notificationUrl,
    lifecycleUrl,
    clientState,
    changeType = 'created,updated',
    expirationMinutes = DEFAULT_EXPIRATION_MINUTES,
    force = false
  }) {
    if (!mailbox) {
      throw new Error('[SubscriptionService] mailbox is required to create subscription');
    }

    const normMailbox = mailbox.trim().toLowerCase();
    const normFolder = folder.trim().toLowerCase();
    const targetUrl = notificationUrl || this.defaultNotificationUrl;

    if (!targetUrl) {
      throw new Error('[SubscriptionService] notificationUrl is required (set MS_GRAPH_WEBHOOK_URL or pass notificationUrl)');
    }

    const targetLifecycleUrl = lifecycleUrl || this.defaultLifecycleUrl || targetUrl;
    const now = new Date();

    // 1. Concurrency & Duplicate Prevention: Check for existing active subscription
    if (!force) {
      const existing = await GraphSubscription.findOne({
        mailbox: normMailbox,
        folder: normFolder,
        status: 'active',
        expirationDateTime: { $gt: now }
      }).lean();

      if (existing) {
        return {
          created: false,
          isExisting: true,
          subscription: existing
        };
      }
    }

    // 2. Prepare payload
    const effectiveClientState = clientState || generateClientState();
    const clientStateHash = hashClientState(effectiveClientState);
    const expirationDateTime = new Date(now.getTime() + Math.min(expirationMinutes, 4230) * 60 * 1000);
    const resource = formatGraphResource(normMailbox, normFolder);

    const payload = {
      changeType,
      notificationUrl: targetUrl,
      lifecycleNotificationUrl: targetLifecycleUrl,
      resource,
      expirationDateTime: expirationDateTime.toISOString(),
      clientState: effectiveClientState
    };

    // 3. Invoke Microsoft Graph POST /subscriptions
    const response = await this.graphClient.request({
      url: '/subscriptions',
      method: 'POST',
      data: payload
    });

    if (!response || !response.id) {
      throw new Error('[SubscriptionService] Malformed Graph response for subscription creation (missing id)');
    }

    const subscriptionId = response.id;
    const actualExpiration = response.expirationDateTime ? new Date(response.expirationDateTime) : expirationDateTime;

    // 4. Persist subscription metadata
    // Mark any previous active subscriptions for this mailbox as expired
    await GraphSubscription.updateMany(
      {
        mailbox: normMailbox,
        folder: normFolder,
        subscriptionId: { $ne: subscriptionId },
        status: 'active'
      },
      {
        $set: { status: 'expired' }
      }
    );

    const doc = await GraphSubscription.findOneAndUpdate(
      { subscriptionId },
      {
        $set: {
          subscriptionId,
          mailbox: normMailbox,
          folder: normFolder,
          resource,
          expirationDateTime: actualExpiration,
          clientStateHash,
          clientState: effectiveClientState,
          status: 'active',
          notificationUrl: targetUrl,
          lifecycleUrl: targetLifecycleUrl,
          lastRenewedAt: now,
          lastError: null
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return {
      created: true,
      isExisting: false,
      subscription: doc,
      clientState: effectiveClientState
    };
  }

  /**
   * Renews an existing Microsoft Graph subscription before expiration.
   *
   * @param {Object} params
   * @param {string} params.subscriptionId
   * @param {number} [params.expirationMinutes=4200]
   * @returns {Promise<Object>} Renewal outcome
   */
  async renewSubscription({
    subscriptionId,
    expirationMinutes = DEFAULT_EXPIRATION_MINUTES
  }) {
    if (!subscriptionId) {
      throw new Error('[SubscriptionService] subscriptionId is required to renew subscription');
    }

    const now = new Date();
    const newExpiration = new Date(now.getTime() + Math.min(expirationMinutes, 4230) * 60 * 1000);

    try {
      const response = await this.graphClient.request({
        url: `/subscriptions/${subscriptionId}`,
        method: 'PATCH',
        data: {
          expirationDateTime: newExpiration.toISOString()
        }
      });

      const actualExpiration = response?.expirationDateTime
        ? new Date(response.expirationDateTime)
        : newExpiration;

      const updated = await GraphSubscription.findOneAndUpdate(
        { subscriptionId },
        {
          $set: {
            expirationDateTime: actualExpiration,
            lastRenewedAt: now,
            status: 'active',
            lastError: null
          }
        },
        { new: true }
      ).lean();

      return {
        renewed: true,
        subscription: updated
      };
    } catch (err) {
      // If Graph returns 404 Not Found, the subscription expired or was deleted in Exchange
      const isNotFound = err.statusCode === 404 || err.response?.status === 404;
      await GraphSubscription.updateOne(
        { subscriptionId },
        {
          $set: {
            status: isNotFound ? 'expired' : 'failed',
            lastError: err.message
          }
        }
      );

      throw err;
    }
  }

  /**
   * Deletes a Microsoft Graph subscription.
   *
   * @param {Object} params
   * @param {string} params.subscriptionId
   * @returns {Promise<Object>} Deletion outcome
   */
  async deleteSubscription({ subscriptionId }) {
    if (!subscriptionId) {
      throw new Error('[SubscriptionService] subscriptionId is required to delete subscription');
    }

    try {
      await this.graphClient.request({
        url: `/subscriptions/${subscriptionId}`,
        method: 'DELETE'
      });
    } catch (err) {
      // If already deleted in Graph (404), continue cleanly
      if (err.statusCode !== 404 && err.response?.status !== 404) {
        await GraphSubscription.updateOne(
          { subscriptionId },
          { $set: { lastError: err.message } }
        );
        throw err;
      }
    }

    const updated = await GraphSubscription.findOneAndUpdate(
      { subscriptionId },
      {
        $set: {
          status: 'deleted',
          lastError: null
        }
      },
      { new: true }
    ).lean();

    return {
      deleted: true,
      subscription: updated
    };
  }

  /**
   * Audits and repairs subscription health for a mailbox.
   * If subscription is missing, expired, or expiring within safety margin, renews or re-creates it.
   *
   * @param {Object} params
   * @param {string} params.mailbox
   * @param {string} [params.folder='inbox']
   * @param {number} [params.safetyMarginHours=24]
   * @param {string} [params.notificationUrl]
   * @param {string} [params.lifecycleUrl]
   * @returns {Promise<Object>} Health check outcome
   */
  async syncSubscriptionHealth({
    mailbox,
    folder = 'inbox',
    safetyMarginHours = MIN_EXPIRATION_MARGIN_HOURS,
    notificationUrl,
    lifecycleUrl
  }) {
    if (!mailbox) {
      throw new Error('[SubscriptionService] mailbox is required for subscription health check');
    }

    const normMailbox = mailbox.trim().toLowerCase();
    const normFolder = folder.trim().toLowerCase();
    const now = new Date();
    const safetyMarginMs = safetyMarginHours * 60 * 60 * 1000;

    const currentSub = await GraphSubscription.findOne({
      mailbox: normMailbox,
      folder: normFolder,
      status: 'active'
    }).sort({ expirationDateTime: -1 }).lean();

    // 1. Missing subscription: Create new
    if (!currentSub) {
      return this.createSubscription({
        mailbox: normMailbox,
        folder: normFolder,
        notificationUrl,
        lifecycleUrl
      });
    }

    const expiresAtMs = new Date(currentSub.expirationDateTime).getTime();
    const timeRemainingMs = expiresAtMs - now.getTime();

    // 2. Already expired: Mark expired and create fresh subscription
    if (timeRemainingMs <= 0) {
      await GraphSubscription.updateOne(
        { _id: currentSub._id },
        { $set: { status: 'expired' } }
      );

      return this.createSubscription({
        mailbox: normMailbox,
        folder: normFolder,
        notificationUrl: notificationUrl || currentSub.notificationUrl,
        lifecycleUrl: lifecycleUrl || currentSub.lifecycleUrl,
        force: true
      });
    }

    // 3. Expiring within safety margin: Renew
    if (timeRemainingMs < safetyMarginMs) {
      try {
        const renewResult = await this.renewSubscription({
          subscriptionId: currentSub.subscriptionId
        });
        return {
          renewed: true,
          subscription: renewResult.subscription
        };
      } catch (err) {
        // If renewal failed because Graph purged the subscription (404), create a fresh one
        if (err.statusCode === 404 || err.response?.status === 404) {
          return this.createSubscription({
            mailbox: normMailbox,
            folder: normFolder,
            notificationUrl: notificationUrl || currentSub.notificationUrl,
            lifecycleUrl: lifecycleUrl || currentSub.lifecycleUrl,
            force: true
          });
        }
        throw err;
      }
    }

    // 4. Healthy and active
    return {
      healthy: true,
      renewed: false,
      subscription: currentSub,
      hoursRemaining: Math.round(timeRemainingMs / (3600 * 1000))
    };
  }

  /**
   * Handles Microsoft Graph lifecycle notifications.
   *
   * @param {Object} notification Lifecycle notification item
   * @returns {Promise<Object>} Outcome
   */
  async handleLifecycleNotification(notification = {}) {
    const { subscriptionId, lifecycleEvent } = notification;

    if (!subscriptionId) {
      return { handled: false, reason: 'missing_subscription_id' };
    }

    const sub = await GraphSubscription.findOne({ subscriptionId }).lean();
    if (!sub) {
      return { handled: false, reason: 'unknown_subscription' };
    }

    const mailbox = sub.mailbox;
    const folder = sub.folder || 'inbox';

    switch (lifecycleEvent) {
      case 'missed':
        // Graph missed sending one or more notifications -> Wake up delta sync engine!
        await signalMailboxSync({ mailbox, folder });
        return {
          handled: true,
          action: 'signaled_delta_sync',
          event: 'missed'
        };

      case 'subscriptionRemoved':
        // Graph removed subscription -> Mark deleted and schedule recovery
        await GraphSubscription.updateOne(
          { subscriptionId },
          { $set: { status: 'deleted', lastError: 'Removed by Graph lifecycle event' } }
        );
        return {
          handled: true,
          action: 'marked_deleted',
          event: 'subscriptionRemoved'
        };

      case 'reauthorizationRequired':
        // Tenant consent / permissions changed
        await GraphSubscription.updateOne(
          { subscriptionId },
          { $set: { lastError: 'Reauthorization required by Microsoft 365 tenant' } }
        );
        return {
          handled: true,
          action: 'flagged_reauth_required',
          event: 'reauthorizationRequired'
        };

      default:
        return {
          handled: false,
          reason: `unhandled_lifecycle_event: ${lifecycleEvent}`
        };
    }
  }
}

module.exports = {
  SubscriptionService,
  DEFAULT_EXPIRATION_MINUTES,
  MIN_EXPIRATION_MARGIN_HOURS,
  hashClientState,
  generateClientState,
  timingSafeCompare,
  formatGraphResource
};

