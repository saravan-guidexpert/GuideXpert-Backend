'use strict';

const mongoose = require('mongoose');

const crmPasswordResetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['reset', 'invite'], required: true },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
  },
  { timestamps: true, collection: 'crmPasswordResets' }
);

module.exports = mongoose.model('CrmPasswordReset', crmPasswordResetSchema);
