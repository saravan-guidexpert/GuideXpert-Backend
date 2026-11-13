'use strict';

const mongoose = require('mongoose');
const AnswerStudioPrompt = require('../../models/AnswerStudioPrompt');
const AnswerStudioPromptState = require('../../models/AnswerStudioPromptState');
const { requirePromptStateIndex } = require('./promptIndexes');

function promptError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * The platform state row is the only active-prompt selection.
 * Prompt.lifecycle and Prompt.active are updated afterward and can lag.
 * Generation must read the pointer, not Prompt.active.
 */
async function loadSingleState(platform) {
  await requirePromptStateIndex();
  const rows = await AnswerStudioPromptState.find({ platform });
  if (rows.length > 1) {
    throw promptError(
      'More than one prompt state exists for this platform.',
      503,
      'PROMPT_STATE_CONFLICT'
    );
  }
  if (rows.length === 1) return rows[0];
  try {
    return await AnswerStudioPromptState.create({
      platform,
      activePromptId: null,
      revision: 0,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const again = await AnswerStudioPromptState.find({ platform });
      if (again.length === 1) return again[0];
      throw promptError(
        'More than one prompt state exists for this platform.',
        503,
        'PROMPT_STATE_CONFLICT'
      );
    }
    throw error;
  }
}

async function confirmPointer(stateId, expectedPromptId) {
  const current = await AnswerStudioPromptState.findById(stateId).lean();
  if (!current) return null;
  const actual = current.activePromptId ? String(current.activePromptId) : null;
  const expected = expectedPromptId ? String(expectedPromptId) : null;
  if (actual !== expected) return null;
  return current;
}

async function writeActivationMetadata(platform, promptId, previousId, adminId, now) {
  if (previousId && String(previousId) !== String(promptId)) {
    await AnswerStudioPrompt.updateOne(
      { _id: previousId, platform },
      {
        $set: {
          lifecycle: 'inactive',
          active: false,
          updatedBy: adminId,
          deactivatedBy: adminId,
          deactivatedAt: now,
        },
      }
    );
  }
  await AnswerStudioPrompt.updateMany(
    { platform, _id: { $ne: promptId }, active: true },
    {
      $set: {
        lifecycle: 'inactive',
        active: false,
        updatedBy: adminId,
        deactivatedBy: adminId,
        deactivatedAt: now,
      },
    }
  );
  await AnswerStudioPrompt.updateOne(
    { _id: promptId, platform, lifecycle: 'draft' },
    {
      $set: {
        lifecycle: 'active',
        active: true,
        updatedBy: adminId,
        activatedBy: adminId,
        activatedAt: now,
        deactivatedBy: null,
        deactivatedAt: null,
      },
    }
  );
}

async function activatePrompt(promptId, adminId) {
  if (!mongoose.isValidObjectId(promptId)) {
    throw promptError('Prompt id is invalid.', 400, 'INVALID_PROMPT_ID');
  }
  if (!mongoose.isValidObjectId(adminId)) {
    throw promptError('updatedBy admin is required.', 400, 'ADMIN_REQUIRED');
  }

  const prompt = await AnswerStudioPrompt.findById(promptId);
  if (!prompt) {
    throw promptError('Prompt not found.', 404, 'PROMPT_NOT_FOUND');
  }
  if (prompt.lifecycle === 'inactive') {
    throw promptError('An inactive prompt cannot be activated. Create a new version.', 409, 'PROMPT_NOT_DRAFT');
  }

  const state = await loadSingleState(prompt.platform);
  if (prompt.lifecycle === 'active') {
    if (String(state.activePromptId || '') === String(prompt._id)) {
      const confirmed = await confirmPointer(state._id, prompt._id);
      if (!confirmed) {
        throw promptError('Another prompt is already active for this platform.', 409, 'ACTIVE_PROMPT_CONFLICT');
      }
      throw promptError('This prompt is already active.', 409, 'PROMPT_ALREADY_ACTIVE');
    }
    throw promptError('Only a draft prompt can be activated.', 409, 'PROMPT_NOT_DRAFT');
  }
  if (prompt.lifecycle !== 'draft') {
    throw promptError('Only a draft prompt can be activated.', 409, 'PROMPT_NOT_DRAFT');
  }

  const now = new Date();
  const previousId = state.activePromptId || null;
  const updated = await AnswerStudioPromptState.findOneAndUpdate(
    { _id: state._id, platform: prompt.platform, revision: state.revision },
    {
      $set: {
        activePromptId: prompt._id,
        updatedBy: adminId,
      },
      $inc: { revision: 1 },
    },
    { new: true }
  );
  if (!updated || String(updated.activePromptId) !== String(prompt._id)) {
    throw promptError(
      'Another prompt is already active for this platform.',
      409,
      'ACTIVE_PROMPT_CONFLICT'
    );
  }

  const held = await confirmPointer(updated._id, prompt._id);
  if (!held || held.revision !== updated.revision) {
    throw promptError(
      'Another prompt is already active for this platform.',
      409,
      'ACTIVE_PROMPT_CONFLICT'
    );
  }

  try {
    await writeActivationMetadata(prompt.platform, prompt._id, previousId, adminId, now);
  } catch (error) {
    const stillHeld = await confirmPointer(updated._id, prompt._id);
    if (!stillHeld) {
      throw promptError(
        'Another prompt is already active for this platform.',
        409,
        'ACTIVE_PROMPT_CONFLICT'
      );
    }
    if (!(error && error.code === 11000)) throw error;
  }

  const finalState = await confirmPointer(updated._id, prompt._id);
  if (!finalState) {
    throw promptError(
      'Another prompt is already active for this platform.',
      409,
      'ACTIVE_PROMPT_CONFLICT'
    );
  }
  const stored = await AnswerStudioPrompt.findById(prompt._id);
  return stored || prompt;
}

async function deactivatePrompt(promptId, adminId) {
  if (!mongoose.isValidObjectId(promptId)) {
    throw promptError('Prompt id is invalid.', 400, 'INVALID_PROMPT_ID');
  }
  if (!mongoose.isValidObjectId(adminId)) {
    throw promptError('updatedBy admin is required.', 400, 'ADMIN_REQUIRED');
  }

  const prompt = await AnswerStudioPrompt.findById(promptId);
  if (!prompt) {
    throw promptError('Prompt not found.', 404, 'PROMPT_NOT_FOUND');
  }

  const state = await loadSingleState(prompt.platform);
  if (String(state.activePromptId || '') !== String(prompt._id)) {
    throw promptError('Only the active prompt can be deactivated.', 409, 'PROMPT_NOT_ACTIVE');
  }

  const now = new Date();
  const updated = await AnswerStudioPromptState.findOneAndUpdate(
    {
      _id: state._id,
      platform: prompt.platform,
      revision: state.revision,
      activePromptId: prompt._id,
    },
    {
      $set: {
        activePromptId: null,
        updatedBy: adminId,
      },
      $inc: { revision: 1 },
    },
    { new: true }
  );
  if (!updated) {
    throw promptError(
      'The active prompt changed before it could be deactivated.',
      409,
      'ACTIVE_PROMPT_CONFLICT'
    );
  }

  const cleared = await confirmPointer(updated._id, null);
  if (!cleared || cleared.revision !== updated.revision) {
    throw promptError(
      'The active prompt changed before it could be deactivated.',
      409,
      'ACTIVE_PROMPT_CONFLICT'
    );
  }

  await AnswerStudioPrompt.updateOne(
    { _id: prompt._id, platform: prompt.platform },
    {
      $set: {
        lifecycle: 'inactive',
        active: false,
        updatedBy: adminId,
        deactivatedBy: adminId,
        deactivatedAt: now,
      },
    }
  );
  return AnswerStudioPrompt.findById(prompt._id);
}

module.exports = {
  activatePrompt,
  deactivatePrompt,
  loadSingleState,
};
