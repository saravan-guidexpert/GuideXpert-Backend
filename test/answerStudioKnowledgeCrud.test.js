'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'answer-studio-knowledge-crud-secret';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const answerStudioRoutes = require('../routes/answerStudioRoutes');
const { ANSWER_STUDIO_SECTION_KEY } = require('../services/answerStudio/constants');
const Admin = require('../models/Admin');
const AnswerStudioKnowledge = require('../models/AnswerStudioKnowledge');
const AnswerStudioGeneration = require('../models/AnswerStudioGeneration');

let mongo;
let server;
let baseUrl;
let superAdmin;
let editorAdmin;
let superToken;
let editorToken;
let sectionToken;
let otherToken;

function sign(admin) {
  return jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function request(method, urlPath, { token = superToken, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function fact(overrides = {}) {
  return {
    title: 'Engineering College Selection',
    body: 'Information about selecting an engineering college.',
    sourceLabel: 'Admin Knowledge Entry',
    category: 'College Admissions',
    tags: ['engineering', 'college', 'admissions'],
    isTestData: false,
    ...overrides,
  };
}

describe('Answer Studio knowledge CRUD', { timeout: 120000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'answer_studio_knowledge_crud' });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/admin/answer-studio',
      requireAdmin,
      requireAdminSection(ANSWER_STUDIO_SECTION_KEY, 'Answer Studio access is required.'),
      answerStudioRoutes
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    superAdmin = await Admin.create({
      username: 'knowledge-super',
      password: 'secret12',
      name: 'Knowledge Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    editorAdmin = await Admin.create({
      username: 'knowledge-editor',
      password: 'secret12',
      name: 'Knowledge Editor',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const sectionAdmin = await Admin.create({
      username: 'knowledge-section',
      password: 'secret12',
      name: 'Knowledge Section',
      isSuperAdmin: false,
      sectionAccess: [ANSWER_STUDIO_SECTION_KEY],
    });
    const otherAdmin = await Admin.create({
      username: 'knowledge-other',
      password: 'secret12',
      name: 'Knowledge Other',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    superToken = sign(superAdmin);
    editorToken = sign(editorAdmin);
    sectionToken = sign(sectionAdmin);
    otherToken = sign(otherAdmin);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await AnswerStudioKnowledge.deleteMany({});
    await AnswerStudioGeneration.deleteMany({});
  });

  test('empty collection lists 200 and does not block creation', async () => {
    const listed = await request('GET', '/api/admin/answer-studio/knowledge');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.data, []);
    assert.deepEqual(listed.data.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });

    const created = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    assert.equal(created.status, 201);
    assert.equal(created.data.data.title, 'Engineering College Selection');
    assert.equal(created.data.data.active, true);
    assert.equal(created.data.data.isTestData, false);
    assert.equal(created.data.data.hasEmbedding, false);
    assert.equal(created.data.data.embedding, undefined);
    assert.equal(created.data.data.createdBy, String(superAdmin._id));
    assert.equal(created.data.data.updatedBy, String(superAdmin._id));
    assert.equal(created.data.data.contentHash.length, 64);
  });

  test('rejects missing, empty, oversized, invalid, unknown, and protected create fields', async () => {
    const missingTitle = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ title: undefined }),
    });
    assert.equal(missingTitle.status, 400);

    const missingBody = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: { title: 'Title only' },
    });
    assert.equal(missingBody.status, 400);

    const emptyBody = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ body: '   ' }),
    });
    assert.equal(emptyBody.status, 400);

    const oversized = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ body: 'a'.repeat(50001) }),
    });
    assert.equal(oversized.status, 400);

    const badTags = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ tags: ['engineering', 12] }),
    });
    assert.equal(badTags.status, 400);

    const unknown = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ note: 'nope' }),
    });
    assert.equal(unknown.status, 400);

    const otherAdminId = new mongoose.Types.ObjectId();
    const forgedAuthor = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ createdBy: String(otherAdminId) }),
    });
    assert.equal(forgedAuthor.status, 400);

    const forgedVector = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ embedding: [0.1, 0.2] }),
    });
    assert.equal(forgedVector.status, 400);
    assert.equal(await AnswerStudioKnowledge.countDocuments(), 0);
  });

  test('duplicate active content returns 409 and a deactivated fact can be created again', async () => {
    const first = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ sourceLabel: 'First source' }),
    });
    assert.equal(first.status, 201);
    const duplicate = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ sourceLabel: 'Second source', tags: ['other'] }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'DUPLICATE_KNOWLEDGE');
    assert.equal(duplicate.data.existingId, first.data.data.id);
    assert.match(duplicate.data.message, /already exists/);

    const removed = await request('DELETE', `/api/admin/answer-studio/knowledge/${first.data.data.id}`);
    assert.equal(removed.status, 200);
    const recreated = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    assert.equal(recreated.status, 201);
    assert.notEqual(recreated.data.data.id, first.data.data.id);
  });

  test('lists with pagination, search, category, active, and test-data filters', async () => {
    const engineering = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    const cpp = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({
        title: 'C++ admissions',
        body: 'A different fact about the C++ language.',
        category: 'Programming',
        tags: ['cpp'],
        isTestData: true,
      }),
    });
    const inactive = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({
        title: 'Archived fact',
        body: 'This fact is only for the inactive filter.',
        category: 'Archive',
        tags: ['archive'],
      }),
    });
    assert.equal(engineering.status, 201);
    assert.equal(cpp.status, 201);
    assert.equal(inactive.status, 201);
    await request('DELETE', `/api/admin/answer-studio/knowledge/${inactive.data.data.id}`);

    const page = await request(
      'GET',
      '/api/admin/answer-studio/knowledge?page=1&limit=1&sort=createdAt&order=asc'
    );
    assert.equal(page.status, 200);
    assert.equal(page.data.data.length, 1);
    assert.equal(page.data.pagination.total, 3);
    assert.equal(page.data.pagination.totalPages, 3);
    assert.equal(page.data.data[0].embedding, undefined);

    const search = await request('GET', '/api/admin/answer-studio/knowledge?search=engineering');
    assert.equal(search.status, 200);
    assert.equal(search.data.data.length, 1);
    assert.equal(search.data.data[0].id, engineering.data.data.id);

    const literal = await request(
      'GET',
      `/api/admin/answer-studio/knowledge?search=${encodeURIComponent('C++')}`
    );
    assert.equal(literal.status, 200);
    assert.equal(literal.data.data.length, 1);
    assert.equal(literal.data.data[0].id, cpp.data.data.id);

    const wildcard = await request(
      'GET',
      `/api/admin/answer-studio/knowledge?search=${encodeURIComponent('.*')}`
    );
    assert.equal(wildcard.status, 200);
    assert.deepEqual(wildcard.data.data, []);

    const category = await request(
      'GET',
      `/api/admin/answer-studio/knowledge?category=${encodeURIComponent('Programming')}`
    );
    assert.equal(category.data.data.length, 1);
    assert.equal(category.data.data[0].id, cpp.data.data.id);

    const active = await request('GET', '/api/admin/answer-studio/knowledge?active=true');
    assert.equal(active.data.pagination.total, 2);
    assert.ok(active.data.data.every((row) => row.active === true));

    const testsOnly = await request('GET', '/api/admin/answer-studio/knowledge?isTestData=true');
    assert.equal(testsOnly.data.data.length, 1);
    assert.equal(testsOnly.data.data[0].isTestData, true);

    const productionOnly = await request('GET', '/api/admin/answer-studio/knowledge?isTestData=false');
    assert.ok(productionOnly.data.data.every((row) => row.isTestData === false));
  });

  test('gets one record, rejects a bad id, and returns 404 when missing', async () => {
    const created = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    const loaded = await request('GET', `/api/admin/answer-studio/knowledge/${created.data.data.id}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.data.data.body, fact().body);
    assert.equal(loaded.data.data.embedding, undefined);

    const badId = await request('GET', '/api/admin/answer-studio/knowledge/not-an-id');
    assert.equal(badId.status, 400);

    const missing = await request(
      'GET',
      '/api/admin/answer-studio/knowledge/507f1f77bcf86cd799439011'
    );
    assert.equal(missing.status, 404);
  });

  test('updates allowed fields, preserves the rest, rejects protected fields, and clears stale embeddings', async () => {
    const created = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    const id = created.data.data.id;
    await AnswerStudioKnowledge.updateOne(
      { _id: id },
      {
        $set: {
          embedding: Array.from({ length: 1024 }, () => 0.2),
          embeddingModel: 'nvidia/llama-nemotron-embed-1b-v2',
          embedText: 'old embedded text',
        },
      }
    );

    const titleOnly = await request('PATCH', `/api/admin/answer-studio/knowledge/${id}`, {
      token: editorToken,
      body: { title: 'Updated college selection' },
    });
    assert.equal(titleOnly.status, 200);
    assert.equal(titleOnly.data.data.title, 'Updated college selection');
    assert.equal(titleOnly.data.data.body, fact().body);
    assert.equal(titleOnly.data.data.category, 'College Admissions');
    assert.equal(titleOnly.data.data.createdBy, String(superAdmin._id));
    assert.equal(titleOnly.data.data.updatedBy, String(editorAdmin._id));
    assert.notEqual(titleOnly.data.data.contentHash, created.data.data.contentHash);
    assert.equal(titleOnly.data.data.hasEmbedding, false);

    const stored = await AnswerStudioKnowledge.findById(id).lean();
    assert.deepEqual(stored.embedding, []);
    assert.equal(stored.embeddingModel, '');
    assert.equal(stored.embedText, '');
    assert.equal(stored.embeddingDimensions, 1024);

    await AnswerStudioKnowledge.updateOne(
      { _id: id },
      { $set: { embedding: Array.from({ length: 1024 }, () => 0.3), embeddingModel: 'kept-model' } }
    );
    const labelOnly = await request('PATCH', `/api/admin/answer-studio/knowledge/${id}`, {
      body: { sourceLabel: 'Revised source' },
    });
    assert.equal(labelOnly.status, 200);
    assert.equal(labelOnly.data.data.hasEmbedding, true);
    const kept = await AnswerStudioKnowledge.findById(id).select('embedding embeddingModel').lean();
    assert.equal(kept.embedding.length, 1024);
    assert.equal(kept.embeddingModel, 'kept-model');

    const unknown = await request('PATCH', `/api/admin/answer-studio/knowledge/${id}`, {
      body: { popularity: 1 },
    });
    assert.equal(unknown.status, 400);

    const protectedFields = await request('PATCH', `/api/admin/answer-studio/knowledge/${id}`, {
      body: {
        createdBy: String(editorAdmin._id),
        contentHash: 'f'.repeat(64),
        embedding: [0.5],
        isTestData: true,
      },
    });
    assert.equal(protectedFields.status, 400);
    const unchanged = await AnswerStudioKnowledge.findById(id).lean();
    assert.equal(String(unchanged.createdBy), String(superAdmin._id));
    assert.equal(unchanged.isTestData, false);
    assert.notEqual(unchanged.contentHash, 'f'.repeat(64));
  });

  test('duplicate update returns 409 and does not overwrite the other record', async () => {
    const first = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    const second = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: fact({ title: 'Another fact', body: 'Completely different body.' }),
    });
    const conflict = await request('PATCH', `/api/admin/answer-studio/knowledge/${second.data.data.id}`, {
      body: { title: fact().title, body: fact().body },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'DUPLICATE_KNOWLEDGE');
    assert.equal(conflict.data.existingId, first.data.data.id);
    const stored = await AnswerStudioKnowledge.findById(second.data.data.id).lean();
    assert.equal(stored.body, 'Completely different body.');
  });

  test('soft deactivation keeps the document, is idempotent, and keeps generation references', async () => {
    const created = await request('POST', '/api/admin/answer-studio/knowledge', { body: fact() });
    const id = created.data.data.id;
    const generation = await AnswerStudioGeneration.create({
      platform: 'quora',
      question: 'Which college?',
      rawAnswer: 'Use the recorded facts.',
      knowledgeReferences: [id],
    });

    const first = await request('DELETE', `/api/admin/answer-studio/knowledge/${id}`);
    const second = await request('DELETE', `/api/admin/answer-studio/knowledge/${id}`);
    assert.equal(first.status, 200);
    assert.equal(first.data.data.active, false);
    assert.equal(second.status, 200);
    assert.equal(second.data.data.active, false);

    const stored = await AnswerStudioKnowledge.findById(id).lean();
    assert.ok(stored);
    assert.equal(stored.active, false);
    const linked = await AnswerStudioGeneration.findById(generation._id).lean();
    assert.equal(String(linked.knowledgeReferences[0]), id);
  });

  test('authorization and query safety', async () => {
    const paths = [
      ['GET', '/api/admin/answer-studio/knowledge'],
      ['POST', '/api/admin/answer-studio/knowledge'],
      ['GET', '/api/admin/answer-studio/knowledge/507f1f77bcf86cd799439011'],
      ['PATCH', '/api/admin/answer-studio/knowledge/507f1f77bcf86cd799439011'],
      ['DELETE', '/api/admin/answer-studio/knowledge/507f1f77bcf86cd799439011'],
    ];
    for (const [method, urlPath] of paths) {
      const anonymous = await request(method, urlPath, { token: null, body: method === 'GET' || method === 'DELETE' ? undefined : fact() });
      assert.equal(anonymous.status, 401, method);

      const regular = await request(method, urlPath, {
        token: otherToken,
        body: method === 'GET' || method === 'DELETE' ? undefined : fact(),
      });
      assert.equal(regular.status, 403, method);
      assert.equal(regular.data.code, 'section_forbidden');

      const section = await request(method, urlPath, {
        token: sectionToken,
        body: method === 'GET' || method === 'DELETE' ? undefined : fact(),
      });
      assert.equal(section.status, 403, method);
      assert.equal(section.data.message, 'Super admin access required');
    }

    const operatorBody = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: { title: { $gt: '' }, body: 'Fact' },
    });
    assert.equal(operatorBody.status, 400);

    const operatorKey = await request('POST', '/api/admin/answer-studio/knowledge', {
      body: { $where: '1', title: 'Title', body: 'Body' },
    });
    assert.equal(operatorKey.status, 400);

    const badSort = await request('GET', '/api/admin/answer-studio/knowledge?sort=email');
    assert.equal(badSort.status, 400);

    const operatorSort = await request('GET', '/api/admin/answer-studio/knowledge?sort[$gt]=1');
    assert.equal(operatorSort.status, 400);

    const hugeLimit = await request('GET', '/api/admin/answer-studio/knowledge?limit=101');
    assert.equal(hugeLimit.status, 400);

    const capped = await request('GET', '/api/admin/answer-studio/knowledge?limit=100&page=1');
    assert.equal(capped.status, 200);
    assert.equal(capped.data.pagination.limit, 100);

    const hostile = await request(
      'GET',
      `/api/admin/answer-studio/knowledge?search=${encodeURIComponent('([unclosed')}`
    );
    assert.equal(hostile.status, 200);
    assert.deepEqual(hostile.data.data, []);
  });
});
