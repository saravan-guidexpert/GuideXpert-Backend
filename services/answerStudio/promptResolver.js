'use strict';

const AnswerStudioPrompt = require('../../models/AnswerStudioPrompt');
const AnswerStudioPromptState = require('../../models/AnswerStudioPromptState');
const defaultPrompts = require('./defaultPrompts');
const { GenerationError } = require('./generationValidation');

/**
 * Active database prompt first, then the version-controlled default.
 * The client cannot supply this text.
 */
async function resolveStudioPrompt(platform) {
  const states = await AnswerStudioPromptState.find({ platform }).lean();
  if (states.length > 1) {
    throw new GenerationError(
      'Answer Studio prompt state is ambiguous for this platform.',
      503,
      'PROMPT_STATE_CONFLICT'
    );
  }
  const pointer = states[0] && states[0].activePromptId;
  if (pointer) {
    const selected = await AnswerStudioPrompt.findById(pointer).lean();
    if (
      !selected ||
      selected.platform !== platform ||
      (selected.lifecycle !== 'active' && selected.lifecycle !== 'draft') ||
      typeof selected.body !== 'string' ||
      !selected.body.trim()
    ) {
      throw new GenerationError(
        'The active Answer Studio prompt is unavailable.',
        503,
        'PROMPT_STATE_INVALID'
      );
    }
    return {
      source: 'database',
      key: selected.key,
      version: selected.version,
      body: selected.body,
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
