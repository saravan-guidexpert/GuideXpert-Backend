'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');

const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');
const {
  enqueueJob,
  claimJob,
  claimBatch,
  renewLease,
  startProcessingJob,
  releaseJob,
  completeJob,
  failJob,
  recoverStaleJobs
} = require('../services/supportEmail/queueService');
const { JOB_STATES, LIMITS } = require('../constants/supportEmail');

describe('supportEmail queueService', () => {
  before(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  test('concurrency: 4 concurrent workers claim 100 jobs exactly once each', async () => {
    const totalJobs = 100;
    const emailIds = [];

    // Seed 100 pending jobs
    for (let i = 0; i < totalJobs; i++) {
      const emailId = new mongoose.Types.ObjectId();
      emailIds.push(emailId);
      await enqueueJob({
        emailId,
        stage: 'fetch',
        priority: i % 5,
        nextAttemptAt: new Date(Date.now() - 1000)
      });
    }

    const workerIds = ['worker-1', 'worker-2', 'worker-3', 'worker-4'];
    const claimedByWorker = {
      'worker-1': [],
      'worker-2': [],
      'worker-3': [],
      'worker-4': []
    };

    // Simulate 4 concurrent workers constantly claiming until queue is empty
    async function runWorker(workerId) {
      while (true) {
        const job = await claimJob({ stage: 'fetch', workerId, leaseMs: 60000 });
        if (!job) break;
        claimedByWorker[workerId].push(job);
      }
    }

    await Promise.all(workerIds.map((id) => runWorker(id)));

    // Verify all 100 jobs were claimed
    const allClaimed = Object.values(claimedByWorker).flat();
    assert.equal(allClaimed.length, totalJobs, `Expected exactly ${totalJobs} claimed jobs`);

    // Verify claim exclusivity (no job claimed more than once)
    const claimedJobIds = new Set();
    for (const job of allClaimed) {
      const idStr = String(job._id);
      assert.ok(!claimedJobIds.has(idStr), `Job ${idStr} was claimed by multiple workers!`);
      claimedJobIds.add(idStr);
      assert.equal(job.state, JOB_STATES.CLAIMED);
      assert.ok(job.claimToken, 'Job must have a claimToken');
      assert.equal(job.attempts, 1, 'Job attempts must be 1');
    }

    // Verify every worker claimed at least some jobs (balanced distribution under concurrency)
    for (const workerId of workerIds) {
      assert.ok(
        claimedByWorker[workerId].length > 0,
        `Worker ${workerId} should have claimed at least one job`
      );
    }
  });

  test('crash recovery: expired lease allows recovery by another worker', async () => {
    const emailId = new mongoose.Types.ObjectId();
    const now = new Date();

    const enqueued = await enqueueJob({ emailId, stage: 'fetch' });

    // Worker 1 claims job with short lease of 500ms
    const worker1Claim = await claimJob({
      stage: 'fetch',
      workerId: 'worker-1',
      leaseMs: 500,
      now
    });
    assert.ok(worker1Claim);
    assert.equal(worker1Claim.claimedBy, 'worker-1');
    assert.equal(worker1Claim.attempts, 1);

    // Immediate claim attempt while lease is active returns null
    const immediateClaim = await claimJob({
      stage: 'fetch',
      workerId: 'worker-2',
      leaseMs: 5000,
      now
    });
    assert.equal(immediateClaim, null, 'Active lease must not be claimed by another worker');

    // Simulate time passing beyond lease expiry (worker 1 crashed)
    const futureTime = new Date(now.getTime() + 1000);
    const worker2RecoveryClaim = await claimJob({
      stage: 'fetch',
      workerId: 'worker-2',
      leaseMs: 5000,
      now: futureTime
    });

    assert.ok(worker2RecoveryClaim, 'Worker 2 should successfully recover the job after lease expired');
    assert.equal(String(worker2RecoveryClaim._id), String(worker1Claim._id));
    assert.equal(worker2RecoveryClaim.claimedBy, 'worker-2');
    assert.notEqual(worker2RecoveryClaim.claimToken, worker1Claim.claimToken);
    assert.equal(worker2RecoveryClaim.attempts, 2, 'Attempts should increment to 2 on recovery claim');
  });

  test('stale claim tokens cannot complete, release, renew, or fail jobs', async () => {
    const emailId = new mongoose.Types.ObjectId();
    const now = new Date();

    await enqueueJob({ emailId, stage: 'fetch' });

    // Worker 1 claims job
    const worker1Claim = await claimJob({
      stage: 'fetch',
      workerId: 'worker-1',
      leaseMs: 1000,
      now
    });
    const staleToken = worker1Claim.claimToken;

    // Simulate lease expiry and Worker 2 recovering the job
    const recoveryTime = new Date(now.getTime() + 2000);
    const worker2Claim = await claimJob({
      stage: 'fetch',
      workerId: 'worker-2',
      leaseMs: 5000,
      now: recoveryTime
    });
    assert.ok(worker2Claim);
    const freshToken = worker2Claim.claimToken;
    assert.notEqual(staleToken, freshToken);

    // Worker 1 (with stale token) tries to complete job -> fails
    const staleComplete = await completeJob({
      jobId: worker1Claim._id,
      claimToken: staleToken
    });
    assert.equal(staleComplete, null, 'Stale token must not complete job');

    // Worker 1 tries to renew lease -> fails
    const staleRenew = await renewLease({
      jobId: worker1Claim._id,
      claimToken: staleToken
    });
    assert.equal(staleRenew, false, 'Stale token must not renew lease');

    // Worker 1 tries to release job -> fails
    const staleRelease = await releaseJob({
      jobId: worker1Claim._id,
      claimToken: staleToken
    });
    assert.equal(staleRelease, null, 'Stale token must not release job');

    // Worker 1 tries to fail job -> fails
    const staleFail = await failJob({
      jobId: worker1Claim._id,
      claimToken: staleToken,
      error: 'Worker 1 error'
    });
    assert.equal(staleFail.modified, false);
    assert.equal(staleFail.reason, 'invalid_token_or_not_claimed');

    // Fresh worker 2 can safely complete the job
    const validComplete = await completeJob({
      jobId: worker1Claim._id,
      claimToken: freshToken
    });
    assert.ok(validComplete);
    assert.equal(validComplete.state, JOB_STATES.COMPLETED);
    assert.equal(validComplete.claimToken, null);
  });

  test('retry limits and dead-letter transitions work when attempts reach cap', async () => {
    const emailId = new mongoose.Types.ObjectId();
    const maxAttempts = 3;
    let now = new Date();

    await enqueueJob({
      emailId,
      stage: 'ai',
      maxAttempts
    });

    // Attempt 1: claim and fail (retryable)
    let job = await claimJob({ stage: 'ai', now });
    assert.equal(job.attempts, 1);
    let failRes = await failJob({
      jobId: job._id,
      claimToken: job.claimToken,
      error: 'AI timeout 1',
      maxAttempts,
      backoffMs: 1000,
      now
    });
    assert.equal(failRes.modified, true);
    assert.equal(failRes.state, JOB_STATES.PENDING);

    // Attempt 2: fast-forward past backoff, claim and fail (retryable)
    now = new Date(now.getTime() + 1500);
    job = await claimJob({ stage: 'ai', now });
    assert.equal(job.attempts, 2);
    failRes = await failJob({
      jobId: job._id,
      claimToken: job.claimToken,
      error: 'AI timeout 2',
      maxAttempts,
      backoffMs: 1000,
      now
    });
    assert.equal(failRes.modified, true);
    assert.equal(failRes.state, JOB_STATES.PENDING);

    // Attempt 3: fast-forward, claim and fail -> reaches maxAttempts (3) -> moves to dead_letter
    now = new Date(now.getTime() + 1500);
    job = await claimJob({ stage: 'ai', now });
    assert.equal(job.attempts, 3);
    failRes = await failJob({
      jobId: job._id,
      claimToken: job.claimToken,
      error: 'AI fatal error 3',
      maxAttempts,
      now
    });

    assert.equal(failRes.modified, true);
    assert.equal(failRes.state, JOB_STATES.DEAD_LETTER);
    assert.equal(failRes.job.deadLetterReason, 'AI fatal error 3');
    assert.ok(failRes.job.deadLetterAt);

    // Further claims find nothing
    const noJob = await claimJob({ stage: 'ai', now: new Date(now.getTime() + 5000) });
    assert.equal(noJob, null, 'Dead-lettered job must not be claimed by queue');
  });

  test('recoverStaleJobs handles batch recovery of crashed worker leases', async () => {
    const now = new Date();

    // Job 1: below max attempts -> recovered to pending
    const email1 = new mongoose.Types.ObjectId();
    await enqueueJob({ emailId: email1, stage: 'ticket', maxAttempts: 3, nextAttemptAt: now });
    const job1 = await claimJob({ stage: 'ticket', leaseMs: 100, now });

    // Job 2: at max attempts -> dead-lettered
    const email2 = new mongoose.Types.ObjectId();
    await enqueueJob({ emailId: email2, stage: 'ticket', maxAttempts: 1, nextAttemptAt: now });
    const job2 = await claimJob({ stage: 'ticket', leaseMs: 100, now });
    assert.ok(job2);
    assert.equal(job2.attempts, 1);

    // Run recovery after lease expiration
    const future = new Date(now.getTime() + 200);
    const recoveryResult = await recoverStaleJobs({ stage: 'ticket', now: future });

    assert.equal(recoveryResult.totalScanned, 2);
    assert.equal(recoveryResult.recoveredCount, 1);
    assert.equal(recoveryResult.deadLetterCount, 1);

    const doc1 = await SupportEmailProcessingJob.findById(job1._id);
    assert.equal(doc1.state, JOB_STATES.PENDING);
    assert.equal(doc1.claimToken, null);

    const doc2 = await SupportEmailProcessingJob.findById(job2._id);
    assert.equal(doc2.state, JOB_STATES.DEAD_LETTER);
    assert.equal(doc2.claimToken, null);
  });

  test('priority ordering: high priority jobs claimed first', async () => {
    const emailLow = new mongoose.Types.ObjectId();
    const emailHigh = new mongoose.Types.ObjectId();

    await enqueueJob({ emailId: emailLow, stage: 'fetch', priority: 1 });
    await enqueueJob({ emailId: emailHigh, stage: 'fetch', priority: 10 });

    const firstClaim = await claimJob({ stage: 'fetch' });
    assert.equal(String(firstClaim.emailId), String(emailHigh));

    const secondClaim = await claimJob({ stage: 'fetch' });
    assert.equal(String(secondClaim.emailId), String(emailLow));
  });

  test('boundary: expired lease with attempts >= maxAttempts cannot be reclaimed by claimJob', async () => {
    const emailId = new mongoose.Types.ObjectId();
    const now = new Date();

    // Job with maxAttempts = 1
    await enqueueJob({ emailId, stage: 'ai', maxAttempts: 1, nextAttemptAt: now });

    // Worker 1 claims the single allowed attempt and crashes
    const worker1Claim = await claimJob({ stage: 'ai', workerId: 'worker-1', leaseMs: 100, now });
    assert.ok(worker1Claim);
    assert.equal(worker1Claim.attempts, 1);

    // Fast forward past lease expiration
    const future = new Date(now.getTime() + 500);

    // Worker 2 calls claimJob -> must NOT reclaim because attempts reached maxAttempts
    const worker2Claim = await claimJob({ stage: 'ai', workerId: 'worker-2', now: future });
    assert.equal(worker2Claim, null, 'claimJob must not allow reclaiming an expired lease when maxAttempts reached');

    // recoverStaleJobs moves it to dead_letter
    const rec = await recoverStaleJobs({ stage: 'ai', now: future });
    assert.equal(rec.deadLetterCount, 1);

    const doc = await SupportEmailProcessingJob.findById(worker1Claim._id);
    assert.equal(doc.state, JOB_STATES.DEAD_LETTER);
  });

  test('race condition: lease renewal protects against stale recovery clobbering active lease', async () => {
    const emailId = new mongoose.Types.ObjectId();
    const now = new Date();

    await enqueueJob({ emailId, stage: 'ticket', nextAttemptAt: now });
    const claim = await claimJob({ stage: 'ticket', workerId: 'worker-1', leaseMs: 500, now });
    assert.ok(claim);

    // Simulate worker actively renewing its lease
    const renewed = await renewLease({
      jobId: claim._id,
      claimToken: claim.claimToken,
      leaseMs: 120000,
      now
    });
    assert.equal(renewed, true);

    // Now recovery runs at now + 600ms (which would have been past the original 500ms lease)
    const recoveryTime = new Date(now.getTime() + 600);
    const recResult = await recoverStaleJobs({ stage: 'ticket', now: recoveryTime });

    // Recovery must not have touched the renewed job!
    assert.equal(recResult.recoveredCount, 0);
    assert.equal(recResult.deadLetterCount, 0);

    const checkJob = await SupportEmailProcessingJob.findById(claim._id);
    assert.equal(checkJob.state, JOB_STATES.CLAIMED);
    assert.equal(checkJob.claimToken, claim.claimToken);
    assert.ok(checkJob.leaseExpiresAt > recoveryTime);
  });
});
