'use strict';

const { ANSWER_STUDIO_PLATFORMS } = require('./constants');

const QUESTION_LIMIT = 8000;
const ANSWER_LIMIT = 32000;
const GENERATE_FIELDS = Object.freeze(['platform', 'question']);

class GenerationError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = 'GenerationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function badRequest(message) {
  return new GenerationError(message, 400);
}

function assertSafeKey(key) {
  if (typeof key !== 'string' || !key || key.includes('$') || key.includes('.')) {
    throw badRequest('Request fields are invalid.');
  }
}

function assertPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw badRequest('Request body must be a JSON object.');
  }
}

function normalizeQuestion(value) {
  const text = String(value || '').normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseGenerateInput(body) {
  assertPlainObject(body);
  const allowed = new Set(GENERATE_FIELDS);
  for (const key of Object.keys(body)) {
    assertSafeKey(key);
    if (!allowed.has(key)) {
      throw badRequest(`Field \`${key}\` cannot be set.`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'platform')) {
    throw badRequest('platform is required.');
  }
  if (typeof body.platform !== 'string') {
    throw badRequest('platform must be quora or reddit.');
  }
  const platform = body.platform.normalize('NFC').trim().toLowerCase();
  if (!ANSWER_STUDIO_PLATFORMS.includes(platform)) {
    throw badRequest('platform must be quora or reddit.');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'question')) {
    throw badRequest('question is required.');
  }
  if (typeof body.question !== 'string') {
    throw badRequest('question must be a string.');
  }
  const question = normalizeQuestion(body.question);
  if (!question) {
    throw badRequest('question is required.');
  }
  if (question.length > QUESTION_LIMIT) {
    throw badRequest(`question must be at most ${QUESTION_LIMIT} characters.`);
  }
  return { platform, question };
}

function readUsage(usage) {
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const read = (camel, snake) => {
    const value = usage[camel] ?? usage[snake];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  };
  const promptTokens = read('promptTokens', 'prompt_tokens');
  const completionTokens = read('completionTokens', 'completion_tokens');
  const totalTokens = read('totalTokens', 'total_tokens');
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
  const stored = {};
  if (promptTokens != null) stored.promptTokens = promptTokens;
  if (completionTokens != null) stored.completionTokens = completionTokens;
  if (totalTokens != null) stored.totalTokens = totalTokens;
  return stored;
}

function sendGenerationError(res, error) {
  if (error instanceof GenerationError || (error && error.statusCode && error.name === 'GenerationError')) {
    const payload = { success: false, message: error.message };
    if (error.code) payload.code = error.code;
    return res.status(error.statusCode || 400).json(payload);
  }
  console.error(
    '[answer-studio] generation error:',
    error?.name || 'Error',
    error?.status || '',
    error?.code || ''
  );
  return res.status(500).json({ success: false, message: 'Something went wrong.' });
}

module.exports = {
  QUESTION_LIMIT,
  ANSWER_LIMIT,
  GenerationError,
  parseGenerateInput,
  readUsage,
  sendGenerationError,
};
