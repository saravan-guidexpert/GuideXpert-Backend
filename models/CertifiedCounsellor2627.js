const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    mobileNumber: { type: String, required: true, trim: true, match: /^\d{10}$/ },
    whatsappNumber: { type: String, required: true, trim: true, match: /^\d{10}$/ },
    email: { type: String, required: true, trim: true, lowercase: true },
    addressOfCommunication: { type: String, required: true, trim: true, minlength: 10, maxlength: 500 },
    occupation: { type: String, required: true, trim: true, maxlength: 200 },
    dateOfBirth: { type: Date, required: true },
    gender: { type: String, required: true, enum: ['Male', 'Female'] },
    educationQualification: { type: String, required: true, trim: true, maxlength: 200 },
    yearsOfExperience: { type: Number, required: true, min: 0, max: 50 },
    anythingToConvey: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);

schema.index({ createdAt: -1 });
schema.index({ mobileNumber: 1 }, { unique: true });
schema.index({ whatsappNumber: 1 }, { unique: true });

module.exports = mongoose.model('CertifiedCounsellor2627', schema, 'certified_counsellors_26_27');
