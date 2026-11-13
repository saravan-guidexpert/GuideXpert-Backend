'use strict';

const {
  ANSWER_STUDIO_EXAMPLE_STATUSES,
  ANSWER_STUDIO_PLATFORMS,
} = require('./constants');

const EXAMPLE_LIMITS = Object.freeze({
  question: 8000,
  answer: 20000,
  topic: 256,
  styleTag: 64,
  styleTagCount: 30,
  search: 200,
  page: 1000,
});

const CREATE_FIELDS = Object.freeze([
  'platform',
  'question',
  'answer',
  'topic',
  'styleTags',
  'isTestData',
]);

const UPDATE_FIELDS = Object.freeze(['platform', 'question', 'answer', 'topic', 'styleTags']);

const LIST_QUERY_KEYS = Object.freeze([
  'page',
  'limit',
  'search',
  'platform',
  'status',
  'topic',
  'styleTag',
  'isTestData',
  'sort',
  'order',
]);

const SORT_FIELDS = Object.freeze(['createdAt', 'updatedAt']);

class ExampleInputError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.name = 'ExampleInputError';
    this.statusCode = statusCode;
    this.code = extra.code || null;
    this.currentStatus = extra.currentStatus || null;
  }
}

function badRequest(message) {
  return new ExampleInputError(message, 400);
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

function normalizeText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Answers keep paragraph breaks. Spaces and tabs still collapse, and extra blank lines collapse to one.
function normalizeAnswer(value) {
  const text = String(value || '').normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function requireText(value, field, max, normalize = normalizeText) {
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be a string.`);
  }
  const text = normalize(value);
  if (!text) {
    throw badRequest(`${field} is required.`);
  }
  if (text.length > max) {
    throw badRequest(`${field} must be at most ${max} characters.`);
  }
  return text;
}

function requirePlatform(value) {
  if (typeof value !== 'string') {
    throw badRequest('platform must be quora or reddit.');
  }
  const platform = value.normalize('NFC').trim().toLowerCase();
  if (!ANSWER_STUDIO_PLATFORMS.includes(platform)) {
    throw badRequest('platform must be quora or reddit.');
  }
  return platform;
}

function normalizeStyleTags(value) {
  if (!Array.isArray(value)) {
    throw badRequest('styleTags must be an array of strings.');
  }
  if (value.length > EXAMPLE_LIMITS.styleTagCount) {
    throw badRequest(`styleTags must contain at most ${EXAMPLE_LIMITS.styleTagCount} items.`);
  }
  const seen = new Set();
  const tags = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw badRequest('styleTags must be an array of strings.');
    }
    const tag = normalizeText(entry);
    if (!tag) {
      throw badRequest('styleTags cannot contain empty values.');
    }
    if (tag.length > EXAMPLE_LIMITS.styleTag) {
      throw badRequest(`each style tag must be at most ${EXAMPLE_LIMITS.styleTag} characters.`);
    }
    const dedupeKey = tag.toLocaleLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(tag);
  }
  return tags;
}

function readBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw badRequest(`${field} must be a boolean.`);
  }
  return value;
}

function parseCreateInput(body) {
  assertAllowedFields(body, CREATE_FIELDS);
  if (!Object.prototype.hasOwnProperty.call(body, 'platform')) {
    throw badRequest('platform is required.');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'question')) {
    throw badRequest('question is required.');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'answer')) {
    throw badRequest('answer is required.');
  }
  const topic = Object.prototype.hasOwnProperty.call(body, 'topic')
    ? requireText(body.topic, 'topic', EXAMPLE_LIMITS.topic)
    : '';
  return {
    platform: requirePlatform(body.platform),
    question: requireText(body.question, 'question', EXAMPLE_LIMITS.question),
    answer: requireText(body.answer, 'answer', EXAMPLE_LIMITS.answer, normalizeAnswer),
    topic,
    styleTags: Object.prototype.hasOwnProperty.call(body, 'styleTags')
      ? normalizeStyleTags(body.styleTags)
      : [],
    isTestData: Object.prototype.hasOwnProperty.call(body, 'isTestData')
      ? readBoolean(body.isTestData, 'isTestData')
      : false,
  };
}

function parseUpdateInput(body) {
  assertAllowedFields(body, UPDATE_FIELDS);
  if (Object.keys(body).length === 0) {
    throw badRequest('At least one field is required.');
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'platform')) {
    patch.platform = requirePlatform(body.platform);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'question')) {
    patch.question = requireText(body.question, 'question', EXAMPLE_LIMITS.question);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'answer')) {
    patch.answer = requireText(body.answer, 'answer', EXAMPLE_LIMITS.answer, normalizeAnswer);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'topic')) {
    patch.topic = requireText(body.topic, 'topic', EXAMPLE_LIMITS.topic);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'styleTags')) {
    patch.styleTags = normalizeStyleTags(body.styleTags);
  }
  return patch;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readQueryFlag(value, field) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`${field} must be true or false.`);
}

function readPositiveInt(value, field, { max, fallback }) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw badRequest(`${field} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw badRequest(`${field} must be at most ${max}.`);
  }
  return parsed;
}

function parseListQuery(query) {
  assertPlainObject(query || {}, 'Query');
  for (const key of Object.keys(query)) {
    assertSafeKey(key);
    if (!LIST_QUERY_KEYS.includes(key)) {
      throw badRequest('Query parameter is not allowed.');
    }
    if (typeof query[key] !== 'string') {
      throw badRequest(`${key} is invalid.`);
    }
  }

  const page = readPositiveInt(query.page, 'page', { max: EXAMPLE_LIMITS.page, fallback: 1 });
  const limit = readPositiveInt(query.limit, 'limit', { max: 100, fallback: 20 });
  const filter = {};

  if (query.search != null) {
    const search = normalizeText(query.search);
    if (!search) throw badRequest('search is required when provided.');
    if (search.length > EXAMPLE_LIMITS.search) {
      throw badRequest(`search must be at most ${EXAMPLE_LIMITS.search} characters.`);
    }
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ question: pattern }, { answer: pattern }];
  }
  if (query.platform != null) {
    filter.platform = requirePlatform(query.platform);
  }
  if (query.status != null) {
    const status = query.status.normalize('NFC').trim().toLowerCase();
    if (!ANSWER_STUDIO_EXAMPLE_STATUSES.includes(status)) {
      throw badRequest('status must be draft, approved, or archived.');
    }
    filter.status = status;
  }
  if (query.topic != null) {
    filter.topic = requireText(query.topic, 'topic', EXAMPLE_LIMITS.topic);
  }
  if (query.styleTag != null) {
    const [tag] = normalizeStyleTags([query.styleTag]);
    filter.styleTags = new RegExp(`^${escapeRegex(tag)}$`, 'i');
  }
  if (query.isTestData != null) {
    filter.isTestData = readQueryFlag(query.isTestData, 'isTestData');
  }

  const sortField = query.sort == null ? 'updatedAt' : query.sort;
  if (!SORT_FIELDS.includes(sortField)) {
    throw badRequest('sort must be createdAt or updatedAt.');
  }
  const order = query.order == null ? 'desc' : query.order;
  if (order !== 'asc' && order !== 'desc') {
    throw badRequest('order must be asc or desc.');
  }

  return {
    page,
    limit,
    filter,
    sort: { [sortField]: order === 'asc' ? 1 : -1 },
  };
}

function isObjectIdString(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

module.exports = {
  EXAMPLE_LIMITS,
  ExampleInputError,
  parseCreateInput,
  parseUpdateInput,
  parseListQuery,
  isObjectIdString,
};
