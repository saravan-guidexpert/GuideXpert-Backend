'use strict';

const mongoose = require('mongoose');
const {
  EMAIL_PIPELINE_STATES,
  STAGE_STATES,
  LIMITS
} = require('../constants/supportEmail');

const recipientSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, lowercase: true, default: '' }
  },
  { _id: false }
);

const pipelineStageSchema = new mongoose.Schema(
  {
    state: {
      type: String,
      enum: EMAIL_PIPELINE_STATES,
      default: 'received'
    },
    fetch: {
      type: String,
      enum: STAGE_STATES.fetch,
      default: 'pending'
    },
    attachments: {
      type: String,
      enum: STAGE_STATES.attachments,
      default: 'pending'
    },
    ai: {
      type: String,
      enum: STAGE_STATES.ai,
      default: 'pending'
    },
    ticket: {
      type: String,
      enum: STAGE_STATES.ticket,
      default: 'pending'
    },
    sheets: {
      type: String,
      enum: STAGE_STATES.sheets,
      default: 'pending'
    },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const supportEmailSchema = new mongoose.Schema(
  {
    graphMessageId: {
      type: String,
      required: true,
      trim: true
    },
    internetMessageId: {
      type: String,
      trim: true,
      default: null
    },
    conversationId: {
      type: String,
      trim: true,
      default: null
    },
    receivedDateTime: {
      type: Date,
      required: true
    },
    sentDateTime: {
      type: Date,
      default: null
    },
    from: {
      type: recipientSchema,
      default: () => ({ name: '', address: '' })
    },
    toRecipients: {
      type: [recipientSchema],
      default: []
    },
    ccRecipients: {
      type: [recipientSchema],
      default: []
    },
    subject: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ''
    },
    bodyPreview: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ''
    },
    bodyText: {
      type: String,
      maxlength: LIMITS.MAX_BODY_TEXT_LENGTH,
      default: ''
    },
    bodyHtmlSnippet: {
      type: String,
      maxlength: LIMITS.MAX_BODY_HTML_SNIPPET_LENGTH,
      default: ''
    },
    hasAttachments: {
      type: Boolean,
      default: false
    },
    attachmentCount: {
      type: Number,
      default: 0,
      min: 0
    },
    activationAt: {
      type: Date,
      default: null
    },
    isHistorical: {
      type: Boolean,
      default: false
    },
    isDuplicate: {
      type: Boolean,
      default: false
    },
    duplicateOfEmailId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportEmail',
      default: null
    },
    contentHash: {
      type: String,
      trim: true,
      default: null
    },
    pipeline: {
      type: pipelineStageSchema,
      default: () => ({})
    },
    /**
     * Mailbox and ingestion metadata:
     * - mailbox: string (target mailbox address)
     * - folder: string (e.g. 'inbox')
     * - importance: 'low' | 'normal' | 'high'
     * - isRead: boolean
     * - isDraft: boolean
     * - webLink: string | null
     * - isRemoved: boolean (true when removed from Inbox)
     * - inInbox: boolean (true while in Inbox, false when moved or deleted)
     * - graphRemovalReason: string (exact reason reported by Graph delta, e.g. 'deleted'; or 'missing' / 'malformed')
     * - removalReason: string (alias of graphRemovalReason)
     * - removedAt: Date (timestamp when the removal event was first observed by the application; immutable across replays)
     */
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
supportEmailSchema.index({ graphMessageId: 1 }, { unique: true });
supportEmailSchema.index(
  { internetMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      internetMessageId: { $type: 'string', $gt: '' }
    }
  }
);
supportEmailSchema.index({ receivedDateTime: -1 });
supportEmailSchema.index({ conversationId: 1, receivedDateTime: -1 });
supportEmailSchema.index({ 'pipeline.state': 1, receivedDateTime: 1 });

module.exports = mongoose.model('SupportEmail', supportEmailSchema);
