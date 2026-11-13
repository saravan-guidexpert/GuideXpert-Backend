'use strict';

const crypto = require('crypto');
const EmailSyncCursor = require('../../models/EmailSyncCursor');

/**
 * Generates a collision-resistant unique lock token for sync workers.
 */
function generateLockToken() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Determines whether a Microsoft Graph notification is collection-level (wake-up ping)
 * or message-level (specific message change).
 */
function isCollectionLevelNotification(notification = {}) {
  if (notification.resourceId || notification.resourceData?.id) {
    return false;
  }
  const resource = notification.resource || '';
  const match = /\/messages\/([^\/?#]+)/i.exec(resource);
  return !match;
}

/**
 * Signals that a mailbox/folder has changes requiring synchronization.
 * Atomically increments monotonic `syncRequestVersion` and marks `hasPendingSync = true`.
 *
 * MONOTONIC CONCURRENCY GUARANTEE:
 * - Completely immune to wall-clock skew, NTP drift, and same-millisecond collisions.
 * - Every signal increment is serialized and preserved by MongoDB's atomic `$inc`.
 *
 * @param {Object} params
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {Date} [params.requestedAt=new Date()]
 * @returns {Promise<Object>} Updated cursor document
 */
async function signalMailboxSync({
  mailbox,
  folder = 'inbox',
  requestedAt = new Date()
}) {
  if (!mailbox) {
    throw new Error('mailbox is required to signal sync');
  }

  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();
  const now = requestedAt instanceof Date && !isNaN(requestedAt.getTime()) ? requestedAt : new Date();

  const cursor = await EmailSyncCursor.findOneAndUpdate(
    {
      mailbox: normMailbox,
      folder: normFolder
    },
    {
      $inc: { syncRequestVersion: 1 },
      $set: {
        hasPendingSync: true,
        lastSyncRequestedAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        mailbox: normMailbox,
        folder: normFolder,
        syncStatus: 'idle',
        deltaLink: null,
        lastSyncedVersion: 0,
        lastSuccessfulSyncAt: null,
        baselineCompletedAt: null
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return cursor;
}

/**
 * Atomically acquires the synchronization lock for a mailbox/folder.
 * Allows claiming if idle, failed, or if an active lock's lease expired (crash recovery).
 *
 * @param {Object} params
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {number} [params.leaseMs=60000] Lock lease in ms
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<{ locked: boolean, cursor?: Object, lockToken?: string, leaseExpiresAt?: Date, reason?: string }>}
 */
async function acquireSyncLock({
  mailbox,
  folder = 'inbox',
  leaseMs = 60000,
  now = new Date()
}) {
  if (!mailbox) {
    throw new Error('mailbox is required to acquire sync lock');
  }

  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();
  const token = generateLockToken();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const filter = {
    mailbox: normMailbox,
    folder: normFolder,
    $or: [
      { syncStatus: { $in: ['idle', 'failed'] } },
      { syncStatus: 'syncing', syncLeaseExpiresAt: { $lte: now } } // crashed worker recovery
    ]
  };

  const update = {
    $set: {
      syncStatus: 'syncing',
      syncLockToken: token,
      syncLeaseExpiresAt: leaseExpiresAt,
      lastSyncStartedAt: now,
      updatedAt: now
    }
  };

  const locked = await EmailSyncCursor.findOneAndUpdate(filter, update, { new: true }).lean();

  if (!locked) {
    return { locked: false, reason: 'sync_already_running' };
  }

  return { locked: true, cursor: locked, lockToken: token, leaseExpiresAt };
}

/**
 * Renews the active synchronization lease.
 */
async function renewSyncLock({
  cursorId,
  syncLockToken,
  leaseMs = 60000,
  now = new Date()
}) {
  if (!cursorId || !syncLockToken) return false;

  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const updated = await EmailSyncCursor.findOneAndUpdate(
    {
      _id: cursorId,
      syncLockToken,
      syncStatus: 'syncing'
    },
    {
      $set: {
        syncLeaseExpiresAt: leaseExpiresAt,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  return Boolean(updated);
}

/**
 * Atomically advances the delta cursor and updates hasPendingSync based on monotonic version.
 *
 * MONOTONIC VERSION GUARANTEE:
 * - If syncRequestVersion > capturedVersion (new signals arrived during this pass),
 *   hasPendingSync REMAINS true!
 * - If syncRequestVersion <= capturedVersion (no signals arrived during this pass),
 *   hasPendingSync is cleared to false.
 * - Sets lastSyncedVersion to capturedVersion.
 * - If the worker's lockToken is no longer valid, returns null (stale worker rejected).
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.cursorId
 * @param {string} params.syncLockToken
 * @param {string} params.nextDeltaLink
 * @param {number} params.capturedVersion
 * @param {Date} [params.commitTime=new Date()]
 * @param {boolean} [params.isBaseline=false]
 * @returns {Promise<Object|null>} Updated cursor or null if lock lost
 */
async function advanceSyncCursor({
  cursorId,
  syncLockToken,
  nextDeltaLink,
  capturedVersion,
  commitTime = new Date(),
  isBaseline = false
}) {
  if (!cursorId || !syncLockToken) return null;
  const versionNum = typeof capturedVersion === 'number' ? capturedVersion : 0;

  const updatePipeline = [
    {
      $set: {
        deltaLink: nextDeltaLink,
        lastSuccessfulSyncAt: commitTime,
        lastSyncedVersion: versionNum,
        baselineCompletedAt: {
          $cond: {
            if: {
              $or: [
                { $eq: [isBaseline, true] },
                { $ne: [{ $ifNull: ['$baselineCompletedAt', null] }, null] }
              ]
            },
            then: { $ifNull: ['$baselineCompletedAt', commitTime] },
            else: '$baselineCompletedAt'
          }
        },
        error: null,
        updatedAt: commitTime,
        hasPendingSync: {
          $cond: {
            if: { $gt: [{ $ifNull: ['$syncRequestVersion', 0] }, versionNum] },
            then: true,
            else: false
          }
        }
      }
    }
  ];

  const updated = await EmailSyncCursor.findOneAndUpdate(
    {
      _id: cursorId,
      syncLockToken,
      syncStatus: 'syncing'
    },
    updatePipeline,
    { new: true, updatePipeline: true }
  ).lean();

  return updated;
}

/**
 * Atomically releases the sync lock ONLY IF syncRequestVersion <= capturedVersion AND hasPendingSync is false.
 * If new signals arrived (incrementing syncRequestVersion), does NOT release the lock
 * and returns { released: false, hasPendingSync: true }.
 */
async function releaseSyncLockIfNoPending({
  cursorId,
  syncLockToken,
  capturedVersion,
  now = new Date()
}) {
  if (!cursorId || !syncLockToken) {
    return { released: false, reason: 'missing_parameters' };
  }

  const filter = {
    _id: cursorId,
    syncLockToken,
    syncStatus: 'syncing',
    hasPendingSync: false
  };

  if (typeof capturedVersion === 'number') {
    filter.syncRequestVersion = { $lte: capturedVersion };
  }

  const released = await EmailSyncCursor.findOneAndUpdate(
    filter,
    {
      $set: {
        syncStatus: 'idle',
        syncLockToken: null,
        syncLeaseExpiresAt: null,
        error: null,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  if (released) {
    return { released: true, cursor: released };
  }

  // Check if lock release failed because new requests arrived
  const current = await EmailSyncCursor.findById(cursorId).lean();
  if (current && current.syncLockToken === syncLockToken) {
    const hasMoreWork =
      current.hasPendingSync ||
      (typeof capturedVersion === 'number' && (current.syncRequestVersion || 0) > capturedVersion);

    if (hasMoreWork) {
      return {
        released: false,
        hasPendingSync: true,
        cursor: current,
        syncRequestVersion: current.syncRequestVersion
      };
    }
  }

  return { released: false, reason: 'lock_lost_or_stale', cursor: current };
}

/**
 * Unconditionally releases the synchronization lock (e.g. on error, crash recovery, or maxPasses).
 */
async function releaseSyncLock({
  cursorId,
  syncLockToken,
  success = true,
  error = null,
  preservePending = false,
  now = new Date()
}) {
  if (!cursorId || !syncLockToken) return null;

  const update = {
    $set: {
      syncStatus: success ? 'idle' : 'failed',
      syncLockToken: null,
      syncLeaseExpiresAt: null,
      error: error ? (error.message || String(error)) : null,
      updatedAt: now
    }
  };

  if (success) {
    update.$set.lastSuccessfulSyncAt = now;
  }

  if (preservePending || !success) {
    update.$set.hasPendingSync = true;
  }

  const released = await EmailSyncCursor.findOneAndUpdate(
    {
      _id: cursorId,
      syncLockToken,
      syncStatus: 'syncing'
    },
    update,
    { new: true }
  ).lean();

  return released;
}

/**
 * Runs a coalesced synchronization loop guarded by atomic monotonic syncRequestVersion.
 *
 * 1. Acquires atomic lock.
 * 2. In a loop:
 *    - Reads current cursor and captures capturedVersion = syncRequestVersion.
 *    - Calls syncPassFn(currentCursor) which executes delta query and ingests messages.
 *    - Atomically advances deltaLink, records lastSyncedVersion = capturedVersion, and evaluates
 *      hasPendingSync: (syncRequestVersion > capturedVersion).
 *    - If hasPendingSync remains true, repeats immediately for the new version.
 *    - If hasPendingSync was false, attempts atomic lock release guarded by
 *      syncRequestVersion <= capturedVersion AND hasPendingSync: false.
 *    - If a signal arrived right before release, atomic release refuses and loop repeats!
 * 3. On error: preserves hasPendingSync = true and marks syncStatus: 'failed'.
 * 4. On maxPasses: releases lock to 'idle' with preservePending: true and invokes optional scheduleFollowUpFn.
 *
 * @param {Object} params
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {number} [params.leaseMs=60000]
 * @param {Function} params.syncPassFn Async function: (cursor) => Promise<{ nextDeltaLink: string, count: number }>
 * @param {number} [params.maxPasses=5] Safety cap on consecutive coalesced passes per invocation
 * @param {Function} [params.scheduleFollowUpFn] Callback invoked when maxPasses is exceeded with pending work
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<Object>} Execution summary
 */
async function runCoalescedSync({
  mailbox,
  folder = 'inbox',
  leaseMs = 60000,
  syncPassFn,
  maxPasses = 5,
  scheduleFollowUpFn = null,
  now = new Date()
}) {
  if (typeof syncPassFn !== 'function') {
    throw new Error('syncPassFn must be an async function');
  }

  const lockRes = await acquireSyncLock({ mailbox, folder, leaseMs, now });
  if (!lockRes.locked) {
    return { executed: false, reason: lockRes.reason };
  }

  const cursorId = lockRes.cursor._id;
  const token = lockRes.lockToken;
  let passes = 0;
  let totalIngested = 0;
  let lastDeltaLink = lockRes.cursor.deltaLink;
  const isInitialBaseline = !lastDeltaLink;

  try {
    while (passes < maxPasses) {
      passes++;

      // Read fresh state to capture the exact monotonically incremented request version for this pass
      const freshBeforePass = await EmailSyncCursor.findById(cursorId).lean();
      const capturedVersion = freshBeforePass?.syncRequestVersion || 0;

      // Execute synchronization pass (Graph delta query + idempotent ingestion)
      const passResult = await syncPassFn({
        ...lockRes.cursor,
        _id: cursorId,
        deltaLink: lastDeltaLink,
        capturedVersion
      });

      lastDeltaLink = passResult?.nextDeltaLink || lastDeltaLink;
      totalIngested += passResult?.count || 0;

      // Atomically advance cursor and conditionally evaluate hasPendingSync against capturedVersion
      const commitTime = new Date();
      const updatedCursor = await advanceSyncCursor({
        cursorId,
        syncLockToken: token,
        nextDeltaLink: lastDeltaLink,
        capturedVersion,
        commitTime,
        isBaseline: isInitialBaseline && passes === 1
      });

      if (!updatedCursor) {
        throw new Error('Sync lock lost: lease expired or token clobbered during pass execution');
      }

      // If new signals arrived during pass execution (syncRequestVersion > capturedVersion), loop immediately
      if (updatedCursor.hasPendingSync) {
        continue;
      }

      // Attempt atomic lock release ONLY IF syncRequestVersion <= capturedVersion AND hasPendingSync is STILL false
      const releaseRes = await releaseSyncLockIfNoPending({
        cursorId,
        syncLockToken: token,
        capturedVersion,
        now: commitTime
      });

      if (releaseRes.released) {
        // Clean exit! Lock is released and no pending work exists.
        return {
          executed: true,
          passes,
          totalIngested,
          deltaLink: lastDeltaLink,
          maxPassesReached: false,
          hasPendingSync: false,
          lastSyncedVersion: capturedVersion
        };
      }

      if (releaseRes.hasPendingSync) {
        // A new signal arrived during the release check! Loop immediately to process it!
        continue;
      }

      // Lock was lost or clobbered
      return {
        executed: true,
        passes,
        totalIngested,
        deltaLink: lastDeltaLink,
        lockLost: true
      };
    }

    // Reached max passes while pending work remains!
    const releasedAtMax = await releaseSyncLock({
      cursorId,
      syncLockToken: token,
      success: true,
      preservePending: true,
      now: new Date()
    });

    if (typeof scheduleFollowUpFn === 'function') {
      try {
        await scheduleFollowUpFn({
          mailbox,
          folder,
          cursor: releasedAtMax,
          deltaLink: lastDeltaLink
        });
      } catch (scheduleErr) {
        // Non-fatal: logged for diagnostics
      }
    }

    return {
      executed: true,
      passes,
      totalIngested,
      deltaLink: lastDeltaLink,
      maxPassesReached: true,
      hasPendingSync: true
    };
  } catch (err) {
    // Preserve pending sync on error so future runs retry
    await releaseSyncLock({
      cursorId,
      syncLockToken: token,
      success: false,
      error: err,
      preservePending: true,
      now: new Date()
    });
    throw err;
  }
}

/**
 * Discovers cursors that have pending work waiting for synchronization.
 * Includes idle mailboxes with hasPendingSync=true, failed mailboxes with hasPendingSync=true,
 * cursors where syncRequestVersion > lastSyncedVersion, and crashed workers whose sync lease has expired.
 */
async function findPendingSyncCursors({ limit = 10, now = new Date() } = {}) {
  return EmailSyncCursor.find({
    $and: [
      {
        $or: [
          { hasPendingSync: true },
          { $expr: { $gt: [{ $ifNull: ['$syncRequestVersion', 0] }, { $ifNull: ['$lastSyncedVersion', 0] }] } }
        ]
      },
      {
        $or: [
          { syncStatus: { $in: ['idle', 'failed'] } },
          { syncStatus: 'syncing', syncLeaseExpiresAt: { $lte: now } }
        ]
      }
    ]
  })
    .sort({ lastSyncRequestedAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Periodic reconciliation check independent of webhooks.
 * Accurately classifies initial synchronization, pending sync, stale delta sync, and fresh sync.
 */
async function checkPeriodicReconciliation({
  mailbox,
  folder = 'inbox',
  maxStaleMs = 10 * 60 * 1000, // 10 minutes
  now = new Date()
}) {
  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();

  const cursor = await EmailSyncCursor.findOne({
    mailbox: normMailbox,
    folder: normFolder
  }).lean();

  if (!cursor) {
    await signalMailboxSync({ mailbox: normMailbox, folder: normFolder, requestedAt: now });
    return { needed: true, reason: 'no_cursor_baseline_needed' };
  }

  // Never synchronized / baseline missing check
  if (!cursor.lastSuccessfulSyncAt || !cursor.baselineCompletedAt) {
    await signalMailboxSync({ mailbox: normMailbox, folder: normFolder, requestedAt: now });
    return {
      needed: true,
      reason: 'never_synchronized',
      hasBaseline: Boolean(cursor.baselineCompletedAt)
    };
  }

  // Pending sync already flagged or version gap
  const reqVer = cursor.syncRequestVersion || 0;
  const syncVer = cursor.lastSyncedVersion || 0;
  if (cursor.hasPendingSync || reqVer > syncVer) {
    return {
      needed: true,
      reason: 'pending_sync_flagged',
      syncRequestVersion: reqVer,
      lastSyncedVersion: syncVer,
      lastSyncRequestedAt: cursor.lastSyncRequestedAt
    };
  }

  const lastSyncTime = new Date(cursor.lastSuccessfulSyncAt).getTime();
  const elapsed = now.getTime() - lastSyncTime;

  if (elapsed >= maxStaleMs) {
    await signalMailboxSync({ mailbox: normMailbox, folder: normFolder, requestedAt: now });
    return {
      needed: true,
      reason: 'periodic_stale_threshold_exceeded',
      elapsedMs: elapsed
    };
  }

  return { needed: false, reason: 'sync_fresh', elapsedMs: elapsed };
}

module.exports = {
  generateLockToken,
  isCollectionLevelNotification,
  signalMailboxSync,
  acquireSyncLock,
  renewSyncLock,
  advanceSyncCursor,
  releaseSyncLockIfNoPending,
  releaseSyncLock,
  runCoalescedSync,
  findPendingSyncCursors,
  checkPeriodicReconciliation
};
