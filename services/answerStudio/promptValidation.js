'use strict';

const mongoose = require('mongoose');
const { ANSWER_STUDIO_PLATFORMS } = require('./constants');

const PROMPT_BODY_LIMIT = 100 * 1024;
const PROMPT_KEY_LIMIT = 128;
const PROMPT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CREATE_FIELDS = Object.freeze(['key', 'platform', 'body']);
const VERSION_FIELDS = Object.freeze(['body']);
const LIST_QUERY_KEYS = Object.freeze(['page', 'limit', 'platform', 'key', 'active']);

class PromptInputError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = 'PromptInputError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function badRequest(message, code) {
  return new PromptInputError(message, 400, code || null);
}

function assertSafeKey(key) {
  if (typeof key !== 'string' || !key || key.includes('$') || key.includes('.')) {
    throw badRequest('Request fields are invalid.');
  }
}

function assertPlainObject(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${label} must be a JSON object.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw badRequest(`${label} must be a JSON object.`);
  }
}

function assertAllowedFields(body, allowed) {
  assertPlainObject(body, 'Request body');
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(body)) {
    assertSafeKey(key);
    if (!allowedSet.has(key)) {
      throw badRequest(`Field \`${key}\` cannot be set.`);
    }
  }
}

function normalizePromptBody(value) {
  return String(value || '').normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function requireBody(value) {
  if (typeof value !== 'string') {
    throw badRequest('body must be a string.', 'PROMPT_BODY_REQUIRED');
  }
  const body = normalizePromptBody(value);
  if (!body) {
    throw badRequest('body is required.', 'PROMPT_BODY_REQUIRED');
  }
  if (body.length > PROMPT_BODY_LIMIT) {
    throw badRequest(`body must be at most ${PROMPT_BODY_LIMIT} characters.`, 'PROMPT_BODY_TOO_LONG');
  }
  return body;
}

function requirePlatform(value) {
  if (typeof value !== 'string') {
    throw badRequest('platform must be quora or reddit.', 'INVALID_PLATFORM');
  }
  const platform = value.normalize('NFC').trim().toLowerCase();
  if (!ANSWER_STUDIO_PLATFORMS.includes(platform)) {
    throw badRequest('platform must be quora or reddit.', 'INVALID_PLATFORM');
  }
  return platform;
}

function requirePromptKey(value) {
  if (typeof value !== 'string') {
    throw badRequest('key must be a string.', 'INVALID_PROMPT_KEY');
  }
  const key = value.normalize('NFC').trim();
  if (!PROMPT_KEY_PATTERN.test(key) || key.length > PROMPT_KEY_LIMIT) {
    throw badRequest(
      'key must be 1-128 characters and use letters, numbers, dots, underscores, or hyphens.',
      'INVALID_PROMPT_KEY'
    );
  }
  return key;
}

function parseCreateInput(body) {
  assertAllowedFields(body, CREATE_FIELDS);
  if (!Object.prototype.hasOwnProperty.call(body, 'key')) {
    throw badRequest('key is required.', 'INVALID_PROMPT_KEY');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'platform')) {
    throw badRequest('platform is required.', 'INVALID_PLATFORM');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'body')) {
    throw badRequest('body is required.', 'PROMPT_BODY_REQUIRED');
  }
  return {
    key: requirePromptKey(body.key),
    platform: requirePlatform(body.platform),
    body: requireBody(body.body),
  };
}

function parseVersionInput(body) {
  const source = body && typeof body === 'object' ? body : {};
  assertAllowedFields(source, VERSION_FIELDS);
  if (!Object.prototype.hasOwnProperty.call(source, 'body')) {
    return { body: null };
  }
  return { body: requireBody(source.body) };
}

function readPositiveInt(value, field, { max, fallback }) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw badRequest(`${field} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (parsed > max) {
    throw badRequest(`${field} must be at most ${max}.`);
  }
  return parsed;
}

function parseListQuery(query) {
  assertPlainObject(query || {}, 'Query');
  const source = query || {};
  for (const key of Object.keys(source)) {
    assertSafeKey(key);
    if (!LIST_QUERY_KEYS.includes(key)) {
      throw badRequest(`Query field \`${key}\` is not supported.`);
    }
  }
  const filter = {};
  if (Object.prototype.hasOwnProperty.call(source, 'platform')) {
    filter.platform = requirePlatform(source.platform);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'key')) {
    filter.key = requirePromptKey(source.key);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'active')) {
    if (source.active !== 'true' && source.active !== 'false') {
      throw badRequest('active must be true or false.');
    }
    filter.active = source.active === 'true';
  }
  return {
    filter,
    page: readPositiveInt(source.page, 'page', { max: 1000, fallback: 1 }),
    limit: readPositiveInt(source.limit, 'limit', { max: 100, fallback: 20 }),
  };
}

function isObjectIdString(value) {
  return typeof value === 'string' && mongoose.isValidObjectId(value);
}

module.exports = {
  PROMPT_BODY_LIMIT,
  PromptInputError,
  parseCreateInput,
  parseVersionInput,
  parseListQuery,
  isObjectIdString,
  requireBody,
};
