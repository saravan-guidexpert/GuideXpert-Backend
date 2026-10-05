const mongoose = require('mongoose');

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    contactNumber: { type: String, required: true, trim: true, match: INDIAN_MOBILE_REGEX },
    whatsappNumber: { type: String, trim: true, match: INDIAN_MOBILE_REGEX },
    collegeName: { type: String, trim: true, minlength: 2, maxlength: 150 },
    address: { type: String, trim: true, minlength: 2, maxlength: 160 },
    remarks: { type: String, trim: true, maxlength: 2000, default: '' },
    formCompleted: { type: Boolean, default: false, index: true },
    currentStep: { type: Number, default: 1 },
    otpVerified: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ createdAt: -1 });
schema.index(
  { contactNumber: 1 },
  { unique: true, partialFilterExpression: { formCompleted: false } }
);

module.exports = mongoose.model('MockTestLead', schema);
