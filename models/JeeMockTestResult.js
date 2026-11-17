'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    mobile: { type: String, required: true, trim: true, match: /^[6-9]\d{9}$/ },
    email: { type: String, trim: true, maxlength: 200, default: '' },
    invitedOn: { type: Date, required: true },
    attemptStatus: { type: String, required: true, enum: ['ATTEMPTED', 'NOT_ATTEMPTED'] },
    overallTotalScore: { type: Number, default: null },
    overallCandidateScore: { type: Number, default: null },
    overallDuration: { type: Number, default: null },
    overallCandidateDuration: { type: Number, default: null },
    mcqMaxScore: { type: Number, default: null },
    mcqUserScore: { type: Number, default: null },
    mcqAttemptDuration: { type: Number, default: null },
    numericalMaxScore: { type: Number, default: null },
    numericalUserScore: { type: Number, default: null },
    numericalAttemptDuration: { type: Number, default: null },
  },
  { timestamps: true }
);

schema.index({ mobile: 1 }, { unique: true });

module.exports = mongoose.model('JeeMockTestResult', schema);
