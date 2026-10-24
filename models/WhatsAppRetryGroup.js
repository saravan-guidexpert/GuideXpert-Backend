const mongoose = require('mongoose');

/** Idempotency headers for WA retry promotions (attempt 2 = first retry slice, attempt 3 = second). */
const whatsAppRetryGroupSchema = new mongoose.Schema({
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
      'guidance_pre30min',
      'guidance_counsellor_booking_notify',
      'jee_mock_test_submit',
    ],
    index: true
  },
  cronRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessagingCronRun', default: null, index: true },
  trigger: {
    type: String,
    enum: [
      'cron',
      'save_step3',
      'manual',
      'retry_api',
      'scheduled_job',
      'one_on_one_submit',
      'guidance_booking_submit',
      'guidance_counsellor_booking_notify',
      'jee_mock_test_submit',
    ],
    default: 'cron',
    index: true
  },
  /** IST calendar date YYYY-MM-DD for rollup (optional). */
  istAnchorDate: { type: String, trim: true, maxlength: 10, default: null },
  attempt2BatchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  attempt2TriggeredAt: { type: Date, default: null },
  attempt3BatchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  attempt3TriggeredAt: { type: Date, default: null },
  /** When attempt-1 batch promotion finished (all sends attempted for attempt 2 trigger) */
  attempt1CompletedAt: { type: Date, default: null },
  /** When attempt-2 batch promotion finished */
  attempt2CompletedAt: { type: Date, default: null },
  /** Earliest time the next promotion sweep may target this group (UI countdown) */
  nextPromotionDueAt: { type: Date, default: null, index: true },
  /** Manual recovery continuation from an exhausted/open group */
  continuedFromGroupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppRetryGroup',
    default: null,
    index: true
  },
  status: {
    type: String,
    enum: ['open', 'closed_no_more_retries', 'exhausted'],
    default: 'open',
    index: true
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

whatsAppRetryGroupSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

whatsAppRetryGroupSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WhatsAppRetryGroup', whatsAppRetryGroupSchema);
