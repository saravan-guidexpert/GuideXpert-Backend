'use strict';

const mongoose = require('mongoose');
const { CONSULTANCY_FOLLOW_UP_STATUSES, REMARK_MAX } = require('../constants/crm');

const crmConsultancyFollowUpSchema = new mongoose.Schema(
  {
    consultancyId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmConsultancy', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmConsultancyContact', default: null },
    type: { type: String, enum: ['call', 'follow_up'], required: true },
    status: { type: String, enum: CONSULTANCY_FOLLOW_UP_STATUSES, required: true },
    scheduledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    completedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    completedByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    cancelledByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    cancelledByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    outcome: { type: String, default: '', maxlength: 160 },
    nextAction: { type: String, default: '', maxlength: 160 },
    reason: { type: String, default: '', maxlength: REMARK_MAX },
    notes: { type: String, default: '', maxlength: REMARK_MAX },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    actorName: { type: String, required: true, trim: true, maxlength: 200 },
  },
  { timestamps: true, collection: 'crmConsultancyFollowUps' }
);

crmConsultancyFollowUpSchema.pre('validate', function validateFollowUpActor() {
  if (!this.createdByAdminId && !this.createdByCrmUserId) {
    this.invalidate('createdByAdminId', 'A follow-up requires an actor.');
  }
});

crmConsultancyFollowUpSchema.index({ consultancyId: 1, createdAt: -1 });
crmConsultancyFollowUpSchema.index({ consultancyId: 1, scheduledAt: 1 });

module.exports = mongoose.model('CrmConsultancyFollowUp', crmConsultancyFollowUpSchema);
