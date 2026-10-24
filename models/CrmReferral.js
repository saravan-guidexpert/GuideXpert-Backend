'use strict';

const mongoose = require('mongoose');

const crmReferralSchema = new mongoose.Schema(
  {
    crmStudentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CrmStudent',
      required: true,
    },
    consultancyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CrmConsultancy',
      required: true,
    },
    consultancyContactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CrmConsultancyContact',
      default: null,
    },
    consultancyNameSnapshot: { type: String, required: true, trim: true, maxlength: 200 },
    contactNameSnapshot: { type: String, default: '', trim: true, maxlength: 200 },
    originalConsultancyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CrmConsultancy',
      required: true,
    },
    originalConsultancyName: { type: String, required: true, trim: true, maxlength: 200 },
    originalContactName: { type: String, default: '', trim: true, maxlength: 200 },
    referredAt: { type: Date, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    sourceCorrectedAt: { type: Date, default: null },
    sourceCorrectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    sourceCorrectionReason: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true, collection: 'crmReferrals' }
);

/** One original attribution per student. Corrections update this row; they do not insert another. */
crmReferralSchema.index({ crmStudentId: 1 }, { unique: true });
crmReferralSchema.index({ consultancyId: 1, createdAt: -1 });
crmReferralSchema.index({ referredAt: 1 });
crmReferralSchema.index({ consultancyId: 1, referredAt: -1 });

module.exports = mongoose.model('CrmReferral', crmReferralSchema);
