'use strict';

const mongoose = require('mongoose');
const AnswerStudioExample = require('../../models/AnswerStudioExample');
const {
  ExampleInputError,
  parseCreateInput,
  parseUpdateInput,
  parseListQuery,
  isObjectIdString,
} = require('./exampleValidation');

const STYLE_FIELDS = ['platform', 'question', 'answer', 'topic', 'styleTags'];

function toPublicExample(doc) {
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    platform: row.platform,
    question: row.question,
    answer: row.answer,
    topic: row.topic || '',
    styleTags: Array.isArray(row.styleTags) ? row.styleTags : [],
    status: row.status,
    active: row.active === true,
    isTestData: row.isTestData === true,
    hasEmbedding: Array.isArray(row.embedding) && row.embedding.length > 0,
    approvedBy: row.approvedBy ? String(row.approvedBy) : null,
    approvedAt: row.approvedAt || null,
    createdBy: row.createdBy ? String(row.createdBy) : null,
    updatedBy: row.updatedBy ? String(row.updatedBy) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function adminId(admin) {
  const id = admin && (admin._id || admin.id);
  if (!id) {
    throw new ExampleInputError('Authentication required', 401);
  }
  return id;
}

function requireExampleId(id) {
  if (!isObjectIdString(id)) {
    throw new ExampleInputError('Example id is invalid.', 400);
  }
}

async function embeddedIdSet(ids) {
  if (!ids.length) return new Set();
  const rows = await AnswerStudioExample.find({
    _id: { $in: ids },
    'embedding.0': { $exists: true },
  })
    .select('_id')
    .lean();
  return new Set(rows.map((row) => String(row._id)));
}

async function rejectMissingOrConflict(id, message) {
  const existing = await AnswerStudioExample.findById(id).select('status').lean();
  if (!existing) {
    throw new ExampleInputError('Example not found.', 404);
  }
  throw new ExampleInputError(message, 409, {
    code: 'INVALID_EXAMPLE_TRANSITION',
    currentStatus: existing.status,
  });
}

/**
 * Applies one status change only when the row is still in an allowed status at the
 * version read for this call. The filter is _id + status + __v, and the write
 * increments __v. Mongoose timestamps still maintain updatedAt.
 * Callers put status, active, and approval metadata in `changes` themselves.
 * Archive keeps approvedBy and approvedAt so the last approval remains auditable.
 * Revoke and reactivate clear that metadata because the example is no longer approved.
 */
async function transitionExample(id, fromStatuses, changes, conflictMessage) {
  requireExampleId(id);
  const existing = await AnswerStudioExample.findById(id).select('status __v').lean();
  if (!existing) {
    throw new ExampleInputError('Example not found.', 404);
  }
  if (!fromStatuses.includes(existing.status)) {
    throw new ExampleInputError(conflictMessage, 409, {
      code: 'INVALID_EXAMPLE_TRANSITION',
      currentStatus: existing.status,
    });
  }
  const updated = await AnswerStudioExample.findOneAndUpdate(
    { _id: id, status: existing.status, __v: existing.__v ?? 0 },
    { $set: changes, $inc: { __v: 1 } },
    { new: true }
  );
  if (!updated) {
    await rejectMissingOrConflict(id, conflictMessage);
  }
  return toPublicExample(updated);
}

async function createExample(body, admin) {
  const input = parseCreateInput(body || {});
  const actorId = adminId(admin);
  const doc = await AnswerStudioExample.create({
    platform: input.platform,
    question: input.question,
    answer: input.answer,
    topic: input.topic,
    styleTags: input.styleTags,
    status: 'draft',
    active: false,
    isTestData: input.isTestData,
    approvedBy: null,
    approvedAt: null,
    embedding: [],
    embeddingModel: '',
    embeddingDimensions: 1024,
    createdBy: actorId,
    updatedBy: actorId,
  });
  return toPublicExample(doc);
}

async function listExamples(query) {
  const parsed = parseListQuery(query || {});
  const [rows, total] = await Promise.all([
    AnswerStudioExample.find(parsed.filter)
      .sort(parsed.sort)
      .skip((parsed.page - 1) * parsed.limit)
      .limit(parsed.limit)
      .select('-embedding')
      .lean(),
    AnswerStudioExample.countDocuments(parsed.filter),
  ]);
  const embedded = await embeddedIdSet(rows.map((row) => row._id));
  return {
    data: rows.map((row) =>
      toPublicExample({
        ...row,
        embedding: embedded.has(String(row._id)) ? [0] : [],
      })
    ),
    pagination: {
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / parsed.limit),
    },
  };
}

async function getExample(id) {
  requireExampleId(id);
  const doc = await AnswerStudioExample.findById(id);
  if (!doc) {
    throw new ExampleInputError('Example not found.', 404);
  }
  return toPublicExample(doc);
}

