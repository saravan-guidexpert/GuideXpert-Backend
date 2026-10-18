'use strict';

const mongoose = require('mongoose');

const crmAuditLogSchema = new mongoose.Schema(
  {
    actorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    action: { type: String, required: true, trim: true, maxlength: 80 },
    entityType: { type: String, required: true, trim: true, maxlength: 40 },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    reason: { type: String, default: '', maxlength: 500 },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null, maxlength: 80 },
    userAgent: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: true, collection: 'crmAuditLogs' }
);

crmAuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
crmAuditLogSchema.index({ actorAdminId: 1, createdAt: -1 });

module.exports = mongoose.model('CrmAuditLog', crmAuditLogSchema);
