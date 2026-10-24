'use strict';

const { CrmError } = require('../../utils/crmError');
const { normalizeIndianMobile } = require('../../utils/crmPhone');
const { CONSULTANCY_STATUS, CONTACT_STATUS } = require('../../constants/crm');

function actorId(actor) {
  if (actor && actor._id) return actor._id;
  return actor;
}

function auditActor(actor) {
  const id = actorId(actor);
  if (actor && actor.actorType === 'crm-user') return { actorCrmUserId: id };
  return { actorAdminId: id };
}

function requireText(value, label, min, max) {
  if (typeof value !== 'string') {
    throw new CrmError(400, `${label} is required.`, 'invalid_body');
  }
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < min || text.length > max) {
    throw new CrmError(400, `${label} must be ${min}–${max} characters.`, 'invalid_body');
  }
  return text;
}

function optionalText(value, label, max) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw new CrmError(400, `${label} is not valid.`, 'invalid_body');
  }
  const text = value.trim();
  if (text.length > max) {
    throw new CrmError(400, `${label} must be at most ${max} characters.`, 'invalid_body');
  }
  return text;
}

function optionalContactEmail(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CrmError(400, 'Email is not valid.', 'invalid_email');
  }
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CrmError(400, 'Email is not valid.', 'invalid_email');
  }
  return email;
}

function optionalEmail(value) {
  const email = optionalContactEmail(value);
  return email || '';
}

function requireStatus(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new CrmError(400, `${label} must be ${allowed.join(' or ')}.`, 'invalid_body');
  }
  return value;
}

function optionalStatus(value, allowed, label, fallback) {
  if (value == null || value === '') return fallback;
  return requireStatus(value, allowed, label);
}

function normalizeConsultancyName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

module.exports = {
  actorId,
  auditActor,
  requireText,
  optionalText,
  optionalContactEmail,
  optionalEmail,
  requireStatus,
  optionalStatus,
  normalizeConsultancyName,
  normalizeIndianMobile,
  CONSULTANCY_STATUS,
  CONTACT_STATUS,
};
