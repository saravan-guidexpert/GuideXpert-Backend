const mongoose = require('mongoose');

/** Dedicated collection for /activationcounsellorsgmeet.
 *  Same attendance shape as MeetingAttendance, isolated so it never mixes with /meet. */
const schema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    mobileNumber: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{10}$/, 'Mobile number must be 10 digits'],
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    attendanceStatus: {
      type: String,
      enum: ['joined'],
      default: 'joined',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { collection: 'activation_counsellor_meet_attendances' }
);

schema.index({ timestamp: -1 });
schema.index({ createdAt: -1 });
schema.index({ mobileNumber: 1 });
schema.index({ mobileNumber: 1, timestamp: -1 });

schema.pre('save', function () {
  this.timestamp = this.timestamp || Date.now();
  this.updatedAt = Date.now();
});

module.exports = mongoose.model('ActivationCounsellorMeetAttendance', schema);
