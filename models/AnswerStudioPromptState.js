'use strict';

const mongoose = require('mongoose');
const { ANSWER_STUDIO_PLATFORMS } = require('../services/answerStudio/constants');

/**
 * One document per platform. activePromptId is the only authoritative
 * selection. Prompt.lifecycle and Prompt.active are derived metadata.
 */
const answerStudioPromptStateSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ANSWER_STUDIO_PLATFORMS,
    },
    activePromptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AnswerStudioPrompt',
      default: null,
    },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'answerStudioPromptStates',
  }
);

answerStudioPromptStateSchema.index(
  { platform: 1 },
  { unique: true, name: 'answerStudioPromptStates_platform' }
);

module.exports = mongoose.model('AnswerStudioPromptState', answerStudioPromptStateSchema);
