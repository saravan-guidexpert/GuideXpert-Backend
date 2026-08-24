const mongoose = require('mongoose');

const questionResultSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  text: { type: String, default: '' },
  correct: { type: Boolean, required: true },
  userAnswer: { type: String, default: '' },
  correctAnswer: { type: String, default: '' },
}, { _id: false });

const webinarAssessmentSubmissionSchema = new mongoose.Schema({
  assessmentId: {
    type: String,
    required: true,
    trim: true,
    enum: ['a1', 'a2', 'a3', 'a4', 'a5'],
  },
  phone: {
    type: String,
    trim: true,
    match: [/^\d{10}$/, 'Phone must be 10 digits'],
    default: null,
  },
  fullName: {
    type: String,
    trim: true,
    maxlength: 100,
    default: null,
  },
  score: {
    type: Number,
    required: true,
    min: 0,
  },
  total: {
    type: Number,
    required: true,
    min: 0,
  },
  results: {
    type: [questionResultSchema],
    default: [],
  },
  answers: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  trainingYear: {
    type: String,
    enum: ['25-26', '26-27'],
    default: undefined,
  },
}, { timestamps: true });

webinarAssessmentSubmissionSchema.index({ assessmentId: 1, phone: 1 });
webinarAssessmentSubmissionSchema.index({ submittedAt: -1 });
webinarAssessmentSubmissionSchema.index({ trainingYear: 1, assessmentId: 1 });

const WebinarAssessmentSubmission = mongoose.model(
  'WebinarAssessmentSubmission',
  webinarAssessmentSubmissionSchema
);

module.exports = WebinarAssessmentSubmission;
