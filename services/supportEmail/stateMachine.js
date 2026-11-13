'use strict';

const {
  JOB_STATES,
  STAGES,
  STAGE_STATES,
  EMAIL_PIPELINE_STATES
} = require('../../constants/supportEmail');

/**
 * Valid state transitions for queue jobs.
 */
const JOB_STATE_TRANSITIONS = Object.freeze({
  [JOB_STATES.PENDING]: Object.freeze([JOB_STATES.CLAIMED, JOB_STATES.CANCELLED]),
  [JOB_STATES.CLAIMED]: Object.freeze([
    JOB_STATES.PROCESSING,
    JOB_STATES.PENDING, // release back to queue
    JOB_STATES.COMPLETED,
    JOB_STATES.FAILED,
    JOB_STATES.DEAD_LETTER
  ]),
  [JOB_STATES.PROCESSING]: Object.freeze([
    JOB_STATES.COMPLETED,
    JOB_STATES.PENDING, // retry / backoff
    JOB_STATES.FAILED,
    JOB_STATES.DEAD_LETTER
  ]),
  [JOB_STATES.FAILED]: Object.freeze([
    JOB_STATES.PENDING, // backoff re-enqueue
    JOB_STATES.DEAD_LETTER
  ]),
  [JOB_STATES.DEAD_LETTER]: Object.freeze([
    JOB_STATES.PENDING // admin manual requeue
  ]),
  [JOB_STATES.COMPLETED]: Object.freeze([]),
  [JOB_STATES.CANCELLED]: Object.freeze([])
});

/**
 * Valid stage-specific pipeline transitions.
 * Permits transitions on both initial runs and retries.
 */
const PIPELINE_TRANSITIONS = Object.freeze({
  [STAGES.FETCH]: Object.freeze({
    pending: Object.freeze(['fetched', 'failed']),
    fetched: Object.freeze([]),
    failed: Object.freeze(['pending', 'processing', 'fetched']) // retry path
  }),
  [STAGES.ATTACHMENTS]: Object.freeze({
    pending: Object.freeze(['processing', 'extracted', 'partial', 'failed']),
    processing: Object.freeze(['extracted', 'partial', 'failed']),
    extracted: Object.freeze([]),
    partial: Object.freeze([]),
    failed: Object.freeze(['pending', 'processing', 'extracted', 'partial']) // retry path
  }),
  [STAGES.AI]: Object.freeze({
    pending: Object.freeze(['processing', 'classified', 'needs_review', 'failed']),
    processing: Object.freeze(['classified', 'needs_review', 'failed']),
    classified: Object.freeze(['needs_review']), // human re-review
    needs_review: Object.freeze(['classified']), // human resolved
    failed: Object.freeze(['pending', 'processing', 'classified', 'needs_review']) // retry path
  }),
  [STAGES.TICKET]: Object.freeze({
    pending: Object.freeze(['linked', 'created', 'merged', 'failed']),
    linked: Object.freeze([]),
    created: Object.freeze(['merged']),
    merged: Object.freeze([]),
    failed: Object.freeze(['pending', 'processing', 'created', 'linked', 'merged']) // retry path
  }),
  [STAGES.SHEETS]: Object.freeze({
    pending: Object.freeze(['synced', 'failed', 'exhausted']),
    synced: Object.freeze([]),
    failed: Object.freeze(['pending', 'processing', 'synced', 'exhausted']), // retry path to synced
    exhausted: Object.freeze(['pending', 'processing', 'synced']) // admin retry path
  })
});

/**
 * Check if a job state transition is valid.
 */
function isValidJobTransition(fromState, toState) {
  if (fromState === toState) return true; // idempotent self-transition
  const allowed = JOB_STATE_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.includes(toState));
}

/**
 * Throw if a job transition is invalid.
 */
function assertValidJobTransition(fromState, toState) {
  if (!isValidJobTransition(fromState, toState)) {
    const err = new Error(`Invalid job state transition from '${fromState}' to '${toState}'`);
    err.code = 'INVALID_STATE_TRANSITION';
    err.fromState = fromState;
    err.toState = toState;
    throw err;
  }
}

/**
 * Check if a pipeline stage transition is valid.
 */
function isValidPipelineTransition(stage, fromStatus, toStatus) {
  if (fromStatus === toStatus) return true; // idempotent
  const stageMap = PIPELINE_TRANSITIONS[stage];
  if (!stageMap) return false;
  const allowed = stageMap[fromStatus];
  return Boolean(allowed && allowed.includes(toStatus));
}

/**
 * Throw if a pipeline stage transition is invalid.
 */
function assertValidPipelineTransition(stage, fromStatus, toStatus) {
  if (!isValidPipelineTransition(stage, fromStatus, toStatus)) {
    const err = new Error(`Invalid pipeline transition in stage '${stage}' from '${fromStatus}' to '${toStatus}'`);
    err.code = 'INVALID_PIPELINE_TRANSITION';
    err.stage = stage;
    err.fromStatus = fromStatus;
    err.toStatus = toStatus;
    throw err;
  }
}

/**
 * Derive overall email pipeline state from individual stage states.
 * Returns one of: 'received', 'processing', 'needs_review', 'completed', 'failed'.
 */
function deriveOverallPipelineState(pipeline = {}, hasAttachments = false) {
  const fetch = pipeline.fetch || 'pending';
  const attachments = pipeline.attachments || 'pending';
  const ai = pipeline.ai || 'pending';
  const ticket = pipeline.ticket || 'pending';
  const sheets = pipeline.sheets || 'pending';

  // Fatal email-level failures
  if (fetch === 'failed' || ticket === 'failed' || sheets === 'exhausted') {
    return 'failed';
  }

  // Attachments failure: if attachments failed completely, email still exists but needs review
  if (hasAttachments && attachments === 'failed') {
    return 'needs_review';
  }

  // Needs review from AI stage or failed AI stage
  if (ai === 'needs_review' || ai === 'failed') {
    return 'needs_review';
  }

  // Completed if all active stages reached terminal success
  const fetchDone = fetch === 'fetched';
  const attachmentsDone = !hasAttachments || ['extracted', 'partial'].includes(attachments);
  const aiDone = ai === 'classified';
  const ticketDone = ['created', 'linked', 'merged'].includes(ticket);
  const sheetsDone = sheets === 'synced';

  if (fetchDone && attachmentsDone && aiDone && ticketDone && sheetsDone) {
    return 'completed';
  }

  // Processing if active work underway or partial progress
  const activeProcessing = [fetch, attachments, ai, ticket, sheets].some((s) => s === 'processing');
  if (activeProcessing || fetchDone) {
    return 'processing';
  }

  return 'received';
}

module.exports = {
  JOB_STATE_TRANSITIONS,
  PIPELINE_TRANSITIONS,
  isValidJobTransition,
  assertValidJobTransition,
  isValidPipelineTransition,
  assertValidPipelineTransition,
  deriveOverallPipelineState
};
