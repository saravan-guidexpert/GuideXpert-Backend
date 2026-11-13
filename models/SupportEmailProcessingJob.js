'use strict';

const mongoose = require('mongoose');
const {
  PROCESSING_STAGES,
  ALL_JOB_STATES,
  LIMITS
} = require('../constants/supportEmail');

const executionHistorySchema = new mongoose.Schema(
  {
    attempt: { type: Number, required: true },
    claimedAt: { type: Date, required: true },
    claimedBy: { type: String, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    error: { type: String, default: null },
    durationMs: { type: Number, default: null }
  },
  { _id: false }
);

const supportEmailProcessingJobSchema = new mongoose.Schema(
  {
    emailId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportEmail',
      required: true
    },
    stage: {
      type: String,
      enum: PROCESSING_STAGES,
      required: true
    },
    state: {
      type: String,
      enum: ALL_JOB_STATES,
      default: 'pending'
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    },
    maxAttempts: {
      type: Number,
      default: LIMITS.DEFAULT_MAX_ATTEMPTS,
      min: 1
    },
    nextAttemptAt: {
      type: Date,
      default: Date.now
    },
    leaseExpiresAt: {
      type: Date,
      default: null
    },
    claimedAt: {
      type: Date,
      default: null
    },
    claimedBy: {
      type: String,
      trim: true,
      default: null
    },
    claimToken: {
      type: String,
      trim: true,
      default: null
    },
    lastError: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: null
    },
    priority: {
      type: Number,
      default: 0
    },
    completedAt: {
      type: Date,
      default: null
    },
    deadLetterAt: {
      type: Date,
      default: null
    },
    deadLetterReason: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null
    },
    executionHistory: {
      type: [executionHistorySchema],
      default: []
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
supportEmailProcessingJobSchema.index({ emailId: 1, stage: 1 }, { unique: true });
supportEmailProcessingJobSchema.index({ state: 1, nextAttemptAt: 1, priority: -1 });
supportEmailProcessingJobSchema.index({ leaseExpiresAt: 1 });

module.exports = mongoose.model('SupportEmailProcessingJob', supportEmailProcessingJobSchema);
