'use strict';

const crypto = require('crypto');
const SupportEmailProcessingJob = require('../../models/SupportEmailProcessingJob');
const {
  STAGES,
  JOB_STATES,
  LIMITS
} = require('../../constants/supportEmail');

/**
 * Generates a collision-resistant unique claim token.
 */
function generateClaimToken() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Enqueues a job for an email and stage idempotently.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.emailId
 * @param {string} params.stage
 * @param {number} [params.priority=0]
 * @param {number} [params.maxAttempts]
 * @param {Date} [params.nextAttemptAt]
 * @param {Object} [params.metadata]
 * @param {boolean} [params.requeue=false] If true and job exists in failed/dead_letter, re-enqueues it
 * @returns {Promise<Object>} The job document
 */
async function enqueueJob({
  emailId,
  stage,
  priority = 0,
  maxAttempts,
  nextAttemptAt = new Date(),
  metadata = {},
  requeue = false
}) {
  if (!emailId || !stage) {
    throw new Error('emailId and stage are required to enqueue a job');
  }

  const effectiveMaxAttempts =
    maxAttempts ||
    LIMITS.STAGE_MAX_ATTEMPTS[stage] ||
    LIMITS.DEFAULT_MAX_ATTEMPTS;

  if (requeue) {
    const existing = await SupportEmailProcessingJob.findOne({ emailId, stage });
    if (existing && [JOB_STATES.FAILED, JOB_STATES.DEAD_LETTER].includes(existing.state)) {
      existing.state = JOB_STATES.PENDING;
      existing.nextAttemptAt = nextAttemptAt;
      existing.priority = priority;
      existing.claimToken = null;
      existing.claimedBy = null;
      existing.leaseExpiresAt = null;
      existing.deadLetterAt = null;
      existing.deadLetterReason = null;
      await existing.save();
      return existing.toObject();
    }
  }

  const job = await SupportEmailProcessingJob.findOneAndUpdate(
    { emailId, stage },
    {
      $setOnInsert: {
        emailId,
        stage,
        state: JOB_STATES.PENDING,
        attempts: 0,
        maxAttempts: effectiveMaxAttempts,
        nextAttemptAt,
        priority,
        metadata
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return job;
}

/**
 * Atomically claims the highest-priority eligible job.
 * Handles both pending jobs and expired leases (stale worker crash recovery).
 * Crucially enforces that expired leases can only be claimed if attempts < maxAttempts.
 *
 * @param {Object} [params]
 * @param {string} [params.stage] Optional stage filter
 * @param {string} [params.workerId='worker'] Worker identifier
 * @param {number} [params.leaseMs=LIMITS.DEFAULT_STALE_LEASE_MS] Lease duration in ms
 * @param {Date} [params.now=new Date()] Current timestamp
 * @returns {Promise<Object|null>} Claimed job or null
 */
async function claimJob({
  stage,
  workerId = 'worker',
  leaseMs = LIMITS.DEFAULT_STALE_LEASE_MS,
  now = new Date()
} = {}) {
  const token = generateClaimToken();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const filter = {
    $and: [
      stage ? { stage } : {},
      {
        $or: [
          // Normal pending jobs due for attempt
          {
            state: JOB_STATES.PENDING,
            nextAttemptAt: { $lte: now }
          },
          // Stale/crashed worker leases eligible for recovery claim
          // Boundary check: attempts must be strictly below maxAttempts to reclaim
          {
            state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] },
            leaseExpiresAt: { $lte: now },
            $expr: { $lt: ['$attempts', '$maxAttempts'] }
          }
        ]
      }
    ]
  };

  const update = {
    $set: {
      state: JOB_STATES.CLAIMED,
      claimedAt: now,
      claimedBy: workerId,
      claimToken: token,
      leaseExpiresAt,
      updatedAt: now
    },
    $inc: { attempts: 1 }
  };

  const claimed = await SupportEmailProcessingJob.findOneAndUpdate(
    filter,
    update,
    {
      sort: { priority: -1, nextAttemptAt: 1, _id: 1 },
      new: true
    }
  ).lean();

  return claimed;
}

/**
 * Claims a batch of jobs sequentially up to limit.
 *
 * @param {Object} params
 * @param {string} [params.stage]
 * @param {number} [params.limit=LIMITS.DEFAULT_BATCH_SIZE]
 * @param {string} [params.workerId]
 * @param {number} [params.leaseMs]
 * @param {Date} [params.now]
 * @returns {Promise<Array<Object>>} Array of claimed job documents
 */
async function claimBatch({
  stage,
  limit = LIMITS.DEFAULT_BATCH_SIZE,
  workerId = 'worker',
  leaseMs = LIMITS.DEFAULT_STALE_LEASE_MS,
  now = new Date()
} = {}) {
  const jobs = [];
  for (let i = 0; i < limit; i++) {
    const job = await claimJob({ stage, workerId, leaseMs, now });
    if (!job) break;
    jobs.push(job);
  }
  return jobs;
}

/**
 * Renews the lease of an actively claimed job.
 * Protected by claim token.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.jobId
 * @param {string} params.claimToken
 * @param {number} [params.leaseMs=LIMITS.DEFAULT_STALE_LEASE_MS]
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<boolean>} True if lease was renewed, false if token stale/mismatched
 */
async function renewLease({
  jobId,
  claimToken,
  leaseMs = LIMITS.DEFAULT_STALE_LEASE_MS,
  now = new Date()
}) {
  if (!jobId || !claimToken) return false;

  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const updated = await SupportEmailProcessingJob.findOneAndUpdate(
    {
      _id: jobId,
      claimToken,
      state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] }
    },
    {
      $set: {
        leaseExpiresAt,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  return Boolean(updated);
}

/**
 * Transitions a job from claimed to processing.
 * Protected by claim token.
 */
async function startProcessingJob({
  jobId,
  claimToken,
  now = new Date()
}) {
  if (!jobId || !claimToken) return null;

  const updated = await SupportEmailProcessingJob.findOneAndUpdate(
    {
      _id: jobId,
      claimToken,
      state: JOB_STATES.CLAIMED
    },
    {
      $set: {
        state: JOB_STATES.PROCESSING,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  return updated;
}

/**
 * Releases a claimed job back to pending state (e.g. graceful shutdown).
 * Protected by claim token.
 */
async function releaseJob({
  jobId,
  claimToken,
  nextAttemptAt = new Date(),
  error = null,
  now = new Date()
}) {
  if (!jobId || !claimToken) return null;

  const updated = await SupportEmailProcessingJob.findOneAndUpdate(
    {
      _id: jobId,
      claimToken,
      state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] }
    },
    {
      $set: {
        state: JOB_STATES.PENDING,
        nextAttemptAt,
        lastError: error,
        claimToken: null,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  return updated;
}

/**
 * Marks a job completed.
 * Protected by claim token.
 */
async function completeJob({
  jobId,
  claimToken,
  now = new Date()
}) {
  if (!jobId || !claimToken) return null;

  const updated = await SupportEmailProcessingJob.findOneAndUpdate(
    {
      _id: jobId,
      claimToken,
      state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] }
    },
    {
      $set: {
        state: JOB_STATES.COMPLETED,
        completedAt: now,
        claimToken: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  return updated;
}

/**
 * Fails a job, either retrying with backoff or moving to dead_letter if max attempts reached.
 * Uses atomic findOneAndUpdate to prevent race conditions with expired lease recovery.
 * Protected by claim token.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.jobId
 * @param {string} params.claimToken
 * @param {string|Error} params.error
 * @param {number} [params.maxAttempts]
 * @param {number} [params.backoffMs=5000]
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<{ modified: boolean, state?: string, reason?: string, job?: Object }>}
 */
async function failJob({
  jobId,
  claimToken,
  error,
  maxAttempts,
  backoffMs = 5000,
  now = new Date()
}) {
  if (!jobId || !claimToken) {
    return { modified: false, reason: 'missing_identifiers' };
  }

  // Pre-read to inspect attempt count
  const existing = await SupportEmailProcessingJob.findOne({
    _id: jobId,
    claimToken,
    state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] }
  }).lean();

  if (!existing) {
    return { modified: false, reason: 'invalid_token_or_not_claimed' };
  }

  const errorMessage = error instanceof Error ? error.message : String(error || 'Job failed');
  const cap = maxAttempts || existing.maxAttempts || LIMITS.DEFAULT_MAX_ATTEMPTS;

  if (existing.attempts >= cap) {
    // Atomic transition to dead_letter guarded by claimToken
    const updated = await SupportEmailProcessingJob.findOneAndUpdate(
      {
        _id: jobId,
        claimToken,
        state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] }
      },
      {
        $set: {
          state: JOB_STATES.DEAD_LETTER,
          deadLetterAt: now,
          deadLetterReason: errorMessage,
          lastError: errorMessage,
          claimToken: null,
          claimedBy: null,
          leaseExpiresAt: null,
          updatedAt: now
        }
      },
      { new: true }
    ).lean();

    if (!updated) {
      return { modified: false, reason: 'claim_lost_during_failure_transition' };
    }
    return { modified: true, state: JOB_STATES.DEAD_LETTER, job: updated };
  }

  // Atomic transition to pending (retry) guarded by claimToken
  const updated = await SupportEmailProcessingJob.findOneAndUpdate(
    {
      _id: jobId,
      claimToken,
      state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] }
    },
    {
      $set: {
        state: JOB_STATES.PENDING,
        nextAttemptAt: new Date(now.getTime() + backoffMs),
        lastError: errorMessage,
        claimToken: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: now
      }
    },
    { new: true }
  ).lean();

  if (!updated) {
    return { modified: false, reason: 'claim_lost_during_failure_transition' };
  }
  return { modified: true, state: JOB_STATES.PENDING, nextAttemptAt: updated.nextAttemptAt, job: updated };
}

/**
 * Recovers all expired leases back to pending or dead-letters them if max attempts reached.
 * Uses atomic conditional updates on each document to avoid racing with active lease renewal.
 *
 * @param {Object} [params]
 * @param {string} [params.stage]
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<{ recoveredCount: number, deadLetterCount: number, totalScanned: number }>}
 */
async function recoverStaleJobs({ stage, now = new Date() } = {}) {
  const query = {
    $and: [
      stage ? { stage } : {},
      {
        state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] },
        leaseExpiresAt: { $lte: now }
      }
    ]
  };

  const staleJobs = await SupportEmailProcessingJob.find(query).lean();
  let recoveredCount = 0;
  let deadLetterCount = 0;

  for (const job of staleJobs) {
    const cap = job.maxAttempts || LIMITS.DEFAULT_MAX_ATTEMPTS;
    if (job.attempts >= cap) {
      // Atomic conditional dead-lettering: ensures lease was not renewed since query
      const res = await SupportEmailProcessingJob.findOneAndUpdate(
        {
          _id: job._id,
          state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] },
          leaseExpiresAt: job.leaseExpiresAt,
          claimToken: job.claimToken
        },
        {
          $set: {
            state: JOB_STATES.DEAD_LETTER,
            deadLetterAt: now,
            deadLetterReason: 'Lease expired after maximum attempts reached',
            claimToken: null,
            claimedBy: null,
            leaseExpiresAt: null,
            updatedAt: now
          }
        }
      );
      if (res) deadLetterCount++;
    } else {
      // Atomic conditional recovery to pending
      const res = await SupportEmailProcessingJob.findOneAndUpdate(
        {
          _id: job._id,
          state: { $in: [JOB_STATES.CLAIMED, JOB_STATES.PROCESSING] },
          leaseExpiresAt: job.leaseExpiresAt,
          claimToken: job.claimToken
        },
        {
          $set: {
            state: JOB_STATES.PENDING,
            nextAttemptAt: now,
            lastError: 'Lease expired while in flight; recovered for retry',
            claimToken: null,
            claimedBy: null,
            leaseExpiresAt: null,
            updatedAt: now
          }
        }
      );
      if (res) recoveredCount++;
    }
  }

  return {
    totalScanned: staleJobs.length,
    recoveredCount,
    deadLetterCount
  };
}

module.exports = {
  generateClaimToken,
  enqueueJob,
  claimJob,
  claimBatch,
  renewLease,
  startProcessingJob,
  releaseJob,
  completeJob,
  failJob,
  recoverStaleJobs
};
