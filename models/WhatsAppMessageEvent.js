const mongoose = require('mongoose');

/** Keep in sync with ops analytics filters and WhatsAppOpsOverview template chips. */
const WHATSAPP_MESSAGE_KINDS = Object.freeze([
  'slot_booked',
  'pre4hr',
  'meet',
  '30min',
  'iit_pre2hr',
  'iit_pre45min',
  'iit_pre15min',
  'one_on_one_submit',
  'guidance_booking_submit',
  'guidance_pre30min',
  'guidance_counsellor_booking_notify',
  'jee_mock_test_submit',
]);

const whatsAppMessageEventSchema = new mongoose.Schema({
  /** Batch lineage — all attempts for same cohort share one group _id */
  retryGroupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppRetryGroup',
    default: null,
    index: true
  },
  /** 1 = initial; 2–3 automated retries; 4+ reserved for admin_manual continuation */
  attemptNumber: {
    type: Number,
    required: true,
    min: 1,
    max: 6,
    default: 1,
    index: true
  },
  /** Original lineage for recipient-based analytics when retryGroupId is a new manual batch */
  canonicalRetryGroupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppRetryGroup',
    default: null,
    index: true
  },
  parentMessageEventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppMessageEvent',
    default: null,
    index: true
  },
  /** Set when attempt 2+ rows are created (same id for whole promotion trigger) */
  attemptBatchId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  retrySource: {
    type: String,
    enum: ['initial', 'retry1', 'retry2', 'manual_recovery'],
    default: 'initial'
  },
  /** Set when failure is classified non-retryable for campaigns (or transient) */
  terminalFailureKind: {
    type: String,
    enum: ['permanent', 'transient'],
    default: null,
    index: true
  },
  /** Parent attempt superseded for promotion (stale in-flight); status unchanged for monotonic safety */
  promotionSupersededAt: { type: Date, default: null, index: true },
  /** True when eligible for scheduling into the next attempt (terminal failure); false after delivered/read */
  retryEligible: { type: Boolean, default: true, index: true },
  correlationId: { type: String, trim: true, maxlength: 64, default: null, index: true },
  phone: { type: String, required: true, index: true, match: [/^\d{10}$/, '10-digit phone'] },
  formSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FormSubmission', index: true, default: null },
  /** IIT counselling linkage for cohort analytics (optional) */
  iitCounsellingSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IitCounsellingSubmission',
    default: null,
    index: true
  },
  oneOnOneCounselingLeadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OneOnOneCounselingLead',
    default: null,
    index: true
  },
  mockTestLeadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MockTestLead',
    default: null,
    index: true
  },
  /** IST booking instant for cohort tagging when FormSubmission.slotDate is unavailable (e.g. IIT product) */
  cohortSlotInstantUtc: { type: Date, default: null, index: true },
  /** Product line for WhatsApp ops Overview filtering; legacy omit → GuideXpert */
  opsProduct: {
    type: String,
    enum: ['guidexpert', 'iit_counselling', 'one_on_one_counseling', 'guidance_booking', 'jee_mock_test'],
    default: 'guidexpert',
    index: true
  },
  messageKind: {
    type: String,
    required: true,
    enum: WHATSAPP_MESSAGE_KINDS
  },
  cronRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessagingCronRun', default: null, index: true },
  cronJobKey: {
    type: String,
    default: null,
    maxlength: 64
  },
  source: {
    type: String,
    required: true,
    enum: [
      'save_step3',
      'cron',
      'retry_cron',
      'admin_manual',
      'retry_api',
      'one_on_one_submit',
      'guidance_booking_submit',
      'guidance_counsellor_booking_notify',
      'jee_mock_test_submit',
    ]
  },
  templateIdEnvKey: { type: String, trim: true, maxlength: 64, default: null },
  templateId: { type: String, trim: true, maxlength: 128, default: null },
  /** Primary id persisted at send time — prefer Gupshup UUID so DLR `gsId` matches; else WA id */
  gupshupMessageId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  gupshupInternalMessageId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  whatsappWaMessageId: { type: String, trim: true, maxlength: 256, default: null, index: true },
  providerAcceptedAt: { type: Date, default: null },
  providerPayloadSnippet: { type: String, maxlength: 1200, default: null },
  status: {
    type: String,
    required: true,
    enum: [
      'queued',
      'submitted',
      'sent',
      'awaiting_final_dlr',
      'failed',
      'delivered',
      'read',
      'retry_pending',
      'retry_exhausted'
    ],
    default: 'submitted'
  },
  retryCountSnapshot: { type: Number, default: null },
  errorMessage: { type: String, maxlength: 2000, default: null },
  /** Lease lock fields for atomic slot_booked immediate retry claims */
  immediateRetryLockToken: { type: String, trim: true, maxlength: 80, default: null, index: true },
  immediateRetryLockedAt: { type: Date, default: null },
  immediateRetryLockUntil: { type: Date, default: null, index: true },
  immediateRetryLastTriedAt: { type: Date, default: null },
  webhookErrorCode: { type: String, trim: true, maxlength: 32, default: null },
  webhookErrorReason: { type: String, trim: true, maxlength: 2000, default: null },
  /** Gupshup template send API rejection (before/at send, not DLR webhook) */
  sendErrorCode: { type: String, trim: true, maxlength: 32, default: null },
  retryExclusionReason: {
    type: String,
    enum: [
      'already_delivered_or_read',
      'duplicate_retry_prevented',
      'retry_eligibility_disabled',
      'cooldown_blocked',
      'missing_phone',
      'missing_registered_submission',
      'policy_non_retryable',
      'permanent_failure',
      'in_flight_timeout',
      'promotion_superseded',
      'outside_reminder_validity',
      'eligibility_timing_blocked',
      'dlr_failed_after_accept',
      'webhook_stale_unresolved'
    ],
    default: null,
    index: true
  },
  /** Campaign sends only: persisted eligibility audit (firstEligibleAt, deltas, flags) */
  eligibilityTiming: {
    slotInstantUtc: { type: Date, default: null },
    firstEligibleAt: { type: Date, default: null },
    actualSentAt: { type: Date, default: null },
    sentTooEarly: { type: Boolean, default: null },
    sentAfterExpiry: { type: Boolean, default: null },
    eligibilityViolationDeltaMs: { type: Number, default: null }
  },
  retryExclusionAt: { type: Date, default: null },
  retryExclusionMeta: {
    nextAttempt: { type: Number, min: 2, max: 6, default: null },
    attemptBatchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    note: { type: String, trim: true, maxlength: 200, default: null }
  },
  sentAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  readAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  /** Phase-1 reconcile: entered awaiting_final_dlr */
  reconcilePendingAt: { type: Date, default: null, index: true },
  /** Phase-2 eligible after this instant (grace window for late DLR) */
  reconcileFinalityUntil: { type: Date, default: null, index: true },
  /** Phase-2 failed set by reconcile (allows narrow late delivered override) */
  reconcileDerivedFailure: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

