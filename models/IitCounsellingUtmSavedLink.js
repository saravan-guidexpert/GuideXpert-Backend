const mongoose = require('mongoose');

/**
 * Saved UTM links for IIT counselling admin (counselling page + 1-on-1 session).
 * Separate from InfluencerLink (registration) so admin lists never mix.
 */
const iitCounsellingUtmSavedLinkSchema = new mongoose.Schema({
  influencerName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  platform: {
    type: String,
    required: true,
    trim: true,
    enum: ['Instagram', 'YouTube', 'Twitter', 'X', 'WhatsApp', 'Telegram', 'Facebook', 'LinkedIn'],
    default: 'Instagram',
  },
  campaign: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    default: 'guide_xperts',
  },
  utmLink: {
    type: String,
    required: true,
    trim: true,
  },
  linkTarget: {
    type: String,
    trim: true,
    enum: ['iitCounselling', 'oneOnOneSession', 'guidanceBookingConfirmation', 'mainPage'],
    default: 'iitCounselling',
  },
  cost: {
    type: Number,
    default: null,
    min: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, { versionKey: false, collection: 'iitCounsellingUtmSavedLinks' });

iitCounsellingUtmSavedLinkSchema.index({ createdAt: -1 });

module.exports = mongoose.model('IitCounsellingUtmSavedLink', iitCounsellingUtmSavedLinkSchema);
