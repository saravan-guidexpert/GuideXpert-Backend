'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    mobile: { type: String, required: true, match: /^[6-9]\d{9}$/ },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('JeeMockTestResultSession', schema);
