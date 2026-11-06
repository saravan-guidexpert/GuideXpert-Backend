'use strict';

const mongoose = require('mongoose');
const { ANSWER_STUDIO_EMBEDDING_DIMENSIONS } = require('../services/answerStudio/constants');
const { embeddingValidator } = require('../services/answerStudio/validateEmbedding');

const answerStudioKnowledgeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 50000,
    },
    sourceLabel: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    category: {
      type: String,
      trim: true,
      maxlength: 100,
      default: '',
    },
    tags: {
      type: [{ type: String, trim: true, maxlength: 50 }],
      default: [],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length <= 30;
        },
        message: 'tags must contain at most 30 items',
      },
    },
    embedText: {
      type: String,
      trim: true,
      maxlength: 24000,
      default: '',
    },
    contentHash: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 128,
    },
    embedding: {
      type: [Number],
      default: [],
      validate: embeddingValidator(ANSWER_STUDIO_EMBEDDING_DIMENSIONS),
    },
    embeddingModel: {
      type: String,
      trim: true,
      maxlength: 128,
      default: '',
    },
    embeddingDimensions: {
      type: Number,
      default: ANSWER_STUDIO_EMBEDDING_DIMENSIONS,
      validate: {
        validator(value) {
          return value === ANSWER_STUDIO_EMBEDDING_DIMENSIONS;
        },
        message: `embeddingDimensions must be ${ANSWER_STUDIO_EMBEDDING_DIMENSIONS}`,
      },
    },
    active: {
      type: Boolean,
      default: true,
    },
    isTestData: {
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
    collection: 'answerStudioKnowledge',
  }
);

// Non-unique on purpose. Active duplicates are rejected in the knowledge service.
// Inactive rows may share a hash so a fact can be recreated after deactivation.
answerStudioKnowledgeSchema.index({ contentHash: 1 });
answerStudioKnowledgeSchema.index({ active: 1, updatedAt: -1 });

module.exports = mongoose.model('AnswerStudioKnowledge', answerStudioKnowledgeSchema);
