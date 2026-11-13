'use strict';

const mongoose = require('mongoose');
const { ANSWER_STUDIO_PLATFORMS } = require('../services/answerStudio/constants');

const IMMUTABLE_PROMPT_FIELDS = ['key', 'platform', 'body', 'version'];
const PROMPT_LIFECYCLES = Object.freeze(['draft', 'active', 'inactive']);

function updateTouchesImmutablePrompt(update) {
  if (!update || typeof update !== 'object') return false;
  const parts = [update, update.$set, update.$setOnInsert, update.$unset];
  return parts.some(
    (part) =>
      part &&
      IMMUTABLE_PROMPT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(part, field))
  );
}

function rejectImmutablePromptUpdate() {
  if (updateTouchesImmutablePrompt(this.getUpdate())) {
    throw new Error('Prompt content and identity cannot be modified after creation');
  }
}

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
    lifecycle: {
      type: String,
      enum: PROMPT_LIFECYCLES,
      default: 'draft',
      required: true,
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
    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    deactivatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    deactivatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'answerStudioPrompts',
  }
);

answerStudioPromptSchema.pre('save', function preservePromptIdentity() {
  if (this.isNew) return;
  if (IMMUTABLE_PROMPT_FIELDS.some((field) => this.isModified(field))) {
    throw new Error('Prompt content and identity cannot be modified after creation');
  }
});

answerStudioPromptSchema.pre('updateOne', rejectImmutablePromptUpdate);
answerStudioPromptSchema.pre('updateMany', rejectImmutablePromptUpdate);
answerStudioPromptSchema.pre('findOneAndUpdate', rejectImmutablePromptUpdate);
answerStudioPromptSchema.pre('replaceOne', rejectImmutablePromptUpdate);

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
module.exports.PROMPT_LIFECYCLES = PROMPT_LIFECYCLES;
