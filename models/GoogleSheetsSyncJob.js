'use strict';

const mongoose = require('mongoose');
const {
  SHEETS_SYNC_STATES,
  LIMITS
} = require('../constants/supportEmail');

const googleSheetsSyncJobSchema = new mongoose.Schema(
  {
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportTicket',
      required: true
    },
    spreadsheetId: {
      type: String,
      required: true,
      trim: true
    },
    tab: {
      type: String,
      required: true,
      trim: true
    },
    rowHash: {
      type: String,
      trim: true,
      default: null
    },
    state: {
      type: String,
      enum: SHEETS_SYNC_STATES,
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
    rowNumber: {
      type: Number,
      default: null
    },
    lastError: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null
    },
    syncedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
googleSheetsSyncJobSchema.index(
  { ticketId: 1, spreadsheetId: 1, tab: 1 },
  { unique: true }
);
googleSheetsSyncJobSchema.index({ state: 1, nextAttemptAt: 1 });

module.exports = mongoose.model('GoogleSheetsSyncJob', googleSheetsSyncJobSchema);
