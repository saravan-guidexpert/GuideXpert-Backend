'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupTestDb,
  clearTestDb,
  teardownTestDb
} = require('./supportEmail/harness');

const EmailSyncCursor = require('../models/EmailSyncCursor');
const SupportEmail = require('../models/SupportEmail');
const {
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
} = require('../services/supportEmail/mailboxSyncService');

test.before(async () => {
  await setupTestDb();
});

test.after(async () => {
  await teardownTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
});

test('mailboxSyncService: isCollectionLevelNotification identifies collection vs message notifications', () => {
  assert.equal(
    isCollectionLevelNotification({ resource: "Users('support@guidexpert.com')/mailFolders('inbox')/messages" }),
    true
  );
  assert.equal(
    isCollectionLevelNotification({ resource: 'me/mailFolders/inbox/messages' }),
    true
  );
  assert.equal(
    isCollectionLevelNotification({
      resource: "Users('support@guidexpert.com')/mailFolders('inbox')/messages",
      resourceData: { id: 'AAMkAGVmMz...=' }
    }),
    false
  );
  assert.equal(
    isCollectionLevelNotification({
      resource: "Users('support@guidexpert.com')/mailFolders('inbox')/messages",
      resourceId: 'AAMkAGVmMz...='
    }),
    false
  );
  assert.equal(
    isCollectionLevelNotification({
      resource: 'Users/support@guidexpert.com/messages/AAMkAGVmMz...='
    }),
    false
  );
});

test('mailboxSyncService: multiple collection-level notifications coalesce and increment syncRequestVersion atomically', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  for (let i = 0; i < 10; i++) {
    const cursor = await signalMailboxSync({ mailbox, folder });
    assert.equal(cursor.hasPendingSync, true);
    assert.equal(cursor.syncRequestVersion, i + 1, 'Version must increment monotonically by 1 per signal');
  }

  const count = await EmailSyncCursor.countDocuments({ mailbox, folder });
  assert.equal(count, 1);

  const finalCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(finalCursor.hasPendingSync, true);
  assert.equal(finalCursor.syncRequestVersion, 10);
  assert.equal(finalCursor.lastSyncedVersion, 0);
  assert.equal(finalCursor.syncStatus, 'idle');
});

test('mailboxSyncService: atomic lock prevents concurrent workers from running simultaneous syncs', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });

  // Worker 1 acquires lock
  const worker1 = await acquireSyncLock({ mailbox, folder, leaseMs: 30000 });
  assert.equal(worker1.locked, true);
  assert.ok(worker1.lockToken);

  // Worker 2 attempts to acquire lock concurrently
  const worker2 = await acquireSyncLock({ mailbox, folder, leaseMs: 30000 });
  assert.equal(worker2.locked, false);
  assert.equal(worker2.reason, 'sync_already_running');

  // Worker 1 renews lease
  const renewed = await renewSyncLock({
    cursorId: worker1.cursor._id,
    syncLockToken: worker1.lockToken,
    leaseMs: 60000
  });
  assert.equal(renewed, true);

  // Worker 2 cannot renew with an invalid token
  const invalidRenew = await renewSyncLock({
    cursorId: worker1.cursor._id,
    syncLockToken: 'invalid-token',
    leaseMs: 60000
  });
  assert.equal(invalidRenew, false);

  // Worker 1 releases lock
  const released = await releaseSyncLock({
    cursorId: worker1.cursor._id,
    syncLockToken: worker1.lockToken,
    success: true
  });
  assert.equal(released.syncStatus, 'idle');
  assert.equal(released.syncLockToken, null);

  // Worker 2 can now acquire lock
  const worker2Retry = await acquireSyncLock({ mailbox, folder, leaseMs: 30000 });
  assert.equal(worker2Retry.locked, true);
  await releaseSyncLock({
    cursorId: worker2Retry.cursor._id,
    syncLockToken: worker2Retry.lockToken,
    success: true
  });
});

test('mailboxSyncService: concurrent signals from multiple webhook requests serialize atomically via MongoDB $inc', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  // Fire 25 concurrent webhook signals in parallel
  const signals = Array.from({ length: 25 }, () => signalMailboxSync({ mailbox, folder }));
  await Promise.all(signals);

  const cursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(cursor.syncRequestVersion, 25, 'Every concurrent signal must be counted exactly once without loss');
  assert.equal(cursor.hasPendingSync, true);
});

