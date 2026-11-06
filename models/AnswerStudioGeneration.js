'use strict';

const mongoose = require('mongoose');
const {
  ANSWER_STUDIO_GENERATION_STATUSES,
  ANSWER_STUDIO_PLATFORMS,
} = require('../services/answerStudio/constants');

function updateTouchesRawAnswer(update) {
  if (!update || typeof update !== 'object') return false;
  const parts = [update, update.$set, update.$setOnInsert, update.$unset];
  return parts.some(
    (part) => part && Object.prototype.hasOwnProperty.call(part, 'rawAnswer')
  );
}

function rejectRawAnswerMutation() {
  if (updateTouchesRawAnswer(this.getUpdate())) {
    throw new Error('rawAnswer cannot be modified after creation');
  }
}

const answerStudioGenerationSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ANSWER_STUDIO_PLATFORMS,
    },
    question: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 8000,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: '',
    },
    rawAnswer: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 32000,
    },
    editedAnswer: {
      type: String,
      maxlength: 32000,
      default: '',
    },
    status: {
      type: String,
      required: true,
      enum: ANSWER_STUDIO_GENERATION_STATUSES,
      default: 'generated',
    },
    knowledgeReferences: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AnswerStudioKnowledge' }],
      default: [],
    },
    exampleReferences: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AnswerStudioExample' }],
      default: [],
    },
    model: {
      type: String,
      trim: true,
      maxlength: 128,
      default: '',
    },
    promptKey: {
      type: String,
      trim: true,
      maxlength: 128,
      default: '',
    },
    promptVersion: {
      type: Number,
      min: 1,
      validate: {
        validator(value) {
          return value == null || Number.isInteger(value);
        },
        message: 'promptVersion must be an integer',
      },
    },
    generationVersion: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
      validate: {
        validator: Number.isInteger,
        message: 'generationVersion must be an integer',
      },
    },
    parentGenerationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AnswerStudioGeneration',
      default: null,
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
    collection: 'answerStudioGenerations',
  }
);

answerStudioGenerationSchema.pre('save', function preserveRawAnswer() {
  if (!this.isNew && this.isModified('rawAnswer')) {
    throw new Error('rawAnswer cannot be modified after creation');
  }
});

answerStudioGenerationSchema.pre('updateOne', rejectRawAnswerMutation);
answerStudioGenerationSchema.pre('updateMany', rejectRawAnswerMutation);
answerStudioGenerationSchema.pre('findOneAndUpdate', rejectRawAnswerMutation);
answerStudioGenerationSchema.pre('replaceOne', rejectRawAnswerMutation);

answerStudioGenerationSchema.index({ createdBy: 1, createdAt: -1 });
answerStudioGenerationSchema.index({ platform: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AnswerStudioGeneration', answerStudioGenerationSchema);
