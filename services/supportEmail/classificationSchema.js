'use strict';

const {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SENTIMENTS
} = require('../../constants/supportEmail');

const URGENCIES = new Set(['low', 'medium', 'high', 'critical']);

function asEnum(value, allowed) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : null;
}

function cleanIdentifiers(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const identifiers = { name: '', email: '', phone: '', rollNumber: '', course: '' };
  if (typeof source.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(source.email.trim())) {
    identifiers.email = source.email.trim().toLowerCase();
  }
  if (typeof source.phone === 'string') {
    const digits = source.phone.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) identifiers.phone = digits;
  }
  if (typeof source.name === 'string' && /^[\p{L}][\p{L} .'-]{1,79}$/u.test(source.name.trim())) {
    identifiers.name = source.name.trim();
  }
  if (typeof source.rollNumber === 'string' && /^[A-Za-z0-9/-]{3,32}$/.test(source.rollNumber.trim())) {
    identifiers.rollNumber = source.rollNumber.trim();
  }
  if (typeof source.course === 'string') {
    const course = source.course.trim();
    if (course.length > 1 && course.length <= 80 && !/ignore|instruction|system prompt/i.test(course)) {
      identifiers.course = course;
    }
  }
  return identifiers;
}

function emptyClassification() {
  return {
    category: 'other',
    subcategory: '',
    intent: '',
    priority: 'medium',
    urgency: 'medium',
    sentiment: 'neutral',
    summary: '',
    studentIdentifiers: cleanIdentifiers(null),
    recommendedAction: 'Review the email manually.',
    confidence: 0,
    needsHumanReview: true,
    unclassified: true
  };
}

/**
 * Accepts only the documented classification shape.
 * Invalid model output becomes an unclassified manual-review result.
 */
function validateClassification(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, errors: ['invalid_json'], value: emptyClassification() };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['invalid_shape'], value: emptyClassification() };
  }

  const errors = [];
  const category = asEnum(parsed.category, TICKET_CATEGORIES);
  const priority = asEnum(parsed.priority, TICKET_PRIORITIES);
  const sentiment = asEnum(parsed.sentiment, TICKET_SENTIMENTS);
  const urgency = asEnum(parsed.urgency, [...URGENCIES]);
  const confidence = Number(parsed.confidence);
  if (!category) errors.push('category');
  if (!priority) errors.push('priority');
  if (!sentiment) errors.push('sentiment');
  if (!urgency) errors.push('urgency');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push('confidence');
  if (typeof parsed.needsHumanReview !== 'boolean') errors.push('needsHumanReview');

  if (errors.length) {
    return { ok: false, errors, value: emptyClassification() };
  }

  return {
    ok: true,
    errors: [],
    value: {
      category,
      subcategory: String(parsed.subcategory || '').trim().slice(0, 100),
      intent: String(parsed.intent || '').trim().slice(0, 200),
      priority,
      urgency,
      sentiment,
      summary: String(parsed.summary || '').trim().slice(0, 500),
      studentIdentifiers: cleanIdentifiers(parsed.studentIdentifiers),
      recommendedAction: String(parsed.recommendedAction || '').trim().slice(0, 300),
      confidence,
      needsHumanReview: parsed.needsHumanReview,
      unclassified: false
    }
  };
}

function extractJsonObject(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : source;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

module.exports = {
  validateClassification,
  extractJsonObject,
  emptyClassification,
  cleanIdentifiers
};