test('mailboxSyncService: signal and pass start in the same millisecond are detected deterministically via version', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  // Fixed identical millisecond timestamp
  const tSameMs = new Date('2026-11-13T10:00:00.000Z');

  // Signal 1 arrives at tSameMs -> syncRequestVersion = 1
  const c1 = await signalMailboxSync({ mailbox, folder, requestedAt: tSameMs });
  assert.equal(c1.syncRequestVersion, 1);

  // Worker begins pass and captures version = 1
  const lock = await acquireSyncLock({ mailbox, folder, now: tSameMs });
  const capturedVersion = c1.syncRequestVersion; // 1

  // Signal 2 arrives with the EXACT SAME TIMESTAMP tSameMs (same millisecond!)
  // Under timestamp comparisons (requestedAt > passStartedAt), this would fail (tSameMs > tSameMs is false).
  // Under monotonic syncRequestVersion, it increments to 2!
  const c2 = await signalMailboxSync({ mailbox, folder, requestedAt: tSameMs });
  assert.equal(c2.syncRequestVersion, 2);

  // Pass 1 commits with capturedVersion = 1
  const updated = await advanceSyncCursor({
    cursorId: lock.cursor._id,
    syncLockToken: lock.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=p1',
    capturedVersion,
    commitTime: tSameMs
  });

  // Must detect that syncRequestVersion (2) > capturedVersion (1) and keep hasPendingSync = true!
  assert.equal(updated.hasPendingSync, true, 'Same millisecond signal MUST be detected via version increment');
  assert.equal(updated.lastSyncedVersion, 1);
  assert.equal(updated.syncRequestVersion, 2);
});

test('mailboxSyncService: multiple signals arriving during one pass are all captured and loop immediately', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });

  let passCount = 0;
  const syncPassFn = async (cursor) => {
    passCount++;

    if (passCount === 1) {
      assert.equal(cursor.capturedVersion, 1);
      // Simulate 5 incoming webhook signals during pass 1
      for (let i = 0; i < 5; i++) {
        await signalMailboxSync({ mailbox, folder });
      }
      return { nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=pass1', count: 2 };
    }

    if (passCount === 2) {
      // Pass 2 must have captured the updated version = 6
      assert.equal(cursor.capturedVersion, 6);
      return { nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=pass2', count: 5 };
    }

    return { nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=pass3', count: 0 };
  };

  const result = await runCoalescedSync({
    mailbox,
    folder,
    syncPassFn
  });

  assert.equal(result.executed, true);
  assert.equal(result.passes, 2);
  assert.equal(result.totalIngested, 7);
  assert.equal(result.lastSyncedVersion, 6);
  assert.equal(result.hasPendingSync, false);

  const finalCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(finalCursor.syncRequestVersion, 6);
  assert.equal(finalCursor.lastSyncedVersion, 6);
  assert.equal(finalCursor.hasPendingSync, false);
  assert.equal(finalCursor.syncStatus, 'idle');
});

test('mailboxSyncService: signal arriving immediately before cursor advancement is preserved', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const c0 = await signalMailboxSync({ mailbox, folder });
  const lock = await acquireSyncLock({ mailbox, folder });
  const capturedVersion = c0.syncRequestVersion; // 1

  // Signal arrives immediately before advanceSyncCursor
  await signalMailboxSync({ mailbox, folder }); // syncRequestVersion becomes 2

  const updated = await advanceSyncCursor({
    cursorId: lock.cursor._id,
    syncLockToken: lock.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=v1',
    capturedVersion
  });

  assert.equal(updated.hasPendingSync, true);
  assert.equal(updated.syncRequestVersion, 2);
  assert.equal(updated.lastSyncedVersion, 1);
});

test('mailboxSyncService: signal arriving immediately after cursor advancement refuses lock release', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const c0 = await signalMailboxSync({ mailbox, folder });
  const lock = await acquireSyncLock({ mailbox, folder });
  const capturedVersion = c0.syncRequestVersion; // 1

  // Advance cursor for capturedVersion = 1 (no signals arrived during pass)
  const updated = await advanceSyncCursor({
    cursorId: lock.cursor._id,
    syncLockToken: lock.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=v1',
    capturedVersion
  });
  assert.equal(updated.hasPendingSync, false);

  // Signal arrives immediately after cursor advancement but BEFORE release
  await signalMailboxSync({ mailbox, folder }); // syncRequestVersion becomes 2

  // Attempt release with capturedVersion = 1 -> MUST BE REFUSED
  const releaseRes = await releaseSyncLockIfNoPending({
    cursorId: lock.cursor._id,
    syncLockToken: lock.lockToken,
    capturedVersion
  });

  assert.equal(releaseRes.released, false);
  assert.equal(releaseRes.hasPendingSync, true);
  assert.equal(releaseRes.syncRequestVersion, 2);

  // Worker holding lock continues to Pass 2 and advances to version 2
  const pass2Commit = await advanceSyncCursor({
    cursorId: lock.cursor._id,
    syncLockToken: lock.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=v2',
    capturedVersion: 2
  });
  assert.equal(pass2Commit.hasPendingSync, false);

  // Now release succeeds
  const cleanRelease = await releaseSyncLockIfNoPending({
    cursorId: lock.cursor._id,
    syncLockToken: lock.lockToken,
    capturedVersion: 2
  });
  assert.equal(cleanRelease.released, true);
});

