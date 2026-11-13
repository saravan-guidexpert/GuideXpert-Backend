'use strict';

const mongoose = require('mongoose');

const supportTicketCounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true
    },
    seq: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

supportTicketCounterSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('SupportTicketCounter', supportTicketCounterSchema);
