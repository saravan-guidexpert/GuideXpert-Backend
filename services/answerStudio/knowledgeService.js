'use strict';

const mongoose = require('mongoose');
const AnswerStudioKnowledge = require('../../models/AnswerStudioKnowledge');
const { knowledgeContentHash } = require('./knowledgeContentHash');
const {
  KnowledgeInputError,
  parseCreateInput,
  parseUpdateInput,
  parseListQuery,
  isObjectIdString,
} = require('./knowledgeValidation');

function toPublicKnowledge(doc) {
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    title: row.title,
    body: row.body,
    sourceLabel: row.sourceLabel || '',
    category: row.category || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    contentHash: row.contentHash,
    active: row.active === true,
    isTestData: row.isTestData === true,
    hasEmbedding: Array.isArray(row.embedding) && row.embedding.length > 0,
    createdBy: row.createdBy ? String(row.createdBy) : null,
    updatedBy: row.updatedBy ? String(row.updatedBy) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function adminId(admin) {
  const id = admin && (admin._id || admin.id);
  if (!id) {
    throw new KnowledgeInputError('Authentication required', 401);
  }
  return id;
}

async function findActiveDuplicate(contentHash, excludeId) {
  const filter = { contentHash, active: true };
  if (excludeId) filter._id = { $ne: excludeId };
  return AnswerStudioKnowledge.findOne(filter).select('_id').lean();
}

function duplicateError(existing) {
  return new KnowledgeInputError(
    'An active knowledge record with the same content already exists.',
    409,
    { code: 'DUPLICATE_KNOWLEDGE', existingId: String(existing._id) }
  );
}

function clearStaleEmbedding(doc) {
  doc.embedding = [];
  doc.embeddingModel = '';
  doc.embedText = '';
  doc.embeddingDimensions = 1024;
}

async function createKnowledge(body, admin) {
  const input = parseCreateInput(body || {});
  const actorId = adminId(admin);
  const contentHash = knowledgeContentHash(input.title, input.body);
  const existing = await findActiveDuplicate(contentHash);
  if (existing) throw duplicateError(existing);

  const doc = await AnswerStudioKnowledge.create({
    title: input.title,
    body: input.body,
    sourceLabel: input.sourceLabel,
    category: input.category,
    tags: input.tags,
    contentHash,
    embedding: [],
    embeddingModel: '',
    embedText: '',
    active: true,
    isTestData: input.isTestData,
    createdBy: actorId,
    updatedBy: actorId,
  });
  return toPublicKnowledge(doc);
}

async function embeddedIdSet(ids) {
  if (!ids.length) return new Set();
  const rows = await AnswerStudioKnowledge.find({
    _id: { $in: ids },
    'embedding.0': { $exists: true },
  })
    .select('_id')
    .lean();
  return new Set(rows.map((row) => String(row._id)));
}

async function listKnowledge(query) {
  const parsed = parseListQuery(query || {});
  const [rows, total] = await Promise.all([
    AnswerStudioKnowledge.find(parsed.filter)
      .sort(parsed.sort)
      .skip((parsed.page - 1) * parsed.limit)
      .limit(parsed.limit)
      .select('-embedding')
      .lean(),
    AnswerStudioKnowledge.countDocuments(parsed.filter),
  ]);
  const embedded = await embeddedIdSet(rows.map((row) => row._id));
  return {
    data: rows.map((row) =>
      toPublicKnowledge({
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

async function getKnowledge(id) {
  if (!isObjectIdString(id)) {
    throw new KnowledgeInputError('Knowledge id is invalid.', 400);
  }
  const doc = await AnswerStudioKnowledge.findById(id);
  if (!doc) {
    throw new KnowledgeInputError('Knowledge record not found.', 404);
  }
  return toPublicKnowledge(doc);
}

async function updateKnowledge(id, body, admin) {
  if (!isObjectIdString(id)) {
    throw new KnowledgeInputError('Knowledge id is invalid.', 400);
  }
  const patch = parseUpdateInput(body || {});
  const actorId = adminId(admin);
  const doc = await AnswerStudioKnowledge.findById(id);
  if (!doc) {
    throw new KnowledgeInputError('Knowledge record not found.', 404);
  }

  const nextTitle = Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title : doc.title;
  const nextBody = Object.prototype.hasOwnProperty.call(patch, 'body') ? patch.body : doc.body;
  const factualChange = nextTitle !== doc.title || nextBody !== doc.body;

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) doc.title = patch.title;
  if (Object.prototype.hasOwnProperty.call(patch, 'body')) doc.body = patch.body;
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceLabel')) doc.sourceLabel = patch.sourceLabel;
  if (Object.prototype.hasOwnProperty.call(patch, 'category')) doc.category = patch.category;
  if (Object.prototype.hasOwnProperty.call(patch, 'tags')) doc.tags = patch.tags;

  if (factualChange) {
    const contentHash = knowledgeContentHash(doc.title, doc.body);
    if (contentHash !== doc.contentHash) {
      const existing = await findActiveDuplicate(contentHash, doc._id);
      if (existing) throw duplicateError(existing);
      doc.contentHash = contentHash;
    }
    clearStaleEmbedding(doc);
  }

  doc.updatedBy = actorId;
  await doc.save();
  return toPublicKnowledge(doc);
}

async function deactivateKnowledge(id, admin) {
  if (!isObjectIdString(id)) {
    throw new KnowledgeInputError('Knowledge id is invalid.', 400);
  }
  const actorId = adminId(admin);
  const doc = await AnswerStudioKnowledge.findById(id);
  if (!doc) {
    throw new KnowledgeInputError('Knowledge record not found.', 404);
  }
  doc.active = false;
  doc.updatedBy = actorId;
  await doc.save();
  return toPublicKnowledge(doc);
}

function sendKnowledgeError(res, error) {
  if (error instanceof KnowledgeInputError || error?.statusCode) {
    const status = error.statusCode || 400;
    const payload = { success: false, message: error.message };
    if (error.code) payload.code = error.code;
    if (error.existingId) payload.existingId = String(error.existingId);
    return res.status(status).json(payload);
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const first = Object.values(error.errors || [])[0];
    return res.status(400).json({
      success: false,
      message: first?.message || 'Knowledge record is invalid.',
    });
  }
  console.error('[answer-studio] knowledge error:', error);
  return res.status(500).json({ success: false, message: 'Something went wrong.' });
}

module.exports = {
  createKnowledge,
  listKnowledge,
  getKnowledge,
  updateKnowledge,
  deactivateKnowledge,
  sendKnowledgeError,
  toPublicKnowledge,
};