test('mailboxSyncService: stale worker cannot advance cursor or alter request version', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const t0 = new Date('2026-11-13T10:00:00.000Z');
  await signalMailboxSync({ mailbox, folder, requestedAt: t0 });

  const worker1 = await acquireSyncLock({ mailbox, folder, leaseMs: 30000, now: t0 });
  const staleToken = worker1.lockToken;
  const cursorId = worker1.cursor._id;

  // Lease expires at t0 + 31s. Worker 2 claims lock with new token
  const t1 = new Date('2026-11-13T10:00:31.000Z');
  const worker2 = await acquireSyncLock({ mailbox, folder, leaseMs: 30000, now: t1 });
  assert.equal(worker2.locked, true);
  const activeToken = worker2.lockToken;

  // Stale Worker 1 attempts advanceSyncCursor
  const staleAdvance = await advanceSyncCursor({
    cursorId,
    syncLockToken: staleToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=stale',
    capturedVersion: 1,
    commitTime: t1
  });
  assert.equal(staleAdvance, null, 'Stale worker cannot advance cursor');

  // Verify database still holds Worker 2's token and untouched state
  const current = await EmailSyncCursor.findById(cursorId).lean();
  assert.equal(current.syncLockToken, activeToken);
  assert.equal(current.syncStatus, 'syncing');
});

test('mailboxSyncService: worker crash preserves request version monotonically across lease recovery', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const t0 = new Date('2026-11-13T10:00:00.000Z');
  await signalMailboxSync({ mailbox, folder, requestedAt: t0 }); // version = 1

  const worker1 = await acquireSyncLock({ mailbox, folder, leaseMs: 30000, now: t0 });
  assert.equal(worker1.locked, true);

  // Worker 1 crashes. Meanwhile, 3 new signals arrive
  await signalMailboxSync({ mailbox, folder }); // version = 2
  await signalMailboxSync({ mailbox, folder }); // version = 3
  await signalMailboxSync({ mailbox, folder }); // version = 4

  // Verify version is 4 in DB
  const crashState = await EmailSyncCursor.findById(worker1.cursor._id).lean();
  assert.equal(crashState.syncRequestVersion, 4);
  assert.equal(crashState.lastSyncedVersion, 0);
  assert.equal(crashState.hasPendingSync, true);

  // Lease expires. Worker 2 recovers and captures version 4
  const tRecover = new Date('2026-11-13T10:00:31.000Z');
  const worker2 = await acquireSyncLock({ mailbox, folder, leaseMs: 30000, now: tRecover });
  assert.equal(worker2.locked, true);
  assert.equal(worker2.cursor.syncRequestVersion, 4);

  // Worker 2 completes pass for version 4
  const passRes = await advanceSyncCursor({
    cursorId: worker2.cursor._id,
    syncLockToken: worker2.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=v4',
    capturedVersion: 4,
    commitTime: tRecover
  });

  assert.equal(passRes.lastSyncedVersion, 4);
  assert.equal(passRes.syncRequestVersion, 4);
  assert.equal(passRes.hasPendingSync, false);

  await releaseSyncLockIfNoPending({
    cursorId: worker2.cursor._id,
    syncLockToken: worker2.lockToken,
    capturedVersion: 4,
    now: tRecover
  });

  const finalCursor = await EmailSyncCursor.findById(worker1.cursor._id).lean();
  assert.equal(finalCursor.syncStatus, 'idle');
  assert.equal(finalCursor.lastSyncedVersion, 4);
  assert.equal(finalCursor.syncRequestVersion, 4);
});

