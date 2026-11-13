'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'answer-studio-example-secret';

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
const AnswerStudioExample = require('../models/AnswerStudioExample');

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

const RealDate = Date;

function freezeAt(ms) {
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [ms]));
    }

    static now() {
      return ms;
    }
  }
  global.Date = FrozenDate;
  return () => {
    global.Date = RealDate;
  };
}

// Starts both conditional writes only after both have been requested, so they share one __v.
function competeOnSameVersion() {
  const original = AnswerStudioExample.findOneAndUpdate;
  let queued = 0;
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  AnswerStudioExample.findOneAndUpdate = function findOneAndUpdateForRace(...args) {
    queued += 1;
    if (queued === 2) openGate();
    return {
      then(onFulfilled, onRejected) {
        return gate.then(() => original.apply(AnswerStudioExample, args)).then(onFulfilled, onRejected);
      },
    };
  };
  return () => {
    AnswerStudioExample.findOneAndUpdate = original;
  };
}

function draftBody(overrides = {}) {
  return {
    platform: 'quora',
    question: 'How should a student choose a college?',
    answer: 'Start with fit, cost, and outcomes. Then compare two colleges directly.',
    topic: 'College choice',
    styleTags: ['direct', 'practical'],
    isTestData: false,
    ...overrides,
  };
}

async function createDraft(overrides) {
  const created = await request('POST', '/api/admin/answer-studio/examples', {
    body: draftBody(overrides),
  });
  assert.equal(created.status, 201);
  return created.data.data;
}

