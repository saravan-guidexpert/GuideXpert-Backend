'use strict';

const mongoose = require('mongoose');
const { WEBHOOK_STATUSES } = require('../constants/supportEmail');

const supportEmailWebhookEventSchema = new mongoose.Schema(
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
    changeType: {
      type: String,
      required: true,
      trim: true
    },
    tenantId: {
      type: String,
      trim: true,
      default: null
    },
    dedupeKey: {
      type: String,
      required: true,
      trim: true
    },
    clientStateHash: {
      type: String,
      trim: true,
      default: null
    },
    resourceDataId: {
      type: String,
      trim: true,
      default: null
    },
    lifecycleEventType: {
      type: String,
      trim: true,
      default: null
    },
    receivedAt: {
      type: Date,
      default: Date.now
    },
    processedAt: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: WEBHOOK_STATUSES,
      default: 'received'
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0
    },
    errorCategory: {
      type: String,
      trim: true,
      default: null
    },
    error: {
      type: String,
      trim: true,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    },
    // TTL expiration to prune dedupe rows after 7 days, avoiding permanent suppression
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A + TTL safety
supportEmailWebhookEventSchema.index({ dedupeKey: 1 }, { unique: true });
supportEmailWebhookEventSchema.index({ receivedAt: -1 });
supportEmailWebhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SupportEmailWebhookEvent', supportEmailWebhookEventSchema);
