'use strict';

const mongoose = require('mongoose');
const { ANSWER_STUDIO_PLATFORMS } = require('../services/answerStudio/constants');

const answerStudioPromptSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 128,
    },
    platform: {
      type: String,
      required: true,
      enum: ANSWER_STUDIO_PLATFORMS,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100 * 1024,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'version must be an integer',
      },
    },
    active: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'answerStudioPrompts',
  }
);

answerStudioPromptSchema.index({ key: 1, version: 1 }, { unique: true });
answerStudioPromptSchema.index({ platform: 1, active: 1 });
answerStudioPromptSchema.index(
  { platform: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: 'answerStudioPrompts_one_active_per_platform',
  }
);

module.exports = mongoose.model('AnswerStudioPrompt', answerStudioPromptSchema);