describe('Answer Studio example lifecycle', { timeout: 120000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'answer_studio_examples' });
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
      username: 'example-super',
      password: 'secret12',
      name: 'Example Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    editorAdmin = await Admin.create({
      username: 'example-editor',
      password: 'secret12',
      name: 'Example Editor',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const sectionAdmin = await Admin.create({
      username: 'example-section',
      password: 'secret12',
      name: 'Example Section',
      isSuperAdmin: false,
      sectionAccess: [ANSWER_STUDIO_SECTION_KEY],
    });
    const otherAdmin = await Admin.create({
      username: 'example-other',
      password: 'secret12',
      name: 'Example Other',
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
    await AnswerStudioExample.deleteMany({});
  });

  test('creates platform drafts and lists an empty collection', async () => {
    const empty = await request('GET', '/api/admin/answer-studio/examples');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.data, []);
    assert.deepEqual(empty.data.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });

    const quora = await createDraft();
    assert.equal(quora.platform, 'quora');
    assert.equal(quora.status, 'draft');
    assert.equal(quora.active, false);
    assert.equal(quora.isTestData, false);
    assert.equal(quora.approvedBy, null);
    assert.equal(quora.embedding, undefined);
    assert.equal(quora.createdBy, String(superAdmin._id));

    const reddit = await createDraft({
      platform: 'reddit',
      question: 'Is this reply too stiff?',
      answer: 'Write like a person who has checked the facts.',
      isTestData: true,
    });
    assert.equal(reddit.platform, 'reddit');
    assert.equal(reddit.status, 'draft');
    assert.equal(reddit.isTestData, true);

    const forced = await request('POST', '/api/admin/answer-studio/examples', {
      body: draftBody({ status: 'approved', active: true, approvedBy: String(editorAdmin._id) }),
    });
    assert.equal(forced.status, 400);
  });

  test('rejects invalid create input and protected fields', async () => {
    const missing = await request('POST', '/api/admin/answer-studio/examples', {
      body: { platform: 'quora', question: 'Only a question' },
    });
    assert.equal(missing.status, 400);

    const emptyAnswer = await request('POST', '/api/admin/answer-studio/examples', {
      body: draftBody({ answer: '   ' }),
    });
    assert.equal(emptyAnswer.status, 400);

    const badPlatform = await request('POST', '/api/admin/answer-studio/examples', {
      body: draftBody({ platform: 'twitter' }),
    });
    assert.equal(badPlatform.status, 400);

    const badTags = await request('POST', '/api/admin/answer-studio/examples', {
      body: draftBody({ styleTags: ['direct', 1] }),
    });
    assert.equal(badTags.status, 400);

    const operator = await request('POST', '/api/admin/answer-studio/examples', {
      body: { $where: '1', platform: 'quora', question: 'Q', answer: 'A' },
    });
    assert.equal(operator.status, 400);

    const vector = await request('POST', '/api/admin/answer-studio/examples', {
      body: draftBody({ embedding: [0.2] }),
    });
    assert.equal(vector.status, 400);
    assert.equal(await AnswerStudioExample.countDocuments(), 0);
  });

  test('searches and filters examples without returning embeddings', async () => {
    const quora = await createDraft();
    const reddit = await createDraft({
      platform: 'reddit',
      question: 'How do I sound less like a brochure?',
      answer: 'Use one concrete detail and stop.',
      topic: 'Tone',
      styleTags: ['casual'],
      isTestData: true,
    });
    await AnswerStudioExample.updateOne(
      { _id: quora.id },
      { $set: { embedding: Array.from({ length: 1024 }, () => 0.1), embeddingModel: 'stored' } }
    );

    const searchQuestion = await request(
      'GET',
      `/api/admin/answer-studio/examples?search=${encodeURIComponent('brochure')}`
    );
    assert.equal(searchQuestion.data.data.length, 1);
    assert.equal(searchQuestion.data.data[0].id, reddit.id);
    assert.equal(searchQuestion.data.data[0].embedding, undefined);

    const searchAnswer = await request(
      'GET',
      `/api/admin/answer-studio/examples?search=${encodeURIComponent('concrete detail')}`
    );
    assert.equal(searchAnswer.data.data[0].id, reddit.id);

    const platform = await request('GET', '/api/admin/answer-studio/examples?platform=quora&status=draft');
    assert.equal(platform.data.data.length, 1);
    assert.equal(platform.data.data[0].id, quora.id);
    assert.equal(platform.data.data[0].hasEmbedding, true);
    assert.equal(platform.data.data[0].embedding, undefined);

    const topic = await request(
      'GET',
      `/api/admin/answer-studio/examples?topic=${encodeURIComponent('Tone')}&styleTag=casual`
    );
    assert.equal(topic.data.data.length, 1);
    assert.equal(topic.data.data[0].id, reddit.id);

    const tests = await request('GET', '/api/admin/answer-studio/examples?isTestData=true');
    assert.equal(tests.data.data.length, 1);
    assert.equal(tests.data.data[0].isTestData, true);

    const hostile = await request(
      'GET',
      `/api/admin/answer-studio/examples?search=${encodeURIComponent('.*')}`
    );
    assert.equal(hostile.status, 200);
    assert.deepEqual(hostile.data.data, []);

    const badSort = await request('GET', '/api/admin/answer-studio/examples?sort=email');
    assert.equal(badSort.status, 400);
    const huge = await request('GET', '/api/admin/answer-studio/examples?limit=101');
    assert.equal(huge.status, 400);

    const missing = await request('GET', '/api/admin/answer-studio/examples/507f1f77bcf86cd799439011');
    assert.equal(missing.status, 404);
    const badId = await request('GET', '/api/admin/answer-studio/examples/not-an-id');
    assert.equal(badId.status, 400);

    const detail = await request('GET', `/api/admin/answer-studio/examples/${quora.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.embedding, undefined);
    assert.equal(detail.data.data.hasEmbedding, true);
  });

  test('approval, revoke, archive, and reactivate follow the state machine', async () => {
    const draft = await createDraft();
    const approved = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/approve`, {
      token: editorToken,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.data.status, 'approved');
    assert.equal(approved.data.data.active, true);
    assert.equal(approved.data.data.approvedBy, String(editorAdmin._id));
    assert.ok(approved.data.data.approvedAt);

    const again = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/approve`);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'INVALID_EXAMPLE_TRANSITION');
    assert.equal(again.data.currentStatus, 'approved');

    const revoked = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/revoke-approval`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.data.status, 'draft');
    assert.equal(revoked.data.data.active, false);
    assert.equal(revoked.data.data.approvedBy, null);
    assert.equal(revoked.data.data.approvedAt, null);

    const revokeDraft = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/revoke-approval`);
    assert.equal(revokeDraft.status, 409);

    const archivedDraft = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/archive`);
    assert.equal(archivedDraft.data.data.status, 'archived');
    assert.equal(archivedDraft.data.data.active, false);

    const approveArchived = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/approve`);
    assert.equal(approveArchived.status, 409);
    assert.equal(approveArchived.data.currentStatus, 'archived');

    const reactivated = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/reactivate`);
    assert.equal(reactivated.data.data.status, 'draft');
    assert.equal(reactivated.data.data.active, false);
    assert.equal(reactivated.data.data.approvedBy, null);
    const stillNeedsApproval = await request(
      'POST',
      `/api/admin/answer-studio/examples/${draft.id}/revoke-approval`
    );
    assert.equal(stillNeedsApproval.status, 409);

    const fresh = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/approve`);
    assert.equal(fresh.data.data.status, 'approved');
    const archivedApproved = await request('POST', `/api/admin/answer-studio/examples/${draft.id}/archive`);
    assert.equal(archivedApproved.data.data.status, 'archived');
    assert.equal(archivedApproved.data.data.active, false);
    assert.equal(archivedApproved.data.data.approvedBy, String(superAdmin._id));
    const stored = await AnswerStudioExample.findById(draft.id).lean();
    assert.equal(stored.status, 'archived');
    assert.equal(stored.active, false);
    assert.ok(stored.approvedAt);

    const reactivateDraft = await createDraft({
      question: 'Second example question',
      answer: 'Second example answer.',
    });
    const notArchived = await request(
      'POST',
      `/api/admin/answer-studio/examples/${reactivateDraft.id}/reactivate`
    );
    assert.equal(notArchived.status, 409);
  });

  test('edits invalidate approval, keep archived records archived, and clear stale embeddings', async () => {
    const created = await createDraft();
    await request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`);
    await AnswerStudioExample.updateOne(
      { _id: created.id },
      { $set: { embedding: Array.from({ length: 1024 }, () => 0.4), embeddingModel: 'old-model' } }
    );

    const edited = await request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
      token: editorToken,
      body: { answer: 'Lead with the fact, then one caveat.' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.data.status, 'draft');
    assert.equal(edited.data.data.active, false);
    assert.equal(edited.data.data.approvedBy, null);
    assert.equal(edited.data.data.question, created.question);
    assert.equal(edited.data.data.updatedBy, String(editorAdmin._id));
    assert.equal(edited.data.data.hasEmbedding, false);
    const cleared = await AnswerStudioExample.findById(created.id).lean();
    assert.deepEqual(cleared.embedding, []);
    assert.equal(cleared.embeddingModel, '');
    assert.equal(cleared.embeddingDimensions, 1024);

    const protectedPatch = await request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
      body: { status: 'approved', isTestData: true, active: true },
    });
    assert.equal(protectedPatch.status, 400);
    const unchanged = await AnswerStudioExample.findById(created.id).lean();
    assert.equal(unchanged.status, 'draft');
    assert.equal(unchanged.isTestData, false);

    await request('POST', `/api/admin/answer-studio/examples/${created.id}/archive`);
    await AnswerStudioExample.updateOne(
      { _id: created.id },
      { $set: { embedding: Array.from({ length: 1024 }, () => 0.2), embeddingModel: 'archived-model' } }
    );
    const archivedEdit = await request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
      body: { topic: 'Still archived' },
    });
    assert.equal(archivedEdit.status, 200);
    assert.equal(archivedEdit.data.data.status, 'archived');
    assert.equal(archivedEdit.data.data.active, false);
    const archivedStored = await AnswerStudioExample.findById(created.id).lean();
    assert.equal(archivedStored.status, 'archived');
    assert.equal(archivedStored.embeddingModel, 'archived-model');

    const contentEdit = await request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
      body: { question: 'A rewritten archived question' },
    });
    assert.equal(contentEdit.data.data.status, 'archived');
    const contentStored = await AnswerStudioExample.findById(created.id).lean();
    assert.deepEqual(contentStored.embedding, []);
    assert.equal(contentStored.status, 'archived');
  });

  test('concurrent edits on one version conflict when the clock is frozen', async () => {
    const created = await createDraft({ topic: 'Original topic' });
    const initial = await AnswerStudioExample.findById(created.id).lean();
    const unfreeze = freezeAt(initial.updatedAt.getTime());
    const release = competeOnSameVersion();
    try {
      const [alpha, beta] = await Promise.all([
        request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, { body: { topic: 'Alpha' } }),
        request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, { body: { topic: 'Beta' } }),
      ]);
      const statuses = [alpha.status, beta.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const winner = alpha.status === 200 ? alpha : beta;
      const loser = alpha.status === 409 ? alpha : beta;
      assert.equal(loser.data.code, 'INVALID_EXAMPLE_TRANSITION');
      const stored = await AnswerStudioExample.findById(created.id).lean();
      assert.equal(stored.topic, winner.data.data.topic);
      assert.ok(stored.topic === 'Alpha' || stored.topic === 'Beta');
      assert.equal(stored.__v, initial.__v + 1);
      assert.equal(stored.status, 'draft');
      assert.equal(stored.active, false);
    } finally {
      release();
      unfreeze();
    }
  });

  test('a case-only style tag change invalidates approval and an unchanged tag list does not', async () => {
    const created = await createDraft({ styleTags: ['Direct'] });
    const approved = await request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`);
    assert.equal(approved.data.data.status, 'approved');

    const changed = await request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
      body: { styleTags: ['direct'] },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.data.status, 'draft');
    assert.equal(changed.data.data.active, false);
    assert.equal(changed.data.data.approvedBy, null);
    assert.equal(changed.data.data.approvedAt, null);
    assert.deepEqual(changed.data.data.styleTags, ['direct']);

    await request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`);
    const same = await request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
      body: { styleTags: [' direct ', 'DIRECT'] },
    });
    assert.equal(same.status, 200);
    assert.equal(same.data.data.status, 'approved');
    assert.equal(same.data.data.active, true);
    assert.ok(same.data.data.approvedBy);
    assert.deepEqual(same.data.data.styleTags, ['direct']);
  });

  test('an edit and an approval competing on one version leave one valid row', async () => {
    const created = await createDraft();
    const initial = await AnswerStudioExample.findById(created.id).lean();
    const release = competeOnSameVersion();
    try {
      const [edited, approved] = await Promise.all([
        request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, {
          body: { answer: 'The edit that raced with approval.' },
        }),
        request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`),
      ]);
      const statuses = [edited.status, approved.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const stored = await AnswerStudioExample.findById(created.id).lean();
      assert.equal(stored.__v, initial.__v + 1);
      if (approved.status === 200) {
        assert.equal(stored.status, 'approved');
        assert.equal(stored.active, true);
        assert.equal(stored.answer, created.answer);
        assert.ok(stored.approvedBy);
        assert.equal(stored.embedding.length, 0);
      } else {
        assert.equal(edited.status, 200);
        assert.equal(stored.status, 'draft');
        assert.equal(stored.active, false);
        assert.equal(stored.answer, 'The edit that raced with approval.');
        assert.equal(stored.approvedBy, null);
        assert.deepEqual(stored.embedding, []);
      }
    } finally {
      release();
    }
  });

  test('an edit and an archive competing on one version cannot both commit', async () => {
    const created = await createDraft({ topic: 'Before archive' });
    await request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`);
    const initial = await AnswerStudioExample.findById(created.id).lean();
    const release = competeOnSameVersion();
    try {
      const [edited, archived] = await Promise.all([
        request('PATCH', `/api/admin/answer-studio/examples/${created.id}`, { body: { topic: 'Edited topic' } }),
        request('POST', `/api/admin/answer-studio/examples/${created.id}/archive`),
      ]);
      const statuses = [edited.status, archived.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const stored = await AnswerStudioExample.findById(created.id).lean();
      assert.equal(stored.__v, initial.__v + 1);
      assert.equal(stored.active, false);
      if (archived.status === 200) {
        assert.equal(stored.status, 'archived');
        assert.equal(stored.topic, 'Before archive');
        assert.ok(stored.approvedBy);
      } else {
        assert.equal(stored.status, 'draft');
        assert.equal(stored.topic, 'Edited topic');
        assert.equal(stored.approvedBy, null);
        assert.equal(stored.approvedAt, null);
      }
    } finally {
      release();
    }
  });

  test('preserves answer paragraphs, matches style tags ignoring case, and caps the page', async () => {
    const created = await createDraft({
      answer: '  First paragraph.  \n\n\n  Second paragraph.  ',
      styleTags: ['Direct'],
    });
    assert.equal(created.answer, 'First paragraph.\n\nSecond paragraph.');
    const stored = await AnswerStudioExample.findById(created.id).lean();
    assert.equal(stored.answer, 'First paragraph.\n\nSecond paragraph.');

    const listed = await request('GET', '/api/admin/answer-studio/examples?styleTag=direct');
    assert.equal(listed.status, 200);
    assert.equal(listed.data.data.length, 1);
    assert.equal(listed.data.data[0].id, created.id);

    const hugePage = await request('GET', '/api/admin/answer-studio/examples?page=1001');
    assert.equal(hugePage.status, 400);
  });

  test('concurrent approvals leave a single valid approved example', async () => {
    const created = await createDraft({
      question: 'Race question',
      answer: 'Race answer that should be approved once.',
    });
    const [first, second] = await Promise.all([
      request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`),
      request('POST', `/api/admin/answer-studio/examples/${created.id}/approve`),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const stored = await AnswerStudioExample.findById(created.id).lean();
    assert.equal(stored.status, 'approved');
    assert.equal(stored.active, true);
    assert.ok(stored.approvedBy);
    assert.ok(stored.approvedAt);
    assert.equal(await AnswerStudioExample.countDocuments({ status: 'approved', active: true }), 1);
  });

  test('rejects unauthenticated, section, and non-super-admin callers', async () => {
    const paths = [
      ['GET', '/api/admin/answer-studio/examples'],
      ['POST', '/api/admin/answer-studio/examples'],
      ['POST', '/api/admin/answer-studio/examples/507f1f77bcf86cd799439011/approve'],
    ];
    for (const [method, urlPath] of paths) {
      const anonymous = await request(method, urlPath, {
        token: null,
        body: method === 'GET' ? undefined : draftBody(),
      });
      assert.equal(anonymous.status, 401, method);

      const regular = await request(method, urlPath, {
        token: otherToken,
        body: method === 'GET' ? undefined : draftBody(),
      });
      assert.equal(regular.status, 403, method);
      assert.equal(regular.data.code, 'section_forbidden');

      const section = await request(method, urlPath, {
        token: sectionToken,
        body: method === 'GET' ? undefined : draftBody(),
      });
      assert.equal(section.status, 403, method);
      assert.equal(section.data.message, 'Super admin access required');
    }
  });
});
