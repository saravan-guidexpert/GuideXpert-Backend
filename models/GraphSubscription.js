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

module.exports = mongoose.model('GraphSubscription', graphSubscriptionSchema);
