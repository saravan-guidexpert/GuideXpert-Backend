'use strict';

const mongoose = require('mongoose');

const supportEmailAuditLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    action: {
      type: String,
      required: true,
      trim: true
    },
    targetType: {
      type: String,
      required: true,
      trim: true
    },
    targetId: {
      type: String,
      required: true,
      trim: true
    },
    ip: {
      type: String,
      trim: true,
      default: null
    },
    userAgent: {
      type: String,
      trim: true,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

// Indexes declared according to Appendix A
supportEmailAuditLogSchema.index({ createdAt: -1 });
supportEmailAuditLogSchema.index({ action: 1, createdAt: -1 });
supportEmailAuditLogSchema.index({ targetId: 1, createdAt: -1 });
supportEmailAuditLogSchema.index({ action: 1, targetType: 1, targetId: 1 });

module.exports = mongoose.model('SupportEmailAuditLog', supportEmailAuditLogSchema);
