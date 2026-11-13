'use strict';

/**
 * Support Email Automation Constants and Enums
 *
 * System of record: MongoDB
 * Stages, job states, lifecycle pipelines, and operational limits.
 */

const STAGES = Object.freeze({
  FETCH: 'fetch',
  ATTACHMENTS: 'attachments',
  AI: 'ai',
  TICKET: 'ticket',
  SHEETS: 'sheets'
});

const PROCESSING_STAGES = Object.freeze(Object.values(STAGES));

const JOB_STATES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
  CANCELLED: 'cancelled'
});

const ALL_JOB_STATES = Object.freeze(Object.values(JOB_STATES));

const STAGE_STATES = Object.freeze({
  [STAGES.FETCH]: Object.freeze(['pending', 'fetched', 'failed']),
  [STAGES.ATTACHMENTS]: Object.freeze(['pending', 'processing', 'extracted', 'partial', 'failed']),
  [STAGES.AI]: Object.freeze(['pending', 'processing', 'classified', 'needs_review', 'failed']),
  [STAGES.TICKET]: Object.freeze(['pending', 'linked', 'created', 'merged', 'failed']),
  [STAGES.SHEETS]: Object.freeze(['pending', 'synced', 'failed', 'exhausted'])
});

const EMAIL_PIPELINE_STATES = Object.freeze([
  'received',
  'processing',
  'needs_review',
  'completed',
  'failed'
]);

const ATTACHMENT_SCAN_STATUS = Object.freeze([
  'pending',
  'clean',
  'flagged',
  'failed',
  'skipped'
]);

const ATTACHMENT_EXTRACT_STATUS = Object.freeze([
  'pending',
  'processing',
  'extracted',
  'partial',
  'unsupported',
  'corrupted',
  'skipped',
  'failed'
]);

const TICKET_CATEGORIES = Object.freeze([
  'admissions',
  'counselling',
  'technical',
  'billing',
  'feedback',
  'general',
  'other'
]);

const TICKET_PRIORITIES = Object.freeze([
  'low',
  'medium',
  'high',
  'urgent'
]);

const TICKET_STATUSES = Object.freeze([
  'open',
  'in_progress',
  'waiting_on_student',
  'resolved',
  'closed',
  'merged'
]);

const TICKET_SENTIMENTS = Object.freeze([
  'positive',
  'neutral',
  'negative',
  'frustrated',
  'urgent'
]);

const TICKET_EVENT_TYPES = Object.freeze([
  'created',
  'linked_email',
  'status_changed',
  'assigned',
  'category_changed',
  'priority_changed',
  'comment_added',
  'merged',
  'sheets_synced'
]);

const ACTOR_TYPES = Object.freeze([
  'system',
  'ai',
  'admin',
  'student'
]);

const WEBHOOK_STATUSES = Object.freeze([
  'received',
  'processed',
  'duplicate',
  'ignored',
  'failed'
]);

const SUBSCRIPTION_STATUSES = Object.freeze([
  'active',
  'expired',
  'failed',
  'deleted'
]);

const SHEETS_SYNC_STATES = Object.freeze([
  'pending',
  'claimed',
  'processing',
  'synced',
  'failed',
  'exhausted',
  'cancelled'
]);

const AI_RUN_OUTCOMES = Object.freeze([
  'success',
  'needs_review',
  'failed'
]);

// Operational limits and timing defaults
const LIMITS = Object.freeze({
  DEFAULT_BATCH_SIZE: 25,
  DEFAULT_TIME_BUDGET_MS: 45000,
  DEFAULT_STALE_LEASE_MS: 120000, // 2 minutes
  DEFAULT_MAX_ATTEMPTS: 5,
  STAGE_MAX_ATTEMPTS: Object.freeze({
    [STAGES.FETCH]: 6,
    [STAGES.ATTACHMENTS]: 5,
    [STAGES.AI]: 4,
    [STAGES.TICKET]: 5,
    [STAGES.SHEETS]: 5
  }),
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024, // 10 MB per attachment
  MAX_MESSAGE_ATTACHMENT_BYTES: 25 * 1024 * 1024, // 25 MB total attachments
  MAX_PDF_PAGES: 30,
  MAX_BODY_TEXT_LENGTH: 100000, // 100 KB bounded text
  MAX_BODY_HTML_SNIPPET_LENGTH: 20000, // 20 KB bounded snippet
  DEFAULT_CONFIDENCE_THRESHOLD: 0.80
});

module.exports = {
  STAGES,
  PROCESSING_STAGES,
  JOB_STATES,
  ALL_JOB_STATES,
  STAGE_STATES,
  EMAIL_PIPELINE_STATES,
  ATTACHMENT_SCAN_STATUS,
  ATTACHMENT_EXTRACT_STATUS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SENTIMENTS,
  TICKET_EVENT_TYPES,
  ACTOR_TYPES,
  WEBHOOK_STATUSES,
  SUBSCRIPTION_STATUSES,
  SHEETS_SYNC_STATES,
  AI_RUN_OUTCOMES,
  LIMITS
};

