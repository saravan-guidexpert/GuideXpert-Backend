'use strict';

const mongoose = require('mongoose');
const { REMARK_MAX } = require('../constants/crm');

const historySchema = new mongoose.Schema(
  {
    text: { type: String, required: true, maxlength: REMARK_MAX },
    updatedAt: { type: Date, required: true },
  },
  { _id: false }
);

const crmConsultancyRemarkSchema = new mongoose.Schema(
  {
    consultancyId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmConsultancy', required: true },
    text: { type: String, required: true, maxlength: REMARK_MAX },
    authorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    authorCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    authorName: { type: String, required: true, trim: true, maxlength: 200 },
    previousText: { type: String, default: null, maxlength: REMARK_MAX },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, collection: 'crmConsultancyRemarks' }
);

crmConsultancyRemarkSchema.pre('validate', function validateRemarkAuthor() {
  if (!this.authorAdminId && !this.authorCrmUserId) {
    this.invalidate('authorAdminId', 'A remark requires an author.');
  }
});

crmConsultancyRemarkSchema.index({ consultancyId: 1, createdAt: -1 });

module.exports = mongoose.model('CrmConsultancyRemark', crmConsultancyRemarkSchema);
