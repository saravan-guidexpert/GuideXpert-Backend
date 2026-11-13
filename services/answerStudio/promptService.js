'use strict';

const mongoose = require('mongoose');
const AnswerStudioPrompt = require('../../models/AnswerStudioPrompt');
const { activatePrompt, deactivatePrompt } = require('./activatePrompt');
const { requirePromptVersionIndex } = require('./promptIndexes');
const {
  PromptInputError,
  parseCreateInput,
  parseVersionInput,
  parseListQuery,
  isObjectIdString,
} = require('./promptValidation');

const VERSION_ATTEMPTS = 8;

function adminId(admin) {
  const id = admin && (admin._id || admin.id);
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new PromptInputError('Authentication required.', 401, 'ADMIN_REQUIRED');
  }
  return id;
}

function requirePromptId(id) {
  if (!isObjectIdString(id)) {
    throw new PromptInputError('Prompt id is invalid.', 400, 'INVALID_PROMPT_ID');
  }
}

function toPublicPrompt(doc, { includeBody }) {
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const payload = {
    id: String(row._id),
    key: row.key,
    platform: row.platform,
    version: row.version,
    lifecycle: row.lifecycle || 'draft',
    active: (row.lifecycle || 'draft') === 'active',
    createdBy: row.createdBy ? String(row.createdBy) : null,
    updatedBy: row.updatedBy ? String(row.updatedBy) : null,
    activatedBy: row.activatedBy ? String(row.activatedBy) : null,
    activatedAt: row.activatedAt || null,
    deactivatedBy: row.deactivatedBy ? String(row.deactivatedBy) : null,
    deactivatedAt: row.deactivatedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (includeBody) payload.body = row.body;
  return payload;
}

function sendPromptError(res, error) {
  if (error instanceof PromptInputError || (error && error.statusCode && error.code)) {
    const payload = { success: false, message: error.message };
    if (error.code) payload.code = error.code;
    return res.status(error.statusCode || 400).json(payload);
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const first = Object.values(error.errors || [])[0];
    return res.status(400).json({
      success: false,
      message: first?.message || 'Prompt is invalid.',
      code: 'INVALID_PROMPT',
    });
  }
  console.error(
    '[answer-studio] prompt error:',
    error?.name || 'Error',
    error?.statusCode || '',
    error?.code || ''
  );
  return res.status(500).json({ success: false, message: 'Something went wrong.' });
}

async function createPrompt(body, admin) {
  await requirePromptVersionIndex();
  const input = parseCreateInput(body || {});
  const actorId = adminId(admin);
  const existing = await AnswerStudioPrompt.findOne({ key: input.key }).select('_id').lean();
  if (existing) {
    throw new PromptInputError(
      'A prompt with this key already exists. Create a new version instead.',
      409,
      'DUPLICATE_PROMPT_KEY'
    );
  }
  try {
    const doc = await AnswerStudioPrompt.create({
      key: input.key,
      platform: input.platform,
      body: input.body,
      version: 1,
      lifecycle: 'draft',
      active: false,
      createdBy: actorId,
      updatedBy: actorId,
      activatedBy: null,
      activatedAt: null,
      deactivatedBy: null,
      deactivatedAt: null,
    });
    return toPublicPrompt(doc, { includeBody: true });
  } catch (error) {
    if (error && error.code === 11000) {
      throw new PromptInputError(
        'A prompt with this key already exists. Create a new version instead.',
        409,
        'DUPLICATE_PROMPT_KEY'
      );
    }
    throw error;
  }
}

async function listPrompts(query) {
  const parsed = parseListQuery(query || {});
  const [rows, total] = await Promise.all([
    AnswerStudioPrompt.find(parsed.filter)
      .sort({ key: 1, version: -1 })
      .skip((parsed.page - 1) * parsed.limit)
      .limit(parsed.limit)
      .select('-body')
      .lean(),
    AnswerStudioPrompt.countDocuments(parsed.filter),
  ]);
  return {
    data: rows.map((row) => toPublicPrompt(row, { includeBody: false })),
    pagination: {
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / parsed.limit),
    },
  };
}

async function getPrompt(id) {
  requirePromptId(id);
  const doc = await AnswerStudioPrompt.findById(id);
  if (!doc) {
    throw new PromptInputError('Prompt not found.', 404, 'PROMPT_NOT_FOUND');
  }
  return toPublicPrompt(doc, { includeBody: true });
}

async function createPromptVersion(id, body, admin) {
  requirePromptId(id);
  await requirePromptVersionIndex();
  const input = parseVersionInput(body || {});
  const actorId = adminId(admin);
  const source = await AnswerStudioPrompt.findById(id).lean();
  if (!source) {
    throw new PromptInputError('Prompt not found.', 404, 'PROMPT_NOT_FOUND');
  }
  const nextBody = input.body == null ? source.body : input.body;

  for (let attempt = 0; attempt < VERSION_ATTEMPTS; attempt += 1) {
    const latest = await AnswerStudioPrompt.findOne({ key: source.key })
      .sort({ version: -1 })
      .select('version')
      .lean();
    const nextVersion = (latest && Number.isInteger(latest.version) ? latest.version : 0) + 1;
    try {
      const doc = await AnswerStudioPrompt.create({
        key: source.key,
        platform: source.platform,
        body: nextBody,
        version: nextVersion,
        lifecycle: 'draft',
        active: false,
        createdBy: actorId,
        updatedBy: actorId,
        activatedBy: null,
        activatedAt: null,
        deactivatedBy: null,
        deactivatedAt: null,
      });
      return toPublicPrompt(doc, { includeBody: true });
    } catch (error) {
      if (error && error.code === 11000 && attempt < VERSION_ATTEMPTS - 1) continue;
      if (error && error.code === 11000) {
        throw new PromptInputError(
          'The next prompt version could not be reserved.',
          409,
          'VERSION_CONFLICT'
        );
      }
      throw error;
    }
  }
  throw new PromptInputError('The next prompt version could not be reserved.', 409, 'VERSION_CONFLICT');
}

async function activatePromptVersion(id, admin) {
  requirePromptId(id);
  const actorId = adminId(admin);
  const doc = await activatePrompt(id, actorId);
  return toPublicPrompt(doc, { includeBody: true });
}

async function deactivatePromptVersion(id, admin) {
  requirePromptId(id);
  const actorId = adminId(admin);
  const doc = await deactivatePrompt(id, actorId);
  return toPublicPrompt(doc, { includeBody: true });
}

module.exports = {
  createPrompt,
  listPrompts,
  getPrompt,
  createPromptVersion,
  activatePromptVersion,
  deactivatePromptVersion,
  sendPromptError,
};
