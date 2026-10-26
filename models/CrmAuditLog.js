'use strict';

const mongoose = require('mongoose');

const crmAuditLogSchema = new mongoose.Schema(
  {
    actorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
    actorCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
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

crmAuditLogSchema.pre('validate', function validateAuditActor() {
  if (!this.actorAdminId && !this.actorCrmUserId) {
    this.invalidate('actorAdminId', 'CRM audit requires an actor.');
  }
});

crmAuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
crmAuditLogSchema.index({ actorCrmUserId: 1, createdAt: -1 });
crmAuditLogSchema.index({ actorAdminId: 1, createdAt: -1 });
// Activity pages always sort by time. Actor and entity indexes do not serve that sort.
crmAuditLogSchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.model('CrmAuditLog', crmAuditLogSchema);
