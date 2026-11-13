'use strict';

const mongoose = require('mongoose');

const emailIngestionPolicySchema = new mongoose.Schema(
  {
    mailbox: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    activationAt: {
      type: Date,
      required: true
    },
    baselineCompletedAt: {
      type: Date,
      default: null
    },
    enabled: {
      type: Boolean,
      default: true
    },
    description: {
      type: String,
      trim: true,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
emailIngestionPolicySchema.index({ mailbox: 1 }, { unique: true });

module.exports = mongoose.model('EmailIngestionPolicy', emailIngestionPolicySchema);
