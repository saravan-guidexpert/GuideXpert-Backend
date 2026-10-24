'use strict';

const mongoose = require('mongoose');

const crmConsultancyAssignmentSchema = new mongoose.Schema(
  {
    consultancyId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmConsultancy', required: true },
    crmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    revokedAt: { type: Date, default: null },
    revokedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    revokedByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
  },
  { timestamps: true, collection: 'crmConsultancyAssignments' }
);

crmConsultancyAssignmentSchema.index(
  { consultancyId: 1, crmUserId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } }
);
crmConsultancyAssignmentSchema.index({ crmUserId: 1, revokedAt: 1 });
crmConsultancyAssignmentSchema.index({ consultancyId: 1, revokedAt: 1 });

module.exports = mongoose.model('CrmConsultancyAssignment', crmConsultancyAssignmentSchema);
