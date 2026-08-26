const mongoose = require('mongoose');
const { PRO_FORM_ROLES, INDIA_STATES } = require('../constants/proForm');

const schema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    contactNumber: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{10}$/, 'Contact number must be 10 digits'],
    },
    alternateNumber: {
      type: String,
      trim: true,
      default: '',
    },
    cityTown: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    state: {
      type: String,
      required: true,
      enum: INDIA_STATES,
    },
    currentlyWorkingAs: {
      type: String,
      required: true,
      enum: PRO_FORM_ROLES,
    },
    associatedCollegeName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 150,
    },
  },
  { timestamps: true, collection: 'pro_form_submissions' }
);

schema.index({ createdAt: -1 });
schema.index({ contactNumber: 1 }, { unique: true });
schema.index({ currentlyWorkingAs: 1, createdAt: -1 });
schema.index({ state: 1, createdAt: -1 });

module.exports = mongoose.model('ProFormSubmission', schema);
