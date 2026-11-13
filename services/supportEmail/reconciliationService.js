'use strict';

const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const EmailSyncCursor = require('../../models/EmailSyncCursor');
const SupportEmailWebhookEvent = require('../../models/SupportEmailWebhookEvent');
const { SubscriptionService } = require('./subscriptionService');
const { runCoalescedSync, acquireSyncLock, signalMailboxSync } = require('./mailboxSyncService');
const { createSyncPassFn } = require('./deltaSyncService');
const { GraphClient } = require('./graphClient');

const defaultSubscriptionService = new SubscriptionService();
const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes default delta catchup

/**
 * Reconciles a single mailbox:
 * 1. Verifies and repairs Microsoft Graph subscription health.
 * 2. Checks whether synchronization is needed (pending sync, stale lease, or periodic catchup).
 * 3. Runs coalesced delta synchronization within bounded time budget.
 * 4. Marks processed webhook events.
 *
 * @param {Object} params
 * @param {string} params.mailbox Mailbox address
 * @param {string} [params.folder='inbox'] Mailbox folder
 * @param {GraphClient} [params.graphClient]
 * @param {SubscriptionService} [params.subscriptionSvc]
 * @param {Object} [params.queueSvc]
 * @param {number} [params.maxPasses=5]
 * @param {number} [params.forceSync=false]
 * @returns {Promise<Object>} Reconciliation summary
 */
async function reconcileMailbox({
  mailbox,
  folder = 'inbox',
  graphClient = new GraphClient(),
  subscriptionSvc = defaultSubscriptionService,
  queueSvc,
  maxPasses = 5,
  forceSync = false
}) {
  if (!mailbox) {
    throw new Error('[ReconciliationService] mailbox is required');
  }

  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();
  const now = new Date();

  // 1. Verify policy is enabled
  const policy = await EmailIngestionPolicy.findOne({
    mailbox: normMailbox,
    enabled: true
  }).lean();

  if (!policy) {
    return {
      mailbox: normMailbox,
      folder: normFolder,
      skipped: true,
      reason: 'policy_disabled_or_missing'
    };
  }

  // 2. Subscription Health Check & Repair
  let subHealth = null;
  try {
    subHealth = await subscriptionSvc.syncSubscriptionHealth({
      mailbox: normMailbox,
      folder: normFolder
    });
  } catch (subErr) {
    // If Graph subscription fails, record error but proceed to delta catchup
    subHealth = { error: subErr.message };
  }

  // 3. Evaluate Sync Need
  let cursor = await EmailSyncCursor.findOne({
    mailbox: normMailbox,
    folder: normFolder
  }).lean();

  let needsSync = forceSync;

  if (!cursor) {
    // No cursor exists yet: create initial cursor via monotonic signal
    cursor = await signalMailboxSync({ mailbox: normMailbox, folder: normFolder, requestedAt: now });
    needsSync = true;
  } else if (!cursor.lastSuccessfulSyncAt || cursor.deltaLink === null) {
    // No baseline or incomplete baseline
    needsSync = true;
  } else if (cursor.hasPendingSync) {
    // Pending sync signaled by webhooks
    needsSync = true;
  } else if (cursor.syncStatus === 'syncing' && cursor.syncLeaseExpiresAt && cursor.syncLeaseExpiresAt <= now) {
    // Crashed worker lease recovery
    needsSync = true;
  } else {
    // Scheduled periodic catchup interval
    const lastSyncTime = new Date(cursor.lastSuccessfulSyncAt).getTime();
    if (now.getTime() - lastSyncTime > RECONCILIATION_INTERVAL_MS) {
      needsSync = true;
    }
  }

  if (!needsSync) {
    return {
      mailbox: normMailbox,
      folder: normFolder,
      synced: false,
      subscription: subHealth,
      reason: 'already_up_to_date'
    };
  }

  // 4. Execute Coalesced Synchronization
  const syncPassFn = createSyncPassFn({
    graphClient,
    mailbox: normMailbox,
    folder: normFolder,
    queueSvc
  });

  const syncResult = await runCoalescedSync({
    mailbox: normMailbox,
    folder: normFolder,
    syncPassFn,
    maxPasses
  });

  // 5. Update Webhook Event Statuses for this Mailbox
  await SupportEmailWebhookEvent.updateMany(
    {
      'metadata.mailbox': normMailbox,
      status: 'received'
    },
    {
      $set: {
        status: 'processed',
        processedAt: new Date()
      }
    }
  );

  return {
    mailbox: normMailbox,
    folder: normFolder,
    synced: true,
    syncResult,
    subscription: subHealth
  };
}

/**
 * Reconciles all active mailboxes defined in EmailIngestionPolicy.
 * Enforces a bounded time budget to fit Vercel serverless execution limits.
 *
 * @param {Object} [options]
 * @param {number} [options.batchBudgetMs=45000] Time budget for execution
 * @param {GraphClient} [options.graphClient]
 * @param {SubscriptionService} [options.subscriptionSvc]
 * @param {Object} [options.queueSvc]
 * @returns {Promise<Object>} Run summary
 */
async function runAllReconciliations({
  batchBudgetMs = 45000,
  graphClient = new GraphClient(),
  subscriptionSvc = defaultSubscriptionService,
  queueSvc
} = {}) {
  const startTime = Date.now();
  const policies = await EmailIngestionPolicy.find({ enabled: true }).lean();
  const results = [];

  for (const policy of policies) {
    if (Date.now() - startTime > batchBudgetMs) {
      // Exceeded budget; break cleanly to avoid Vercel timeout
      break;
    }

    try {
      const outcome = await reconcileMailbox({
        mailbox: policy.mailbox,
        folder: 'inbox',
        graphClient,
        subscriptionSvc,
        queueSvc
      });
      results.push(outcome);
    } catch (err) {
      results.push({
        mailbox: policy.mailbox,
        error: err.message
      });
    }
  }

  return {
    totalPolicies: policies.length,
    processedCount: results.length,
    durationMs: Date.now() - startTime,
    results
  };
}

module.exports = {
  reconcileMailbox,
  runAllReconciliations,
  RECONCILIATION_INTERVAL_MS
};
