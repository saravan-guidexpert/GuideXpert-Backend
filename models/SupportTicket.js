'use strict';

const mongoose = require('mongoose');
const {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SENTIMENTS
} = require('../constants/supportEmail');

const partySchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const studentDetailsSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    rollNumber: { type: String, trim: true, default: '' },
    course: { type: String, trim: true, default: '' },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      default: null
    }
  },
  { _id: false }
);

const enquirySchema = new mongoose.Schema(
  {
    summary: { type: String, trim: true, maxlength: 500, default: '' },
    details: { type: String, trim: true, maxlength: 5000, default: '' }
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      required: true,
      trim: true
    },
    emailIds: {
      type: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SupportEmail'
      }],
      default: []
    },
    primaryEmailId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportEmail',
      default: null
    },
    requester: {
      type: partySchema,
      default: () => ({ name: '', email: '', phone: '' })
    },
    student: {
      type: studentDetailsSchema,
      default: () => ({ name: '', email: '', phone: '', rollNumber: '', course: '' })
    },
    enquiry: {
      type: enquirySchema,
      default: () => ({ summary: '', details: '' })
    },
    category: {
      type: String,
      enum: TICKET_CATEGORIES,
      default: 'general'
    },
    subCategory: {
      type: String,
      trim: true,
      maxlength: 100,
      default: ''
    },
    priority: {
      type: String,
      enum: TICKET_PRIORITIES,
      default: 'medium'
    },
    sentiment: {
      type: String,
      enum: TICKET_SENTIMENTS,
      default: 'neutral'
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: null
    },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: 'open'
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    dedupeKey: {
      type: String,
      required: true,
      trim: true
    },
    taxonomyVersion: {
      type: String,
      trim: true,
      default: '1.0'
    },
    aiRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportEmailAiRun',
      default: null
    },
    tags: {
      type: [String],
      default: []
    },
    sheetsRowNumber: {
      type: Number,
      default: null
    },
    resolvedAt: {
      type: Date,
      default: null
    },
    closedAt: {
      type: Date,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    timestamps: true
  }
);

// Indexes declared according to Appendix A
supportTicketSchema.index({ ticketNumber: 1 }, { unique: true });
supportTicketSchema.index({ dedupeKey: 1 }, { unique: true });
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ assignedTo: 1, status: 1 });
supportTicketSchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
