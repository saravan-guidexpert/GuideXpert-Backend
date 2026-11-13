'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'answer-studio-prompt-secret';

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const answerStudioRoutes = require('../routes/answerStudioRoutes');
const { ANSWER_STUDIO_SECTION_KEY } = require('../services/answerStudio/constants');
const { PROMPT_BODY_LIMIT } = require('../services/answerStudio/promptValidation');
const { resolveStudioPrompt } = require('../services/answerStudio/promptResolver');
const defaultPrompts = require('../services/answerStudio/defaultPrompts');
const llmClient = require('../services/ai/llmClient');
const Admin = require('../models/Admin');
const AnswerStudioPrompt = require('../models/AnswerStudioPrompt');
const AnswerStudioPromptState = require('../models/AnswerStudioPromptState');
const {
  classifyLegacyPrompt,
  migrateAnswerStudioPromptIndexes,
  MigrationStopped,
} = require('../scripts/migrateAnswerStudioPromptIndexes');

let mongo;
let server;
let baseUrl;
let superAdmin;
let superToken;
let sectionToken;
let otherToken;
let llmCalls;
const originalCompletion = llmClient.chatCompletion;

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

function promptBody(overrides = {}) {
  return {
    key: 'office.quora',
    platform: 'quora',
    body: 'Answer with the office Quora instructions.',
    ...overrides,
  };
}

