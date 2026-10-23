const mongoose = require('mongoose');

const iitCounsellingVisitSchema = new mongoose.Schema({
  pageKey: {
    type: String,
    default: 'iitCounselling',
    index: true,
  },
  visitedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  visitorFingerprint: {
    type: String,
    trim: true,
    index: true,
  },
  ip: {
    type: String,
    trim: true,
    maxlength: 120,
  },
  userAgent: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  referrer: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  path: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  query: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  utm_source: { type: String, trim: true, maxlength: 200 },
  utm_medium: { type: String, trim: true, maxlength: 200 },
  utm_campaign: { type: String, trim: true, maxlength: 200 },
  utm_content: { type: String, trim: true, maxlength: 200 },
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IitCounsellingSubmission',
    default: null,
  },
  oneOnOneCounselingLeadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OneOnOneCounselingLead',
    default: null,
  },
  jeeMainMockTestLeadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JeeMainMockTestLead',
    default: null,
  },
  phone: {
    type: String,
    trim: true,
    match: [/^\d{10}$/, 'Phone must be 10 digits'],
  },
}, { versionKey: false });

iitCounsellingVisitSchema.index({ pageKey: 1, visitedAt: -1 });
iitCounsellingVisitSchema.index({ visitorFingerprint: 1, visitedAt: -1 });

module.exports = mongoose.model('IitCounsellingVisit', iitCounsellingVisitSchema);
