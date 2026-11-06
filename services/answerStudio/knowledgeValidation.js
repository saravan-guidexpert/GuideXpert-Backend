'use strict';

const KNOWLEDGE_LIMITS = Object.freeze({
  title: 200,
  body: 50000,
  sourceLabel: 200,
  category: 100,
  tag: 50,
  tagCount: 30,
  search: 200,
});

const CREATE_FIELDS = Object.freeze([
  'title',
  'body',
  'sourceLabel',
  'category',
  'tags',
  'isTestData',
]);

const UPDATE_FIELDS = Object.freeze(['title', 'body', 'sourceLabel', 'category', 'tags']);

const LIST_QUERY_KEYS = Object.freeze([
  'page',
  'limit',
  'search',
  'category',
  'tag',
  'active',
  'isTestData',
  'sort',
  'order',
]);

const SORT_FIELDS = Object.freeze(['createdAt', 'updatedAt']);

class KnowledgeInputError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.name = 'KnowledgeInputError';
    this.statusCode = statusCode;
    this.code = extra.code || null;
    this.existingId = extra.existingId || null;
  }
}

function badRequest(message) {
  return new KnowledgeInputError(message, 400);
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

function requireText(value, field, max) {
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be a string.`);
  }
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) {
    throw badRequest(`${field} is required.`);
  }
  if (text.length > max) {
    throw badRequest(`${field} must be at most ${max} characters.`);
  }
  return text;
}

function optionalText(body, field, max) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined;
  return requireText(body[field], field, max);
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    throw badRequest('tags must be an array of strings.');
  }
  if (value.length > KNOWLEDGE_LIMITS.tagCount) {
    throw badRequest(`tags must contain at most ${KNOWLEDGE_LIMITS.tagCount} items.`);
  }
  const seen = new Set();
  const tags = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw badRequest('tags must be an array of strings.');
    }
    const tag = entry.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!tag) {
      throw badRequest('tags cannot contain empty values.');
    }
    if (tag.length > KNOWLEDGE_LIMITS.tag) {
      throw badRequest(`each tag must be at most ${KNOWLEDGE_LIMITS.tag} characters.`);
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
  if (!Object.prototype.hasOwnProperty.call(body, 'title')) {
    throw badRequest('title is required.');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'body')) {
    throw badRequest('body is required.');
  }
  return {
    title: requireText(body.title, 'title', KNOWLEDGE_LIMITS.title),
    body: requireText(body.body, 'body', KNOWLEDGE_LIMITS.body),
    sourceLabel: optionalText(body, 'sourceLabel', KNOWLEDGE_LIMITS.sourceLabel) || '',
    category: optionalText(body, 'category', KNOWLEDGE_LIMITS.category) || '',
    tags: Object.prototype.hasOwnProperty.call(body, 'tags') ? normalizeTags(body.tags) : [],
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
  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    patch.title = requireText(body.title, 'title', KNOWLEDGE_LIMITS.title);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'body')) {
    patch.body = requireText(body.body, 'body', KNOWLEDGE_LIMITS.body);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sourceLabel')) {
    patch.sourceLabel = requireText(body.sourceLabel, 'sourceLabel', KNOWLEDGE_LIMITS.sourceLabel);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'category')) {
    patch.category = requireText(body.category, 'category', KNOWLEDGE_LIMITS.category);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
    patch.tags = normalizeTags(body.tags);
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

  const page = readPositiveInt(query.page, 'page', { max: 100000, fallback: 1 });
  const limit = readPositiveInt(query.limit, 'limit', { max: 100, fallback: 20 });
  const filter = {};

  if (query.search != null) {
    const search = query.search.normalize('NFC').trim();
    if (!search) throw badRequest('search is required when provided.');
    if (search.length > KNOWLEDGE_LIMITS.search) {
      throw badRequest(`search must be at most ${KNOWLEDGE_LIMITS.search} characters.`);
    }
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { title: pattern },
      { body: pattern },
      { category: pattern },
      { sourceLabel: pattern },
      { tags: pattern },
    ];
  }

  if (query.category != null) {
    filter.category = requireText(query.category, 'category', KNOWLEDGE_LIMITS.category);
  }
  if (query.tag != null) {
    const [tag] = normalizeTags([query.tag]);
    filter.tags = tag;
  }
  if (query.active != null) {
    filter.active = readQueryFlag(query.active, 'active');
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
  KNOWLEDGE_LIMITS,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  KnowledgeInputError,
  parseCreateInput,
  parseUpdateInput,
  parseListQuery,
  isObjectIdString,
  escapeRegex,
};
