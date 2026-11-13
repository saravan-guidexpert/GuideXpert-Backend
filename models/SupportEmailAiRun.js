'use strict';

const mongoose = require('mongoose');
const {
  PROCESSING_STAGES,
  AI_RUN_OUTCOMES
} = require('../constants/supportEmail');

const usageSchema = new mongoose.Schema(
  {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 }
  },
  { _id: false }
);

const supportEmailAiRunSchema = new mongoose.Schema(
  {
    emailId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportEmail',
      required: true
    },
    stage: {
      type: String,
      enum: PROCESSING_STAGES,
      default: 'ai'
    },
    model: {
      type: String,
      required: true,
      trim: true
    },
    promptKey: {
      type: String,
      required: true,
      trim: true
    },
    promptVersion: {
      type: String,
      required: true,
      trim: true
    },
    inputHash: {
      type: String,
      trim: true,
      default: null
    },
    rawResponse: {
      type: String,
      maxlength: 50000,
      default: null
    },
    parsed: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: null
    },
    usage: {
      type: usageSchema,
      default: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    },
    latencyMs: {
      type: Number,
      default: null
    },
    outcome: {
      type: String,
      enum: AI_RUN_OUTCOMES,
      required: true
    },
    error: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
supportEmailAiRunSchema.index({ emailId: 1, createdAt: -1 });
supportEmailAiRunSchema.index({ inputHash: 1, promptVersion: 1, stage: 1 });

module.exports = mongoose.model('SupportEmailAiRun', supportEmailAiRunSchema);
