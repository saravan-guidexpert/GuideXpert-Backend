'use strict';

/**
 * Answer Studio constants.
 * Embedding width must stay equal to services/ai/embeddingService DEFAULT_DIMENSIONS.
 * Phase 1 does not generate embeddings.
 */
const ANSWER_STUDIO_EMBEDDING_DIMENSIONS = 1024;
const ANSWER_STUDIO_SECTION_KEY = 'answer-studio';
const ANSWER_STUDIO_PLATFORMS = Object.freeze(['quora', 'reddit']);
const ANSWER_STUDIO_EXAMPLE_STATUSES = Object.freeze(['draft', 'approved', 'archived']);
const ANSWER_STUDIO_GENERATION_STATUSES = Object.freeze([
  'generated',
  'edited',
  'copied',
  'promoted',
]);

module.exports = {
  ANSWER_STUDIO_EMBEDDING_DIMENSIONS,
  ANSWER_STUDIO_SECTION_KEY,
  ANSWER_STUDIO_PLATFORMS,
  ANSWER_STUDIO_EXAMPLE_STATUSES,
  ANSWER_STUDIO_GENERATION_STATUSES,
};
