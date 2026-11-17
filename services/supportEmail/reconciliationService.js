'use strict';

const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const EmailSyncCursor = require('../../models/EmailSyncCursor');
const SupportEmailWebhookEvent = require('../../models/SupportEmailWebhookEvent');
const { SubscriptionService } = require('./subscriptionService');
const { runCoalescedSync, acquireSyncLock, signalMailboxSync } = require('./mailboxSyncService');
const { createSyncPassFn } = require('./deltaSyncService');
const { GraphClient } = require('./graphClient');
const { logOperationalEvent, incrementMetric, summarizeError } = require('./observability');

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

  incrementMetric('reconciliation_mailbox_started', 1);
  logOperationalEvent('info', 'support_email_reconciliation_started', {
    mailbox: normMailbox,
    folder: normFolder
  });

  // 1. Verify policy is enabled
  const policy = await EmailIngestionPolicy.findOne({
    mailbox: normMailbox,
    enabled: true
  }).lean();

  if (!policy) {
    logOperationalEvent('info', 'support_email_reconciliation_skipped', {
      mailbox: normMailbox,
      folder: normFolder,
      reason: 'policy_disabled_or_missing'
    });
    return {
      mailbox: normMailbox,
      folder: normFolder,
      skipped: true,
      reason: 'policy_disabled_or_missing'
    };
  }

  // 2. Subscription Health Check & Remote Orphan Reconciliation
  let subHealth = null;
  try {
    subHealth = await subscriptionSvc.syncSubscriptionHealth({
      mailbox: normMailbox,
      folder: normFolder
    });
    // Scheduled remote orphan discovery & cleanup pass
    const orphanRecon = await subscriptionSvc.reconcileRemoteSubscriptions({
      mailbox: normMailbox,
      folder: normFolder,
      deleteOrphans: true
    }).catch((orphanErr) => {
      logOperationalEvent('warn', 'support_email_orphan_reconciliation_failed', {
        mailbox: normMailbox,
        folder: normFolder,
        ...summarizeError(orphanErr)
      });
      return { error: summarizeError(orphanErr).errorMessage };
    });

    if (orphanRecon && Array.isArray(orphanRecon.failedDeletions) && orphanRecon.failedDeletions.length > 0) {
      logOperationalEvent('warn', 'support_email_orphan_deletion_partial_failure', {
        mailbox: normMailbox,
        folder: normFolder,
        failedCount: orphanRecon.failedDeletions.length,
        failures: orphanRecon.failedDeletions.map((f) => ({
          subscriptionId: f.id,
          errorMessage: f.error
        }))
      });
    }

    if (subHealth && typeof subHealth === 'object') {
      subHealth.orphanReconciliation = orphanRecon;
    }

    if (orphanRecon && typeof orphanRecon === 'object' && !orphanRecon.error) {
      if (orphanRecon.remoteOrphansCount > 0 || orphanRecon.deletedRemoteCount > 0) {
        incrementMetric('reconciliation_remote_orphans_detected', orphanRecon.remoteOrphansCount || 0);
        incrementMetric('reconciliation_remote_orphans_deleted', orphanRecon.deletedRemoteCount || 0);
        logOperationalEvent('warn', 'support_email_orphan_reconciliation', {
          mailbox: normMailbox,
          folder: normFolder,
          remoteOrphans: orphanRecon.remoteOrphansCount || 0,
          deletedRemote: orphanRecon.deletedRemoteCount || 0,
          inFlightRemote: orphanRecon.inFlightRemoteCount || 0,
          enumerationComplete: orphanRecon.completedEnumeration !== false
        });
      }
    }
  } catch (subErr) {
    // If Graph subscription fails, record error but proceed to delta catchup
    subHealth = { error: subErr.message };
    incrementMetric('reconciliation_subscription_failure', 1);
    logOperationalEvent('error', 'support_email_subscription_health_failure', {
      mailbox: normMailbox,
      folder: normFolder,
      errorName: subErr.name,
      errorCode: subErr.code || subErr.statusCode || null
    });
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
  }).catch((syncErr) => {
    incrementMetric('reconciliation_delta_sync_failure', 1);
    logOperationalEvent('error', 'support_email_delta_sync_failure', {
      mailbox: normMailbox,
      folder: normFolder,
      errorName: syncErr.name,
      errorCode: syncErr.code || syncErr.statusCode || null
    });
    throw syncErr;
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

  incrementMetric('reconciliation_mailbox_completed', 1);
  logOperationalEvent('info', 'support_email_reconciliation_completed', {
    mailbox: normMailbox,
    folder: normFolder,
    synced: true,
    passes: syncResult?.passes ?? null,
    ingested: syncResult?.totalIngested ?? 0,
    hasPendingSync: syncResult?.hasPendingSync ?? false
  });

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

  logOperationalEvent('info', 'support_email_reconciliation_run_started', {
    policyCount: policies.length,
    batchBudgetMs
  });

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
      incrementMetric('reconciliation_mailbox_failure', 1);
      logOperationalEvent('error', 'support_email_reconciliation_mailbox_failure', {
        mailbox: policy.mailbox,
        errorName: err.name,
        errorCode: err.code || err.statusCode || null
      });
      results.push({
        mailbox: policy.mailbox,
        error: err.message
      });
    }
  }

  const summary = {
    totalPolicies: policies.length,
    processedCount: results.length,
    durationMs: Date.now() - startTime,
    results
  };

  logOperationalEvent('info', 'support_email_reconciliation_run_completed', {
    totalPolicies: summary.totalPolicies,
    processedCount: summary.processedCount,
    durationMs: summary.durationMs
  });

  return summary;
}

module.exports = {
  reconcileMailbox,
  runAllReconciliations,
  RECONCILIATION_INTERVAL_MS
};
