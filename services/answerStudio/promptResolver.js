'use strict';

const AnswerStudioPrompt = require('../../models/AnswerStudioPrompt');
const defaultPrompts = require('./defaultPrompts');
const { GenerationError } = require('./generationValidation');

/**
 * Active database prompt first, then the version-controlled default.
 * The client cannot supply this text.
 */
async function resolveStudioPrompt(platform) {
  const active = await AnswerStudioPrompt.findOne({ platform, active: true }).lean();
  if (active && typeof active.body === 'string' && active.body.trim()) {
    return {
      source: 'database',
      key: active.key,
      version: active.version,
      body: active.body,
    };
  }

  const fallback = defaultPrompts.byPlatform[platform];
  if (!fallback || typeof fallback.body !== 'string' || !fallback.body.trim()) {
    throw new GenerationError(
      'Answer Studio prompt is not configured for this platform.',
      503,
      'PROMPT_NOT_CONFIGURED'
    );
  }

  return {
    source: 'default',
    key: fallback.key,
    version: fallback.version,
    body: fallback.body,
  };
}

module.exports = {
  resolveStudioPrompt,
};
