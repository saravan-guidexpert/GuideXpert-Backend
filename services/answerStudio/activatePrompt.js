'use strict';

const mongoose = require('mongoose');
const AnswerStudioPrompt = require('../../models/AnswerStudioPrompt');

/**
 * Marks one stored prompt version active and deactivates every other active
 * prompt for the same platform. The partial unique index on platform is the
 * backstop if two activations race.
 * This is not an HTTP handler. Phase 1 does not expose prompt CRUD.
 */
async function activatePrompt(promptId, adminId) {
  if (!mongoose.isValidObjectId(promptId)) {
    const error = new Error('Prompt id is invalid');
    error.statusCode = 400;
    throw error;
  }
  if (!mongoose.isValidObjectId(adminId)) {
    const error = new Error('updatedBy admin is required');
    error.statusCode = 400;
    throw error;
  }

  const prompt = await AnswerStudioPrompt.findById(promptId);
  if (!prompt) {
    const error = new Error('Prompt not found');
    error.statusCode = 404;
    throw error;
  }

  await AnswerStudioPrompt.updateMany(
    { platform: prompt.platform, active: true, _id: { $ne: prompt._id } },
    { $set: { active: false, updatedBy: adminId } }
  );

  prompt.active = true;
  prompt.updatedBy = adminId;
  await prompt.save();
  return prompt;
}

module.exports = { activatePrompt };
