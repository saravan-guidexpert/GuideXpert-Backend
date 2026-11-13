'use strict';

const mongoose = require('mongoose');
const {
  TICKET_EVENT_TYPES,
  ACTOR_TYPES
} = require('../constants/supportEmail');

const supportTicketEventSchema = new mongoose.Schema(
  {
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportTicket',
      required: true
    },
    type: {
      type: String,
      enum: TICKET_EVENT_TYPES,
      required: true
    },
    actorType: {
      type: String,
      enum: ACTOR_TYPES,
      default: 'system'
    },
    actorId: {
      type: String,
      default: null
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

// Indexes declared according to Appendix A
supportTicketEventSchema.index({ ticketId: 1, createdAt: -1 });
supportTicketEventSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('SupportTicketEvent', supportTicketEventSchema);
