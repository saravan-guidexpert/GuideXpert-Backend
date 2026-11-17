'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    mobile: { type: String, required: true, trim: true, match: /^[6-9]\d{9}$/ },
    studentName: { type: String, trim: true, maxlength: 160, default: '' },
    eligibility: { type: String, trim: true, maxlength: 40, default: '' },
    attemptStatus: { type: String, trim: true, maxlength: 20, default: '' },
    overallObtained: { type: Number, default: null },
    overallTotal: { type: Number, default: null },
    viewCount: { type: Number, default: 0 },
    firstViewedAt: { type: Date, default: null },
    lastViewedAt: { type: Date, default: null },
    downloadCount: { type: Number, default: 0 },
    firstDownloadedAt: { type: Date, default: null },
    lastDownloadedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ mobile: 1 }, { unique: true });
schema.index({ lastViewedAt: -1 });
schema.index({ lastDownloadedAt: -1 });

module.exports = mongoose.model('JeeMockTestResultActivity', schema);
