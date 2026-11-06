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
      maxlength: 300,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 20000,
    },
    sourceLabel: {
      type: String,
      trim: true,
      maxlength: 256,
      default: '',
    },
    category: {
      type: String,
      trim: true,
      maxlength: 128,
      default: '',
    },
    tags: {
      type: [{ type: String, trim: true, maxlength: 64 }],
      default: [],
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

// Non-unique: the same text may be curated more than once (different source
// or a kept historical row). Uniqueness would block that without a product rule.
answerStudioKnowledgeSchema.index({ contentHash: 1 });
answerStudioKnowledgeSchema.index({ active: 1, updatedAt: -1 });

module.exports = mongoose.model('AnswerStudioKnowledge', answerStudioKnowledgeSchema);
