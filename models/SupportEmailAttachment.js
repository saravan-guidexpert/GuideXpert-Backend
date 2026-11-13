'use strict';

const mongoose = require('mongoose');
const {
  ATTACHMENT_SCAN_STATUS,
  ATTACHMENT_EXTRACT_STATUS
} = require('../constants/supportEmail');

const supportEmailAttachmentSchema = new mongoose.Schema(
  {
    emailId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportEmail',
      required: true
    },
    graphAttachmentId: {
      type: String,
      required: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255
    },
    contentType: {
      type: String,
      trim: true,
      maxlength: 128,
      default: 'application/octet-stream'
    },
    size: {
      type: Number,
      required: true,
      min: 0
    },
    sha256: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null
    },
    storageKey: {
      type: String,
      trim: true,
      default: null
    },
    isInline: {
      type: Boolean,
      default: false
    },
    contentId: {
      type: String,
      trim: true,
      default: null
    },
    scanStatus: {
      type: String,
      enum: ATTACHMENT_SCAN_STATUS,
      default: 'pending'
    },
    scanMessage: {
      type: String,
      trim: true,
      default: null
    },
    extractStatus: {
      type: String,
      enum: ATTACHMENT_EXTRACT_STATUS,
      default: 'pending'
    },
    extractError: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null
    },
    extractedText: {
      type: String,
      maxlength: 500000,
      default: null
    },
    pageCount: {
      type: Number,
      default: null,
      min: 0
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
supportEmailAttachmentSchema.index({ emailId: 1, graphAttachmentId: 1 }, { unique: true });
supportEmailAttachmentSchema.index({ emailId: 1, isInline: 1 });
supportEmailAttachmentSchema.index({ sha256: 1 });

module.exports = mongoose.model('SupportEmailAttachment', supportEmailAttachmentSchema);
