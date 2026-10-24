'use strict';

const mongoose = require('mongoose');

const crmSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    csrfToken: { type: String, required: true },
    sessionVersion: { type: Number, required: true },
    remember: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    ip: { type: String, default: null, maxlength: 80 },
    userAgent: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: true, collection: 'crmSessions' }
);

// Presence reads unexpired sessions for a page of users. History sorts one user's sessions.
crmSessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });
crmSessionSchema.index({ userId: 1, createdAt: -1 });
crmSessionSchema.index({ userId: 1, lastSeenAt: -1 });

module.exports = mongoose.model('CrmSession', crmSessionSchema);
