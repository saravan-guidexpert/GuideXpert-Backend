const mongoose = require('mongoose');

const countersSchema = new mongoose.Schema(
  {
    targeted: { type: Number, default: 0 },
    attempted: { type: Number, default: 0 },
    apiAccepted: { type: Number, default: 0 },
    sendFailed: { type: Number, default: 0 },
    skippedAlreadyDelivered: { type: Number, default: 0 },
    skippedGlobalRecentSuccess: { type: Number, default: 0 },
    skippedInFlightDuplicate: { type: Number, default: 0 },
    skippedPermanent: { type: Number, default: 0 },
    excluded: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    /** Phones whose post-start row reached delivered/read (live recovery counter). */
    recovered: { type: Number, default: 0 },
    /** Phones with submitted/sent post-start row, not yet delivered or terminal. */
    inFlight: { type: Number, default: 0 }
  },
  { _id: false }
);

const candidateLineageEntrySchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, match: [/^\d{10}$/, '10-digit phone'] },
    lineageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastEventId: { type: mongoose.Schema.Types.ObjectId, default: null },
    maxAttemptAtStart: { type: Number, default: 1 },
    candidateCreatedAt: { type: Date, default: null },
    iitCounsellingSubmissionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    formSubmissionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

/**
 * Admin-driven manual recovery batch for unresolved recipients of a single template.
 * Reuses safeSendWhatsApp (source: admin_manual). Does not change retry orchestrator.
 */
const whatsAppManualRecoveryJobSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true
  },
  messageKind: {
    type: String,
    required: true,
    enum: [
      'slot_booked',
      'pre4hr',
      'meet',
      '30min',
      'iit_pre2hr',
      'iit_pre45min',
      'iit_pre15min',
      'one_on_one_submit',
      'guidance_booking_submit',
      'guidance_counsellor_booking_notify',
      'jee_mock_test_submit',
    ],
    index: true
  },
  opsProduct: {
    type: String,
    enum: ['guidexpert', 'iit_counselling', 'one_on_one_counseling', 'guidance_booking', 'jee_mock_test'],
    default: 'guidexpert',
    index: true,
  },
  preferredLanguage: { type: String, trim: true, default: null },
  /** UI filter window applied when computing candidates */
  fromAt: { type: Date, default: null },
  toAt: { type: Date, default: null },
  /** Lookback used to skip phones with recent delivered/read same kind */
  globalSuccessLookbackDays: { type: Number, default: 7 },
  /** Single WhatsAppRetryGroup for all sends in this recovery batch */
  batchRetryGroupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppRetryGroup',
    default: null,
    index: true
  },
  /** Phones targeted by this job (same order as preview filter) */
  candidatePhones: { type: [String], default: [] },
  /** Snapshot of lineage per phone for execute parity with preview (max 500 entries) */
  candidateLineage: { type: [candidateLineageEntrySchema], default: [] },
  createdBy: { type: String, trim: true, maxlength: 100, default: null },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  lastProgressAt: { type: Date, default: Date.now },
  cancelRequested: { type: Boolean, default: false },
  counters: { type: countersSchema, default: () => ({}) },
  errorSummary: { type: String, maxlength: 2000, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

whatsAppManualRecoveryJobSchema.index({ createdAt: -1 });
whatsAppManualRecoveryJobSchema.index({ messageKind: 1, createdAt: -1 });

whatsAppManualRecoveryJobSchema.pre('save', function () {
  this.updatedAt = Date.now();
});

module.exports = mongoose.model('WhatsAppManualRecoveryJob', whatsAppManualRecoveryJobSchema);