test('mailboxSyncService: sync failure preserves syncRequestVersion and marks error', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder }); // version = 1

  const failingPass = async () => {
    throw new Error('Graph 429 Too Many Requests');
  };

  await assert.rejects(
    async () => {
      await runCoalescedSync({ mailbox, folder, syncPassFn: failingPass });
    },
    /Graph 429 Too Many Requests/
  );

  const cursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(cursor.syncStatus, 'failed');
  assert.equal(cursor.hasPendingSync, true);
  assert.equal(cursor.syncRequestVersion, 1);
  assert.equal(cursor.lastSyncedVersion, 0);
  assert.match(cursor.error, /429 Too Many Requests/);

  // Pending cursors query discovers it
  const pending = await findPendingSyncCursors();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mailbox, mailbox);
});

test('mailboxSyncService: maxPasses reached preserves version gap and invokes follow-up callback', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });

  let passCount = 0;
  let hookInvoked = false;

  const syncPassFn = async () => {
    passCount++;
    // Trigger signal on each pass
    await signalMailboxSync({ mailbox, folder });
    return { nextDeltaLink: `https://graph.microsoft.com/v1.0/delta?token=p${passCount}`, count: 1 };
  };

  const scheduleFollowUpFn = async ({ cursor, deltaLink }) => {
    hookInvoked = true;
    assert.equal(cursor.syncStatus, 'idle');
    assert.equal(cursor.hasPendingSync, true);
  };

  const result = await runCoalescedSync({
    mailbox,
    folder,
    maxPasses: 3,
    syncPassFn,
    scheduleFollowUpFn
  });

  assert.equal(result.executed, true);
  assert.equal(result.passes, 3);
  assert.equal(result.maxPassesReached, true);
  assert.equal(result.hasPendingSync, true);
  assert.equal(hookInvoked, true);

  const cursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(cursor.syncStatus, 'idle');
  assert.equal(cursor.hasPendingSync, true);
  assert.ok(cursor.syncRequestVersion > cursor.lastSyncedVersion);
});

test('mailboxSyncService: initial baseline sync sets baselineCompletedAt and advances version', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const t0 = new Date('2026-11-13T10:00:00.000Z');
  const initial = await checkPeriodicReconciliation({ mailbox, folder, now: t0 });
  assert.equal(initial.needed, true);
  assert.equal(initial.reason, 'no_cursor_baseline_needed');

  const baselineRes = await runCoalescedSync({
    mailbox,
    folder,
    syncPassFn: async () => ({ nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=init', count: 10 }),
    now: t0
  });

  assert.equal(baselineRes.executed, true);
  const cursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.ok(cursor.baselineCompletedAt);
  assert.ok(cursor.lastSuccessfulSyncAt);
  assert.equal(cursor.lastSyncedVersion, 1);
  assert.equal(cursor.hasPendingSync, false);

  const fresh = await checkPeriodicReconciliation({ mailbox, folder, maxStaleMs: 600000, now: new Date('2026-11-13T10:05:00.000Z') });
  assert.equal(fresh.needed, false);
  assert.equal(fresh.reason, 'sync_fresh');
});

test('mailboxSyncService: crash after ingesting emails before cursor advancement recovers idempotently', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });

  const emailsToIngest = [
    { graphMessageId: 'msg-ver-1', internetMessageId: '<v1@guidexpert.com>', subject: 'V1', receivedDateTime: new Date() },
    { graphMessageId: 'msg-ver-2', internetMessageId: '<v2@guidexpert.com>', subject: 'V2', receivedDateTime: new Date() }
  ];

  // Worker 1 ingests 2 emails and crashes
  await acquireSyncLock({ mailbox, folder, leaseMs: 30000 });
  for (const item of emailsToIngest) {
    await SupportEmail.create(item);
  }

  // Worker 2 recovers after lease expiry and idempotently re-ingests
  const tRecover = new Date(Date.now() + 35000);
  const worker2Res = await runCoalescedSync({
    mailbox,
    folder,
    now: tRecover,
    syncPassFn: async () => {
      for (const item of emailsToIngest) {
        try {
          await SupportEmail.create(item);
        } catch (err) {
          if (err.code === 11000) continue;
          throw err;
        }
      }
      return { nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?token=rec_ver', count: 2 };
    }
  });

  assert.equal(worker2Res.executed, true);
  const count = await SupportEmail.countDocuments({ graphMessageId: { $in: ['msg-ver-1', 'msg-ver-2'] } });
  assert.equal(count, 2);

  const finalCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(finalCursor.deltaLink, 'https://graph.microsoft.com/v1.0/delta?token=rec_ver');
  assert.equal(finalCursor.syncStatus, 'idle');
  assert.equal(finalCursor.hasPendingSync, false);
});
