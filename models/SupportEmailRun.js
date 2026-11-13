'use strict';

const mongoose = require('mongoose');

const supportEmailRunSchema = new mongoose.Schema(
  {
    runKey: {
      type: String,
      required: true,
      trim: true
    },
    startedAt: {
      type: Date,
      default: Date.now
    },
    finishedAt: {
      type: Date,
      default: null
    },
    durationMs: {
      type: Number,
      default: null
    },
    success: {
      type: Boolean,
      default: null
    },
    stats: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    },
    errorSummary: {
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
supportEmailRunSchema.index({ runKey: 1, startedAt: -1 });
supportEmailRunSchema.index({ startedAt: -1 });

module.exports = mongoose.model('SupportEmailRun', supportEmailRunSchema);
