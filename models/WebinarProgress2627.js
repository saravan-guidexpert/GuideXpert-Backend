const mongoose = require('mongoose');

const moduleProgressSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['locked', 'unlocked', 'in_progress', 'completed'],
      default: 'locked',
    },
    progressPercent: { type: Number, default: 0, min: 0, max: 100 },
    watchedSeconds: { type: Number, default: 0 },
    maxWatchedSeconds: { type: Number, default: 0 },
    score: { type: Number, default: null },
    totalScore: { type: Number, default: null },
    completedAt: { type: Date, default: null },
    unlockedAt: { type: Date, default: null },
  },
  { _id: false }
);

/** Compact snapshot for Last Activity UI (overwrite-only). */
const lastActivityEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['video_progress', 'video_completed', 'assessment_completed', 'module_unlocked', 'resume_seek'],
      default: 'resume_seek',
    },
    moduleId: { type: String, default: null },
    moduleTitle: { type: String, default: '' },
    watchedSeconds: { type: Number, default: null },
    progressPercent: { type: Number, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const webinarProgressSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      match: /^\d{10}$/,
    },
    fullName: { type: String, default: '' },
    overallPercent: { type: Number, default: 0, min: 0, max: 100 },
    completedModules: { type: [String], default: [] },
    modules: {
      type: Map,
      of: moduleProgressSchema,
      default: () => new Map(),
    },
    lastActiveModule: { type: String, default: null },
    firstJoinedAt: { type: Date, default: null, index: true },
    isLegacyUser: { type: Boolean, default: false, index: true },
    lastActivityAt: { type: Date, default: Date.now },
    lastActivityEvent: { type: lastActivityEventSchema, default: null },
    certificateDownloadedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

webinarProgressSchema.index({ lastActivityAt: -1 });
webinarProgressSchema.index({ overallPercent: -1, lastActivityAt: -1 });
webinarProgressSchema.index({ isLegacyUser: 1, firstJoinedAt: -1 });

module.exports = mongoose.model('WebinarProgress2627', webinarProgressSchema, 'webinar_progress_26_27');
