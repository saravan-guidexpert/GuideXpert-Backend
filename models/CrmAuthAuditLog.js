'use strict';

const mongoose = require('mongoose');

const crmAuthAuditLogSchema = new mongoose.Schema(
  {
    actorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
    actorCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null, index: true },
    action: { type: String, required: true, trim: true, maxlength: 80 },
    reason: { type: String, default: '', maxlength: 500 },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null, maxlength: 80 },
    userAgent: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'crmAuthAuditLogs' }
);

crmAuthAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });
// Activity pages sort security events by time. The target-user index does not serve that sort.
crmAuthAuditLogSchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.model('CrmAuthAuditLog', crmAuthAuditLogSchema);
