'use strict';

const mongoose = require('mongoose');

const crmStudentSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, required: true, trim: true, maxlength: 10 },
    email: { type: String, default: '', trim: true, maxlength: 200 },
    city: { type: String, default: '', trim: true, maxlength: 100 },
    notes: { type: String, default: '', trim: true, maxlength: 2000 },
    /**
     * No default and no enum. A default would be written the next time an older
     * document is saved. The service rejects new invalid values and displays a
     * missing or unknown value as Not started without rewriting the document.
     */
    admissionStatus: { type: String, maxlength: 40 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'crmStudents' }
);

/** Includes soft-deleted rows so a deleted identity is not silently reused. */
crmStudentSchema.index({ phone: 1 }, { unique: true });
crmStudentSchema.index({ deletedAt: 1, fullName: 1 });

module.exports = mongoose.model('CrmStudent', crmStudentSchema);
