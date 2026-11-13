'use strict';

const AnswerStudioPrompt = require('../../models/AnswerStudioPrompt');
const AnswerStudioPromptState = require('../../models/AnswerStudioPromptState');

function indexError(message, code) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = code;
  return error;
}

function sameKey(actual, expected) {
  const actualKeys = Object.keys(actual || {});
  const expectedKeys = Object.keys(expected || {});
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

async function readIndexes(model) {
  return model.collection.indexes();
}

async function requirePromptVersionIndex() {
  const indexes = await readIndexes(AnswerStudioPrompt);
  const found = indexes.some(
    (index) => index.unique === true && sameKey(index.key, { key: 1, version: 1 })
  );
  if (!found) {
    throw indexError(
      'Prompt version uniqueness is not installed. Run the Answer Studio prompt index migration.',
      'PROMPT_INDEX_REQUIRED'
    );
  }
}

async function requirePromptStateIndex() {
  const indexes = await readIndexes(AnswerStudioPromptState);
  const found = indexes.some(
    (index) => index.unique === true && sameKey(index.key, { platform: 1 })
  );
  if (!found) {
    throw indexError(
      'Prompt state uniqueness is not installed. Run the Answer Studio prompt index migration.',
      'PROMPT_INDEX_REQUIRED'
    );
  }
}

module.exports = {
  sameKey,
  requirePromptVersionIndex,
  requirePromptStateIndex,
};
