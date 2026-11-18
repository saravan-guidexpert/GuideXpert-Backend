'use strict';

const crypto = require('crypto');
const SupportEmailRun = require('../../models/SupportEmailRun');
const queue = require('./queueService');
const { getProcessingConfig } = require('./processingConfig');
const { processEmailBody } = require('./bodyProcessingService');
const { processAttachments } = require('./attachmentService');
const { classifyEmail } = require('./classificationService');
const { createTicketForEmail } = require('./ticketService');
const { loadEmail, setPipelineStage } = require('./bodyProcessingService');
const { recordMetricEvent, summarizeError } = require('./observability');
const { STAGES, JOB_STATES } = require('../../constants/supportEmail');

const LOCK_KEY = 'phase3-process';

async function acquireLock(now, leaseMs) {
  const lockExpiresAt = new Date(now.getTime() + leaseMs);
  const lockToken = crypto.randomBytes(16).toString('hex');
  const takenOver = await SupportEmailRun.findOneAndUpdate(
    { runKey: LOCK_KEY, activeLock: true, lockExpiresAt: { $lte: now } },
    { $set: { startedAt: now, finishedAt: null, lockExpiresAt, lockToken, success: null, errorSummary: null } },
    { new: true }
  );
  if (takenOver) return takenOver;
  try {
    return await SupportEmailRun.create({
      runKey: LOCK_KEY,
      activeLock: true,
      startedAt: now,
      lockExpiresAt,
      lockToken,
      success: null,
      stats: {}
    });
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}

async function releaseLock(lock, stats, errorSummary) {
  if (!lock || !lock.lockToken) return;
  const finishedAt = new Date();
  await SupportEmailRun.updateOne(
    { _id: lock._id, activeLock: true, lockToken: lock.lockToken },
    {
      $set: {
        activeLock: false,
        lockToken: null,
        finishedAt,
        durationMs: finishedAt.getTime() - new Date(lock.startedAt).getTime(),
        success: !errorSummary,
        stats,
        errorSummary: errorSummary || null
      }
    }
  );
}

async function openManualReview(emailId) {
  const email = await loadEmail(emailId);
  if (email.pipeline.ai === 'pending' || email.pipeline.ai === 'processing' || email.pipeline.ai === 'failed') {
    await setPipelineStage(email, STAGES.AI, 'needs_review');
  }
  await queue.enqueueJob({ emailId, stage: STAGES.TICKET });
}

async function runStage(job, deps) {
  if (job.stage === STAGES.FETCH) return processEmailBody(await loadEmail(job.emailId), deps);
  if (job.stage === STAGES.ATTACHMENTS) return processAttachments(job.emailId, deps);
  if (job.stage === STAGES.AI) return classifyEmail(job.emailId, deps);
  if (job.stage === STAGES.TICKET) return createTicketForEmail(job.emailId);
  // Google Sheets is disconnected from the active pipeline. A leftover sheets job completes without any external call.
  return { done: true };
}

/**
 * Claims and runs a bounded batch. Two cron invocations cannot hold the run
 * lock together, and two workers cannot claim the same job.
 */
async function runProcessingBatch(options = {}) {
  const config = getProcessingConfig(options);
  if (!config.enabled) {
    return { enabled: false, processed: 0, reason: 'SUPPORT_EMAIL_PROCESSING_ENABLED is not exactly 1, so the bulk worker stays off' };
  }

  const now = options.now || new Date();
  const lock = await acquireLock(now, config.leaseMs);
  if (!lock) {
    recordMetricEvent('support_email_processing_skipped', { reason: 'lock_held' });
    return { enabled: true, skipped: 'lock_held', processed: 0 };
  }

  const stats = {
    processed: 0,
    completed: 0,
    retried: 0,
    deadLetter: 0,
    needsReview: 0
  };
  const deps = {
    config,
    graphClient: options.graphClient,
    chatCompletion: options.chatCompletion
  };
  const deadline = now.getTime() + config.timeBudgetMs;

  try {
    await queue.recoverStaleJobs({ now });
    while (Date.now() < deadline && stats.processed < config.batchSize) {
      const job = await queue.claimJob({
        workerId: config.workerId,
        leaseMs: config.leaseMs,
        now: new Date()
      });
      if (!job) break;
      stats.processed += 1;
      await queue.startProcessingJob({ jobId: job._id, claimToken: job.claimToken });
      try {
        const result = await runStage(job, deps);
        const completed = await queue.completeJob({ jobId: job._id, claimToken: job.claimToken });
        if (!completed) continue;
        stats.completed += 1;
        if (result && result.outcome === 'needs_review') stats.needsReview += 1;
        if (result && result.enqueue) {
          await queue.enqueueJob({ emailId: job.emailId, stage: result.enqueue });
        }
        recordMetricEvent('support_email_stage_completed', { stage: job.stage });
      } catch (err) {
        const failure = await queue.failJob({
          jobId: job._id,
          claimToken: job.claimToken,
          error: err.code || 'stage_failed'
        });
        if (failure.state === JOB_STATES.DEAD_LETTER) {
          stats.deadLetter += 1;
          if (job.stage === STAGES.AI || job.stage === STAGES.FETCH) {
            await openManualReview(job.emailId);
            stats.needsReview += 1;
          }
        } else {
          stats.retried += 1;
        }
        recordMetricEvent('support_email_stage_failed', {
          stage: job.stage,
          errorCode: err.code || 'stage_failed',
          ...summarizeError(err)
        });
      }
    }
    await releaseLock(lock, stats, null);
    return { enabled: true, ...stats };
  } catch (err) {
    await releaseLock(lock, stats, err.code || 'batch_failed');
    throw err;
  }
}

module.exports = {
  runProcessingBatch,
  acquireLock,
  releaseLock,
  LOCK_KEY
};
