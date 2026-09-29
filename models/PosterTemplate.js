const mongoose = require('mongoose');

/** Position & style for name or mobile text; x/y are % of poster container (0–100). xEnd is name-only (right edge cap). */
const overlayFieldSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 12, min: 0, max: 100 },
    anchorX: { type: Number, default: 12, min: 0, max: 100 },
    anchorType: { type: String, default: 'start', enum: ['start', 'end', 'center'] },
    y: { type: Number, default: 12, min: 0, max: 100 },
    textValue: { type: String, default: '' },
    /** Name field only: right bound (%); mobile documents should omit this (stripped on save). */
    xEnd: { type: Number, required: false, min: 0, max: 100 },
    fontSize: { type: Number, default: 20, min: 4, max: 400 },
    color: { type: String, default: '#111827' },
    fontWeight: { type: String, default: '600' },
    textAlign: { type: String, default: 'left', enum: ['left', 'center', 'right', 'justify'] },
  },
  { _id: false }
);

const posterTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    route: { type: String, required: true },
    /** Which admin library owns this template. Legacy documents without the field are counsellor posters. */
    audience: { type: String, enum: ['counsellor', 'pro'], default: 'counsellor', index: true },
    svgTemplate: { type: String, required: true },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    /** Optional marketing highlight flag; all published templates can appear on counsellor Marketing. */
    marketingFeatured: { type: Boolean, default: false },
    marketingFeaturedAt: { type: Date, default: null },
    nameField: { type: overlayFieldSchema, default: () => ({}) },
    mobileField: { type: overlayFieldSchema, default: () => ({}) },
    /** @deprecated Legacy only; API migrates to nameField / mobileField in responses */
    elements: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

posterTemplateSchema.index({ route: 1 }, { unique: true });

const PosterTemplate = mongoose.model('PosterTemplate', posterTemplateSchema);

module.exports = PosterTemplate;
