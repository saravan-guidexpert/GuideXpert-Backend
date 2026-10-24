const mongoose = require('mongoose');

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

const CURRENT_STUDYING_OPTIONS = [
  'Inter 2nd Year Completed',
  '10th',
  'Inter 1st Year',
  'Inter 2nd Year',
  'Diploma',
  'Other',
];

const schema = new mongoose.Schema(
  {
    studentName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    mobileNumber: { type: String, required: true, trim: true, match: INDIAN_MOBILE_REGEX },
    whatsappNumber: { type: String, trim: true, match: INDIAN_MOBILE_REGEX },
    currentStudying: { type: String, enum: CURRENT_STUDYING_OPTIONS },
    collegeName: { type: String, trim: true, minlength: 2, maxlength: 150 },
    location: { type: String, trim: true, minlength: 2, maxlength: 120 },
    remarks: { type: String, trim: true, maxlength: 2000, default: '' },
    formCompleted: { type: Boolean, default: false, index: true },
    currentStep: { type: Number, default: 1 },
    otpVerified: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
    visitorFingerprint: { type: String, trim: true, maxlength: 200 },
    utm_source: { type: String, trim: true, maxlength: 200 },
    utm_medium: { type: String, trim: true, maxlength: 200 },
    utm_campaign: { type: String, trim: true, maxlength: 200 },
    utm_content: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true }
);

schema.index({ createdAt: -1 });
schema.index({ mobileNumber: 1 }, { unique: true });

module.exports = mongoose.model('JeeMainMockTestLead', schema);
module.exports.CURRENT_STUDYING_OPTIONS = CURRENT_STUDYING_OPTIONS;
