'use strict';

const { ANSWER_STUDIO_EMBEDDING_DIMENSIONS } = require('./constants');

function isValidEmbedding(value, dimensions = ANSWER_STUDIO_EMBEDDING_DIMENSIONS) {
  if (value == null) return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  if (value.length !== dimensions) return false;
  return value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function embeddingValidator(dimensions = ANSWER_STUDIO_EMBEDDING_DIMENSIONS) {
  return {
    validator(value) {
      return isValidEmbedding(value, dimensions);
    },
    message: `embedding must be empty or contain exactly ${dimensions} finite numbers`,
  };
}

module.exports = {
  isValidEmbedding,
  embeddingValidator,
};
