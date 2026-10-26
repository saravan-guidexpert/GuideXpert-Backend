'use strict';

const mongoose = require('mongoose');
const { CrmError } = require('./crmError');
const { CRM_PAGE_MAX_LIMIT } = require('../constants/crm');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bodyObject(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

function parseObjectId(value, label) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) {
    throw new CrmError(400, `${label} is not valid.`, 'invalid_id');
  }
  return new mongoose.Types.ObjectId(value);
}

function parsePageLimit(query) {
  const source = query || {};
  if (source.page === undefined || source.page === '' || source.limit === undefined || source.limit === '') {
    throw new CrmError(400, 'page and limit are required.', 'invalid_query');
  }
  const page = Number(source.page);
  const limit = Number(source.limit);
  if (!Number.isInteger(page) || page < 1) {
    throw new CrmError(400, 'page must be an integer of 1 or greater.', 'invalid_query');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > CRM_PAGE_MAX_LIMIT) {
    throw new CrmError(400, `limit must be an integer from 1 to ${CRM_PAGE_MAX_LIMIT}.`, 'invalid_query');
  }
  return { page, limit, skip: (page - 1) * limit };
}

function optionalQueryString(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw new CrmError(400, `${label} is not valid.`, 'invalid_query');
  }
  const text = value.trim();
  if (text.length > 100) {
    throw new CrmError(400, `${label} is too long.`, 'invalid_query');
  }
  return text;
}

function requestMeta(req) {
  const userAgent = req && typeof req.get === 'function' ? req.get('user-agent') : '';
  return {
    ip: req && req.ip ? String(req.ip).slice(0, 80) : null,
    userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
  };
}

module.exports = {
  escapeRegex,
  bodyObject,
  parseObjectId,
  parsePageLimit,
  optionalQueryString,
  requestMeta,
};