describe('Answer Studio prompt management', { timeout: 120000, concurrency: 1 }, () => {
  before(async () => {
    process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'studio-test-key';
    process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://studio.invalid/v1';
    process.env.LLM_MODEL = process.env.LLM_MODEL || 'studio-test-model';
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'answer_studio_prompts' });
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(
      '/api/admin/answer-studio',
      requireAdmin,
      requireAdminSection(ANSWER_STUDIO_SECTION_KEY, 'Answer Studio access is required.'),
      answerStudioRoutes
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    superAdmin = await Admin.create({
      username: 'prompt-super',
      password: 'secret12',
      name: 'Prompt Super',
      isSuperAdmin: true,
      sectionAccess: [ANSWER_STUDIO_SECTION_KEY],
    });
    const sectionAdmin = await Admin.create({
      username: 'prompt-section',
      password: 'secret12',
      name: 'Prompt Section',
      isSuperAdmin: false,
      sectionAccess: [ANSWER_STUDIO_SECTION_KEY],
    });
    const otherAdmin = await Admin.create({
      username: 'prompt-other',
      password: 'secret12',
      name: 'Prompt Other',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    superToken = sign(superAdmin);
    sectionToken = sign(sectionAdmin);
    otherToken = sign(otherAdmin);
  });

  after(async () => {
    llmClient.chatCompletion = originalCompletion;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    llmCalls = [];
    llmClient.chatCompletion = originalCompletion;
    await AnswerStudioPrompt.deleteMany({});
    await AnswerStudioPromptState.deleteMany({});
  });

function pauseNextStateUpdate() {
  const original = AnswerStudioPromptState.findOneAndUpdate;
  let markArrived;
  const arrived = new Promise((resolve) => {
    markArrived = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  AnswerStudioPromptState.findOneAndUpdate = function pausedFindOneAndUpdate(...args) {
    markArrived();
    return {
      then(onFulfilled, onRejected) {
        return gate.then(() => original.apply(AnswerStudioPromptState, args)).then(onFulfilled, onRejected);
      },
    };
  };
  return {
    arrived,
    release,
    restore() {
      AnswerStudioPromptState.findOneAndUpdate = original;
    },
  };
}

function holdStateUpdates(count) {
  const original = AnswerStudioPromptState.findOneAndUpdate;
  let queued = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  AnswerStudioPromptState.findOneAndUpdate = function heldFindOneAndUpdate(...args) {
    queued += 1;
    if (queued >= count) release();
    return {
      then(onFulfilled, onRejected) {
        return gate.then(() => original.apply(AnswerStudioPromptState, args)).then(onFulfilled, onRejected);
      },
    };
  };
  return {
    restore() {
      AnswerStudioPromptState.findOneAndUpdate = original;
    },
  };
}

  afterEach(() => {
    llmClient.chatCompletion = originalCompletion;
  });

  test('rejects anonymous, invalid, section-less, and non-super admins', async () => {
    const anonymous = await request('POST', '/api/admin/answer-studio/prompts', {
      token: null,
      body: promptBody(),
    });
    assert.equal(anonymous.status, 401);

    const invalid = await request('GET', '/api/admin/answer-studio/prompts', { token: 'not-a-token' });
    assert.equal(invalid.status, 401);

    const other = await request('POST', '/api/admin/answer-studio/prompts', {
      token: otherToken,
      body: promptBody(),
    });
    assert.equal(other.status, 403);
    assert.equal(other.data.code, 'section_forbidden');

    const section = await request('POST', '/api/admin/answer-studio/prompts', {
      token: sectionToken,
      body: promptBody(),
    });
    assert.equal(section.status, 403);
    assert.equal(section.data.message, 'Super admin access required');
  });

  test('creates an inactive draft and ignores forged audit fields', async () => {
    const forged = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ active: true, createdBy: superAdmin._id.toString(), version: 9 }),
    });
    assert.equal(forged.status, 400);
    assert.match(forged.data.message, /cannot be set/);

    const created = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    assert.equal(created.status, 201);
    assert.equal(created.data.data.active, false);
    assert.equal(created.data.data.version, 1);
    assert.equal(created.data.data.platform, 'quora');
    assert.equal(created.data.data.body, 'Answer with the office Quora instructions.');
    assert.equal(created.data.data.activatedBy, null);
    assert.equal(created.data.data.activatedAt, null);
    assert.equal(created.data.data.createdBy, String(superAdmin._id));
    assert.equal(created.data.data.updatedBy, String(superAdmin._id));

    const duplicate = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'DUPLICATE_PROMPT_KEY');
  });

  test('rejects an invalid platform and an empty or oversized prompt', async () => {
    const platform = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ platform: 'twitter' }),
    });
    assert.equal(platform.status, 400);
    assert.equal(platform.data.code, 'INVALID_PLATFORM');

    const empty = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ body: '   \n' }),
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.code, 'PROMPT_BODY_REQUIRED');

    const oversized = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ body: 'q'.repeat(PROMPT_BODY_LIMIT + 1) }),
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.data.code, 'PROMPT_BODY_TOO_LONG');
  });

  test('lists metadata without prompt content and returns the full prompt by id', async () => {
    const created = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    const listed = await request('GET', '/api/admin/answer-studio/prompts?platform=quora');
    assert.equal(listed.status, 200);
    assert.equal(listed.data.data.length, 1);
    assert.equal(listed.data.data[0].body, undefined);
    assert.equal(listed.data.data[0].version, 1);
    assert.equal(listed.data.pagination.total, 1);

    const detail = await request('GET', `/api/admin/answer-studio/prompts/${created.data.data.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.body, 'Answer with the office Quora instructions.');
  });

  test('a new version increments, stays inactive, and leaves the previous body unchanged', async () => {
    const created = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/activate`);
    const next = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/versions`, {
      body: { body: 'Second office instructions.', active: true, activatedBy: 'forged' },
    });
    assert.equal(next.status, 400);

    const version = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/versions`, {
      body: { body: 'Second office instructions.' },
    });
    assert.equal(version.status, 201);
    assert.equal(version.data.data.version, 2);
    assert.equal(version.data.data.key, 'office.quora');
    assert.equal(version.data.data.active, false);
    assert.equal(version.data.data.activatedBy, null);
    assert.equal(version.data.data.activatedAt, null);
    assert.equal(version.data.data.body, 'Second office instructions.');

    const original = await AnswerStudioPrompt.findById(created.data.data.id).lean();
    assert.equal(original.body, 'Answer with the office Quora instructions.');
    assert.equal(original.version, 1);
    assert.equal(original.active, true);
  });

  test('concurrent version creation cannot store the same version twice', async () => {
    const created = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    const url = `/api/admin/answer-studio/prompts/${created.data.data.id}/versions`;
    const [first, second] = await Promise.all([
      request('POST', url, { body: { body: 'Concurrent A' } }),
      request('POST', url, { body: { body: 'Concurrent B' } }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 201]);
    const versions = [first.data.data.version, second.data.data.version].sort();
    assert.deepEqual(versions, [2, 3]);
    const stored = await AnswerStudioPrompt.find({ key: 'office.quora' }).select('version body').lean();
    assert.equal(stored.length, 3);
    assert.equal(new Set(stored.map((row) => row.version)).size, 3);
    assert.equal(stored.find((row) => row.version === 1).body, 'Answer with the office Quora instructions.');
  });

  test('activation switches the platform prompt and leaves the other platform active', async () => {
    const quora = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    const reddit = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ key: 'office.reddit', platform: 'reddit', body: 'Reddit office prompt.' }),
    });
    const quoraNext = await request('POST', `/api/admin/answer-studio/prompts/${quora.data.data.id}/versions`, {
      body: { body: 'Newer Quora prompt.' },
    });

    const firstActive = await request('POST', `/api/admin/answer-studio/prompts/${quora.data.data.id}/activate`);
    assert.equal(firstActive.status, 200);
    assert.equal(firstActive.data.data.active, true);
    assert.equal(firstActive.data.data.activatedBy, String(superAdmin._id));
    assert.ok(firstActive.data.data.activatedAt);

    const redditActive = await request('POST', `/api/admin/answer-studio/prompts/${reddit.data.data.id}/activate`);
    assert.equal(redditActive.status, 200);

    const secondActive = await request(
      'POST',
      `/api/admin/answer-studio/prompts/${quoraNext.data.data.id}/activate`
    );
    assert.equal(secondActive.status, 200);
    assert.equal(secondActive.data.data.active, true);

    const again = await request('POST', `/api/admin/answer-studio/prompts/${quoraNext.data.data.id}/activate`);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'PROMPT_ALREADY_ACTIVE');

    const rows = await AnswerStudioPrompt.find({}).select('platform version active').lean();
    const activeQuora = rows.filter((row) => row.platform === 'quora' && row.active);
    const activeReddit = rows.filter((row) => row.platform === 'reddit' && row.active);
    assert.equal(activeQuora.length, 1);
    assert.equal(activeQuora[0].version, 2);
    assert.equal(activeReddit.length, 1);
    assert.equal(activeReddit[0].version, 1);

    const inactive = await request('POST', `/api/admin/answer-studio/prompts/${quora.data.data.id}/deactivate`);
    assert.equal(inactive.status, 409);
    assert.equal(inactive.data.code, 'PROMPT_NOT_ACTIVE');
  });

  test('concurrent activation leaves one active prompt for the platform', async () => {
    const first = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    const second = await request('POST', `/api/admin/answer-studio/prompts/${first.data.data.id}/versions`, {
      body: { body: 'Other draft.' },
    });
    const hold = holdStateUpdates(2);
    let left;
    let right;
    try {
      [left, right] = await Promise.all([
        request('POST', `/api/admin/answer-studio/prompts/${first.data.data.id}/activate`),
        request('POST', `/api/admin/answer-studio/prompts/${second.data.data.id}/activate`),
      ]);
    } finally {
      hold.restore();
    }
    const results = [left, right];
    assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
    const winner = results.find((item) => item.status === 200);
    const loser = results.find((item) => item.status === 409);
    assert.equal(loser.data.code, 'ACTIVE_PROMPT_CONFLICT');
    const state = await AnswerStudioPromptState.find({ platform: 'quora' }).lean();
    assert.equal(state.length, 1);
    assert.equal(String(state[0].activePromptId), winner.data.data.id);
    assert.notEqual(winner.data.data.id, loser.data?.data?.id);
    const reddit = await AnswerStudioPromptState.find({ platform: 'reddit' }).lean();
    assert.equal(reddit.length, 0);
    const selected = await AnswerStudioPrompt.findById(winner.data.data.id).lean();
    assert.equal(selected.lifecycle, 'active');
    const otherId = winner.data.data.id === first.data.data.id ? second.data.data.id : first.data.data.id;
    const other = await AnswerStudioPrompt.findById(otherId).lean();
    assert.equal(other.lifecycle, 'draft');
  });

  test('a stale deactivation cannot clear a newer prompt', async () => {
    const first = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    const second = await request('POST', `/api/admin/answer-studio/prompts/${first.data.data.id}/versions`, {
      body: { body: 'Newer draft.' },
    });
    await request('POST', `/api/admin/answer-studio/prompts/${first.data.data.id}/activate`);
    const pause = pauseNextStateUpdate();
    let result;
    try {
      const pending = request('POST', `/api/admin/answer-studio/prompts/${first.data.data.id}/deactivate`);
      await pause.arrived;
      await AnswerStudioPromptState.updateOne(
        { platform: 'quora' },
        { $set: { activePromptId: second.data.data.id }, $inc: { revision: 1 } }
      );
      pause.release();
      result = await pending;
    } finally {
      pause.restore();
    }
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'ACTIVE_PROMPT_CONFLICT');
    const state = await AnswerStudioPromptState.findOne({ platform: 'quora' }).lean();
    assert.equal(String(state.activePromptId), second.data.data.id);
  });

  test('an inactive prompt cannot be activated again', async () => {
    const created = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    assert.equal(created.data.data.lifecycle, 'draft');
    await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/activate`);
    const deactivated = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/deactivate`);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.data.data.lifecycle, 'inactive');
    const again = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/deactivate`);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'PROMPT_NOT_ACTIVE');
    const reactivate = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/activate`);
    assert.equal(reactivate.status, 409);
    assert.equal(reactivate.data.code, 'PROMPT_NOT_DRAFT');
    const state = await AnswerStudioPromptState.findOne({ platform: 'quora' }).lean();
    assert.equal(state.activePromptId, null);
    const resolved = await resolveStudioPrompt('quora');
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.key, 'quora-default-v1');
  });

  test('a bad or cross-platform pointer fails closed', async () => {
    const reddit = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ key: 'office.reddit', platform: 'reddit', body: 'Reddit only.' }),
    });
    await AnswerStudioPromptState.create({
      platform: 'quora',
      activePromptId: reddit.data.data.id,
      revision: 1,
    });
    await assert.rejects(
      () => resolveStudioPrompt('quora'),
      (error) => error && error.code === 'PROMPT_STATE_INVALID'
    );
    await AnswerStudioPromptState.deleteMany({ platform: 'quora' });
    await AnswerStudioPromptState.create({ platform: 'quora', activePromptId: new mongoose.Types.ObjectId(), revision: 1 });
    await assert.rejects(
      () => resolveStudioPrompt('quora'),
      (error) => error && error.code === 'PROMPT_STATE_INVALID'
    );
  });

  test('version creation and activation refuse to proceed without their unique indexes', async () => {
    const created = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    await AnswerStudioPrompt.collection.dropIndex('key_1_version_1');
    try {
      const version = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/versions`, {
        body: { body: 'Should not be stored.' },
      });
      assert.equal(version.status, 503);
      assert.equal(version.data.code, 'PROMPT_INDEX_REQUIRED');
      assert.equal(await AnswerStudioPrompt.countDocuments({ key: 'office.quora' }), 1);
    } finally {
      await AnswerStudioPrompt.collection.createIndex({ key: 1, version: 1 }, { unique: true });
    }

    await AnswerStudioPromptState.collection.dropIndex('answerStudioPromptStates_platform');
    try {
      const activated = await request('POST', `/api/admin/answer-studio/prompts/${created.data.data.id}/activate`);
      assert.equal(activated.status, 503);
      assert.equal(activated.data.code, 'PROMPT_INDEX_REQUIRED');
      assert.equal(await AnswerStudioPromptState.countDocuments({ platform: 'quora' }), 0);
    } finally {
      await AnswerStudioPromptState.collection.createIndex(
        { platform: 1 },
        { unique: true, name: 'answerStudioPromptStates_platform' }
      );
    }
  });

  test('duplicate state rows are not treated as one active prompt', async () => {
    await AnswerStudioPromptState.create({ platform: 'quora', activePromptId: null, revision: 0 });
    await AnswerStudioPromptState.collection.dropIndex('answerStudioPromptStates_platform');
    try {
      await AnswerStudioPromptState.collection.insertOne({
        platform: 'quora',
        activePromptId: null,
        revision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await assert.rejects(
        () => resolveStudioPrompt('quora'),
        (error) => error && error.code === 'PROMPT_STATE_CONFLICT'
      );
    } finally {
      await AnswerStudioPromptState.deleteMany({});
      await AnswerStudioPromptState.collection.createIndex(
        { platform: 1 },
        { unique: true, name: 'answerStudioPromptStates_platform' }
      );
    }
  });

  test('the index migration can be applied twice and keeps one state per platform', async () => {
    const created = await AnswerStudioPrompt.create({
      key: 'legacy.reddit',
      platform: 'reddit',
      body: 'Already active.',
      version: 1,
      active: true,
    });
    await AnswerStudioPrompt.collection.updateOne(
      { _id: created._id },
      { $unset: { lifecycle: '' } }
    );
    const first = await migrateAnswerStudioPromptIndexes({ apply: true });
    const second = await migrateAnswerStudioPromptIndexes({ apply: true });
    assert.equal(first.apply, true);
    assert.equal(second.lifecycleUpdates, 0);
    const stored = await AnswerStudioPrompt.findById(created._id).lean();
    assert.equal(stored.lifecycle, 'active');
    assert.equal(stored.body, 'Already active.');
    const states = await AnswerStudioPromptState.find({}).sort({ platform: 1 }).lean();
    assert.deepEqual(states.map((row) => row.platform), ['quora', 'reddit']);
    assert.equal(String(states.find((row) => row.platform === 'reddit').activePromptId), String(created._id));
    assert.equal(states.find((row) => row.platform === 'quora').activePromptId, null);
    const promptIndexes = await AnswerStudioPrompt.collection.indexes();
    const stateIndexes = await AnswerStudioPromptState.collection.indexes();
    assert.equal(
      promptIndexes.some((index) => index.unique === true && index.key.key === 1 && index.key.version === 1),
      true
    );
    assert.equal(
      stateIndexes.some((index) => index.unique === true && index.key.platform === 1),
      true
    );
  });

  test('the index migration stops on duplicate platform state rows', async () => {
    await AnswerStudioPromptState.collection.dropIndex('answerStudioPromptStates_platform');
    const first = await AnswerStudioPromptState.create({ platform: 'quora', activePromptId: null, revision: 0 });
    await AnswerStudioPromptState.collection.insertOne({
      platform: 'quora',
      activePromptId: null,
      revision: 4,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      await assert.rejects(
        () => migrateAnswerStudioPromptIndexes({ apply: true }),
        (error) => error instanceof MigrationStopped && /Duplicate prompt state/.test(error.message)
      );
      assert.equal(await AnswerStudioPromptState.countDocuments({ platform: 'quora' }), 2);
      assert.equal((await AnswerStudioPromptState.findById(first._id).lean()).revision, 0);
    } finally {
      await AnswerStudioPromptState.deleteMany({});
      await AnswerStudioPromptState.collection.createIndex(
        { platform: 1 },
        { unique: true, name: 'answerStudioPromptStates_platform' }
      );
    }
  });

  test('the index migration stops on duplicate versions and does not delete them', async () => {
    assert.equal(classifyLegacyPrompt({ active: true }), 'active');
    assert.equal(classifyLegacyPrompt({ active: false, activatedAt: new Date() }), 'inactive');
    assert.equal(classifyLegacyPrompt({ active: false }), 'draft');
    await AnswerStudioPrompt.collection.dropIndex('key_1_version_1');
    const first = await AnswerStudioPrompt.create({
      key: 'legacy.quora',
      platform: 'quora',
      body: 'Legacy one.',
      version: 1,
      lifecycle: 'draft',
    });
    await AnswerStudioPrompt.collection.insertOne({
      key: 'legacy.quora',
      platform: 'quora',
      body: 'Legacy duplicate.',
      version: 1,
      lifecycle: 'draft',
      active: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      await assert.rejects(
        () => migrateAnswerStudioPromptIndexes({ apply: true }),
        (error) => error instanceof MigrationStopped && /Duplicate prompt key/.test(error.message)
      );
      assert.equal(await AnswerStudioPrompt.countDocuments({ key: 'legacy.quora', version: 1 }), 2);
      assert.equal((await AnswerStudioPrompt.findById(first._id).lean()).body, 'Legacy one.');
    } finally {
      await AnswerStudioPrompt.deleteMany({ key: 'legacy.quora' });
      await AnswerStudioPrompt.collection.createIndex({ key: 1, version: 1 }, { unique: true });
    }
  });

  test('deactivation keeps history and generation falls back to the platform default', async () => {
    const quora = await request('POST', '/api/admin/answer-studio/prompts', { body: promptBody() });
    const reddit = await request('POST', '/api/admin/answer-studio/prompts', {
      body: promptBody({ key: 'office.reddit', platform: 'reddit', body: 'Reddit office prompt.' }),
    });
    await request('POST', `/api/admin/answer-studio/prompts/${quora.data.data.id}/activate`);
    await request('POST', `/api/admin/answer-studio/prompts/${reddit.data.data.id}/activate`);

    llmClient.chatCompletion = async (payload) => {
      llmCalls.push(payload);
      return { content: 'Generated from the active prompt.', model: 'prompt-test-model' };
    };
    const databaseGeneration = await request('POST', '/api/admin/answer-studio/generate', {
      body: { platform: 'quora', question: 'How should a student compare two colleges?' },
    });
    assert.equal(databaseGeneration.status, 201);
    assert.equal(databaseGeneration.data.data.promptSource, 'database');
    assert.equal(databaseGeneration.data.data.promptKey, 'office.quora');
    assert.equal(llmCalls[0].systemPrompt, 'Answer with the office Quora instructions.');

    llmCalls.length = 0;
    const redditGeneration = await request('POST', '/api/admin/answer-studio/generate', {
      body: { platform: 'reddit', question: 'Is this college choice too narrow?' },
    });
    assert.equal(redditGeneration.data.data.promptSource, 'database');
    assert.equal(redditGeneration.data.data.promptKey, 'office.reddit');
    assert.equal(llmCalls[0].systemPrompt, 'Reddit office prompt.');

    const deactivated = await request('POST', `/api/admin/answer-studio/prompts/${quora.data.data.id}/deactivate`);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.data.data.active, false);
    assert.equal(deactivated.data.data.body, 'Answer with the office Quora instructions.');
    assert.equal(deactivated.data.data.activatedBy, String(superAdmin._id));
    assert.ok(deactivated.data.data.deactivatedAt);

    const activeQuora = await AnswerStudioPrompt.countDocuments({ platform: 'quora', active: true });
    assert.equal(activeQuora, 0);
    const redditStill = await AnswerStudioPrompt.findById(reddit.data.data.id).lean();
    assert.equal(redditStill.active, true);

    const resolved = await resolveStudioPrompt('quora');
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.key, defaultPrompts.byPlatform.quora.key);
    assert.equal(resolved.body, defaultPrompts.byPlatform.quora.body);
    const redditResolved = await resolveStudioPrompt('reddit');
    assert.equal(redditResolved.source, 'database');
    assert.equal(redditResolved.key, 'office.reddit');

    llmCalls.length = 0;
    const fallback = await request('POST', '/api/admin/answer-studio/generate', {
      body: { platform: 'quora', question: 'How should a student compare two colleges?' },
    });
    assert.equal(fallback.status, 201);
    assert.equal(fallback.data.data.promptSource, 'default');
    assert.equal(fallback.data.data.promptKey, 'quora-default-v1');
    assert.equal(llmCalls[0].systemPrompt, defaultPrompts.byPlatform.quora.body);

    const history = await request('GET', '/api/admin/answer-studio/prompts?key=office.quora');
    assert.equal(history.data.data.length, 1);
    assert.equal(history.data.data[0].active, false);
    assert.equal(history.data.data[0].body, undefined);
  });
});
