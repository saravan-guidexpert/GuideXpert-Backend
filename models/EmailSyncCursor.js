'use strict';

const mongoose = require('mongoose');

const emailSyncCursorSchema = new mongoose.Schema(
  {
    mailbox: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    folder: {
      type: String,
      required: true,
      trim: true,
      default: 'inbox'
    },
    deltaLink: {
      type: String,
      default: null
    },
    lastSuccessfulSyncAt: {
      type: Date,
      default: null
    },
    activationAt: {
      type: Date,
      default: null
    },
    baselineCompletedAt: {
      type: Date,
      default: null
    },
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'failed'],
      default: 'idle'
    },
    // Durable dirty flag / pending sync marker for coalescing collection-level notifications
    hasPendingSync: {
      type: Boolean,
      default: false
    },
    // Monotonic request version counter for race-free concurrency
    syncRequestVersion: {
      type: Number,
      default: 0
    },
    lastSyncedVersion: {
      type: Number,
      default: 0
    },
    lastSyncRequestedAt: {
      type: Date,
      default: null
    },
    lastSyncStartedAt: {
      type: Date,
      default: null
    },
    // Concurrency lock token and crash recovery lease
    syncLockToken: {
      type: String,
      default: null
    },
    syncLeaseExpiresAt: {
      type: Date,
      default: null
    },
    error: {
      type: String,
      trim: true,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A + sync lock recovery + pending dispatch
emailSyncCursorSchema.index({ mailbox: 1, folder: 1 }, { unique: true });
emailSyncCursorSchema.index({ syncStatus: 1, syncLeaseExpiresAt: 1 });
emailSyncCursorSchema.index({ hasPendingSync: 1, syncStatus: 1, syncLeaseExpiresAt: 1 });

module.exports = mongoose.model('EmailSyncCursor', emailSyncCursorSchema);
