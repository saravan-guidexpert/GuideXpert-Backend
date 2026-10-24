'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { CRM_ACCOUNT_STATUSES, CRM_PERMISSIONS, CRM_ROLE_KEYS } = require('../constants/crmUsers');

const crmUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    username: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, default: '', select: false },
    status: { type: String, enum: CRM_ACCOUNT_STATUSES, default: 'active', index: true },
    role: { type: String, enum: CRM_ROLE_KEYS, required: true, index: true },
    permissions: { type: [{ type: String, enum: CRM_PERMISSIONS }], default: [] },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    updatedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    updatedByCrmUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    sessionVersion: { type: Number, default: 1 },
    failedLoginCount: { type: Number, default: 0 },
    failedLoginWindowStart: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'crmUsers' }
);

crmUserSchema.index({ email: 1 }, { unique: true });
crmUserSchema.index({ username: 1 }, { unique: true });
crmUserSchema.index({ deletedAt: 1, status: 1, createdAt: -1 });

crmUserSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.passwordHash);
};

module.exports = mongoose.model('CrmUser', crmUserSchema);