whatsAppMessageEventSchema.index({ createdAt: -1 });
whatsAppMessageEventSchema.index({ phone: 1, messageKind: 1, createdAt: -1 });
whatsAppMessageEventSchema.index({ messageKind: 1, createdAt: -1 });
whatsAppMessageEventSchema.index({ retryGroupId: 1, attemptNumber: 1 });
whatsAppMessageEventSchema.index({ messageKind: 1, attemptNumber: 1, retryEligible: 1, status: 1, createdAt: 1 });
whatsAppMessageEventSchema.index({ messageKind: 1, formSubmissionId: 1, createdAt: -1 });
whatsAppMessageEventSchema.index({ opsProduct: 1, messageKind: 1, createdAt: -1 });
whatsAppMessageEventSchema.index(
  { canonicalRetryGroupId: 1, attemptNumber: 1 },
  { partialFilterExpression: { canonicalRetryGroupId: { $exists: true, $type: 'objectId' } } }
);
/** One row per (group, phone, attempt); partial so legacy rows without retryGroupId are not indexed */
whatsAppMessageEventSchema.index(
  { retryGroupId: 1, phone: 1, attemptNumber: 1 },
  { unique: true, partialFilterExpression: { retryGroupId: { $exists: true, $type: 'objectId' } } }
);
whatsAppMessageEventSchema.index({ status: 1, reconcileFinalityUntil: 1 });

whatsAppMessageEventSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

module.exports = mongoose.model('WhatsAppMessageEvent', whatsAppMessageEventSchema);
module.exports.WHATSAPP_MESSAGE_KINDS = WHATSAPP_MESSAGE_KINDS;
