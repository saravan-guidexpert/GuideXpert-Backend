'use strict';

const mongoose = require('mongoose');
const { SUBSCRIPTION_STATUSES } = require('../constants/supportEmail');

const graphSubscriptionSchema = new mongoose.Schema(
  {
    subscriptionId: {
      type: String,
      required: true,
      trim: true
    },
    mailbox: {
      type: String,
      trim: true,
      lowercase: true,
      default: null
    },
    folder: {
      type: String,
      trim: true,
      default: 'inbox'
    },
    resource: {
      type: String,
      required: true,
      trim: true
    },
    expirationDateTime: {
      type: Date,
      required: true
    },
    clientStateHash: {
      type: String,
      required: true,
      trim: true
    },
    clientStateHashScheme: {
      type: String,
      enum: ['hmac-sha256', 'sha256'],
      default: null
    },
    clientStateKeyId: {
      type: String,
      trim: true,
      default: null
    },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: 'active'
    },
    lastRenewedAt: {
      type: Date,
      default: null
    },
    notificationUrl: {
      type: String,
      trim: true,
      default: null
    },
    lifecycleUrl: {
      type: String,
      trim: true,
      default: null
    },
    lastError: {
      type: String,
      trim: true,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
graphSubscriptionSchema.index({ subscriptionId: 1 }, { unique: true });
graphSubscriptionSchema.index({ expirationDateTime: 1 });
graphSubscriptionSchema.index(
  { mailbox: 1, folder: 1, status: 1, expirationDateTime: -1 },
  { name: 'mailbox_1_folder_1_status_1_expirationDateTime_-1' }
);

module.exports = mongoose.model('GraphSubscription', graphSubscriptionSchema);
