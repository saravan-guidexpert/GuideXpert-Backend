'use strict';

const mongoose = require('mongoose');
const { CONSULTANCY_STATUS, CONSULTANCY_PIPELINE } = require('../constants/crm');

const crmConsultancySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    normalizedName: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: CONSULTANCY_STATUS, default: 'active', index: true },
    pipelineStage: { type: String, enum: CONSULTANCY_PIPELINE, default: 'fresh', index: true },
    notes: { type: String, trim: true, default: '', maxlength: 2000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'crmConsultancies' }
);

crmConsultancySchema.index(
  { normalizedName: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null, status: 'active' },
  }
);
crmConsultancySchema.index({ deletedAt: 1, status: 1, name: 1 });

module.exports = mongoose.model('CrmConsultancy', crmConsultancySchema);