// Tags are stored with the first spelling after trim and case-insensitive dedupe.
// ["Direct"] and ["direct"] are different persisted values. A patch that normalizes
// back to the same strings, including [" Direct ", "direct"] -> ["Direct"], is not a change.
function persistedTagsEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  return a.every((tag, index) => tag === b[index]);
}

function styleFieldChanged(doc, patch, field) {
  if (!Object.prototype.hasOwnProperty.call(patch, field)) return false;
  if (field === 'styleTags') return !persistedTagsEqual(doc.styleTags, patch.styleTags);
  return doc[field] !== patch[field];
}

async function updateExample(id, body, admin) {
  requireExampleId(id);
  const patch = parseUpdateInput(body || {});
  const actorId = adminId(admin);
  const doc = await AnswerStudioExample.findById(id);
  if (!doc) {
    throw new ExampleInputError('Example not found.', 404);
  }

  const styleChanged = STYLE_FIELDS.some((field) => styleFieldChanged(doc, patch, field));
  const contentChanged =
    styleFieldChanged(doc, patch, 'question') || styleFieldChanged(doc, patch, 'answer');
  const changes = { updatedBy: actorId };

  if (Object.prototype.hasOwnProperty.call(patch, 'platform')) changes.platform = patch.platform;
  if (Object.prototype.hasOwnProperty.call(patch, 'question')) changes.question = patch.question;
  if (Object.prototype.hasOwnProperty.call(patch, 'answer')) changes.answer = patch.answer;
  if (Object.prototype.hasOwnProperty.call(patch, 'topic')) changes.topic = patch.topic;
  if (Object.prototype.hasOwnProperty.call(patch, 'styleTags')) changes.styleTags = patch.styleTags;

  if (doc.status === 'approved' && styleChanged) {
    changes.status = 'draft';
    changes.active = false;
    changes.approvedBy = null;
    changes.approvedAt = null;
  } else if (doc.status !== 'approved') {
    changes.active = false;
  }

  if (contentChanged) {
    changes.embedding = [];
    changes.embeddingModel = '';
    changes.embeddingDimensions = 1024;
  }

  const updated = await AnswerStudioExample.findOneAndUpdate(
    { _id: doc._id, status: doc.status, __v: doc.__v ?? 0 },
    { $set: changes, $inc: { __v: 1 } },
    { new: true, runValidators: true }
  );
  if (!updated) {
    await rejectMissingOrConflict(
      id,
      'Example was updated concurrently. Retry the request.'
    );
  }
  return toPublicExample(updated);
}

async function approveExample(id, admin) {
  const actorId = adminId(admin);
  const now = new Date();
  return transitionExample(
    id,
    ['draft'],
    {
      status: 'approved',
      active: true,
      approvedBy: actorId,
      approvedAt: now,
      updatedBy: actorId,
    },
    'Only a draft example can be approved.'
  );
}

async function revokeExampleApproval(id, admin) {
  const actorId = adminId(admin);
  return transitionExample(
    id,
    ['approved'],
    {
      status: 'draft',
      active: false,
      approvedBy: null,
      approvedAt: null,
      updatedBy: actorId,
    },
    'Only an approved example can have its approval revoked.'
  );
}

async function archiveExample(id, admin) {
  const actorId = adminId(admin);
  return transitionExample(
    id,
    ['draft', 'approved'],
    {
      status: 'archived',
      active: false,
      updatedBy: actorId,
    },
    'Only a draft or approved example can be archived.'
  );
}

async function reactivateExample(id, admin) {
  const actorId = adminId(admin);
  return transitionExample(
    id,
    ['archived'],
    {
      status: 'draft',
      active: false,
      approvedBy: null,
      approvedAt: null,
      updatedBy: actorId,
    },
    'Only an archived example can be reactivated.'
  );
}

function sendExampleError(res, error) {
  if (error instanceof ExampleInputError || error?.statusCode) {
    const status = error.statusCode || 400;
    const payload = { success: false, message: error.message };
    if (error.code) payload.code = error.code;
    if (error.currentStatus) payload.currentStatus = error.currentStatus;
    return res.status(status).json(payload);
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const first = Object.values(error.errors || [])[0];
    return res.status(400).json({
      success: false,
      message: first?.message || 'Example is invalid.',
    });
  }
  console.error('[answer-studio] example error:', error);
  return res.status(500).json({ success: false, message: 'Something went wrong.' });
}

module.exports = {
  createExample,
  listExamples,
  getExample,
  updateExample,
  approveExample,
  revokeExampleApproval,
  archiveExample,
  reactivateExample,
  sendExampleError,
};
