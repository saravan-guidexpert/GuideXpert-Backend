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
      default: false
    },
    description: {
      type: String,
      trim: true,
      default: null
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    activationApprovedAt: {
      type: Date,
      default: null
    },
    activationApprovedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    activationTimeZone: {
      type: String,
      trim: true,
      default: 'Asia/Kolkata'
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
emailIngestionPolicySchema.index({ mailbox: 1 }, { unique: true });

module.exports = mongoose.model('EmailIngestionPolicy', emailIngestionPolicySchema);
