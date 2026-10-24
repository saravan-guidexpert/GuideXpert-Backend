'use strict';

const mongoose = require('mongoose');
const { CONTACT_STATUS } = require('../constants/crm');

const crmConsultancyContactSchema = new mongoose.Schema(
  {
    consultancyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CrmConsultancy',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, default: null, maxlength: 10 },
    email: { type: String, default: null, maxlength: 200 },
    role: { type: String, trim: true, default: '', maxlength: 80 },
    status: { type: String, enum: CONTACT_STATUS, default: 'active', index: true },
    deactivatedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true, collection: 'crmConsultancyContacts' }
);

crmConsultancyContactSchema.index(
  { consultancyId: 1, phone: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active', phone: { $type: 'string' } },
  }
);
crmConsultancyContactSchema.index({ consultancyId: 1, status: 1, name: 1 });

module.exports = mongoose.model('CrmConsultancyContact', crmConsultancyContactSchema);
