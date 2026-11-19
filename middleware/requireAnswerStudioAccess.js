'use strict';

const requireAdminSection = require('./requireAdminSection');
const {
  ANSWER_STUDIO_SECTION_KEY,
  QUORA_REDDIT_PROMPT_SECTION_KEY,
} = require('../services/answerStudio/constants');

const answerStudioSection = requireAdminSection(
  ANSWER_STUDIO_SECTION_KEY,
  'Answer Studio access is required.'
);

/**
 * Answer Studio stays on its own section. The Quora and Reddit prompt page
 * can also be opened by an admin granted that section alone.
 */
function requireAnswerStudioAccess(req, res, next) {
  const access = req.admin && Array.isArray(req.admin.sectionAccess) ? req.admin.sectionAccess : [];
  const promptRequest = req.path === '/prompts' || req.path.startsWith('/prompts/');
  if (
    req.admin &&
    req.admin.isSuperAdmin !== true &&
    promptRequest &&
    access.includes(QUORA_REDDIT_PROMPT_SECTION_KEY)
  ) {
    return next();
  }
  return answerStudioSection(req, res, next);
}

module.exports = requireAnswerStudioAccess;
