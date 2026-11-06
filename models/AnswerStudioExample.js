'use strict';

const mongoose = require('mongoose');
const {
  ANSWER_STUDIO_EMBEDDING_DIMENSIONS,
  ANSWER_STUDIO_EXAMPLE_STATUSES,
  ANSWER_STUDIO_PLATFORMS,
} = require('../services/answerStudio/constants');
const { embeddingValidator } = require('../services/answerStudio/validateEmbedding');

const answerStudioExampleSchema = new mongoose.Schema(
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
    answer: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 20000,
    },
    topic: {
      type: String,
      trim: true,
      maxlength: 256,
      default: '',
    },
    styleTags: {
      type: [{ type: String, trim: true, maxlength: 64 }],
      default: [],
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
    status: {
      type: String,
      required: true,
      enum: ANSWER_STUDIO_EXAMPLE_STATUSES,
      default: 'draft',
    },
    active: {
      type: Boolean,
      default: false,
    },
    isTestData: {
      type: Boolean,
      default: false,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    approvedAt: {
      type: Date,
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
    collection: 'answerStudioExamples',
  }
);

answerStudioExampleSchema.pre('validate', function enforceApprovalState() {
  if (this.status !== 'approved') {
    this.active = false;
  }
  if (this.status === 'approved' && (!this.approvedBy || !this.approvedAt)) {
    this.invalidate('approvedBy', 'Approved examples require approvedBy and approvedAt');
    this.invalidate('approvedAt', 'Approved examples require approvedBy and approvedAt');
  }
});

answerStudioExampleSchema.index({ platform: 1, status: 1 });
answerStudioExampleSchema.index({ active: 1, platform: 1 });

module.exports = mongoose.model('AnswerStudioExample', answerStudioExampleSchema);
