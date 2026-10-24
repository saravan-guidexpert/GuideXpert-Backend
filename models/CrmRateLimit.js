'use strict';

const mongoose = require('mongoose');

const crmRateLimitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    windowStart: { type: Date, required: true },
    count: { type: Number, required: true },
  },
  { collection: 'crmRateLimits' }
);

module.exports = mongoose.model('CrmRateLimit', crmRateLimitSchema);
