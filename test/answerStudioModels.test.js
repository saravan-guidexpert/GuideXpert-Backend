'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { DEFAULT_DIMENSIONS } = require('../services/ai/embeddingService');
const {
  ANSWER_STUDIO_EMBEDDING_DIMENSIONS,
} = require('../services/answerStudio/constants');
const { activatePrompt } = require('../services/answerStudio/activatePrompt');
const AnswerStudioKnowledge = require('../models/AnswerStudioKnowledge');
const AnswerStudioExample = require('../models/AnswerStudioExample');
const AnswerStudioGeneration = require('../models/AnswerStudioGeneration');
const AnswerStudioPrompt = require('../models/AnswerStudioPrompt');
const Admin = require('../models/Admin');

function vector(length, value = 0.1) {
  return Array.from({ length }, () => value);
}

function indexFields(schema) {
  return schema.indexes();
}

function findIndex(schema, predicate) {
  return indexFields(schema).find(([fields, options]) => predicate(fields, options || {}));
}

describe('Answer Studio models', { timeout: 120000, concurrency: 1 }, () => {
  let mongo;

  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'answer_studio_models' });
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  test('embedding width matches the existing embedding provider', () => {
    assert.equal(ANSWER_STUDIO_EMBEDDING_DIMENSIONS, DEFAULT_DIMENSIONS);
    assert.equal(DEFAULT_DIMENSIONS, 1024);
  });

  test('creates a knowledge record with an empty embedding', async () => {
    const doc = await AnswerStudioKnowledge.create({
      title: '  Fee fact  ',
      body: '  Counselling fees are published on the site.  ',
      contentHash: 'hash-fee-1',
      tags: [' fees '],
    });
    assert.equal(doc.title, 'Fee fact');
    assert.equal(doc.body, 'Counselling fees are published on the site.');
    assert.deepEqual(doc.embedding, []);
    assert.equal(doc.embeddingDimensions, 1024);
    assert.equal(doc.active, true);
    assert.equal(doc.tags[0], 'fees');
  });

  test('rejects knowledge without required fields', async () => {
    const doc = new AnswerStudioKnowledge({ title: 'Only title' });
    await assert.rejects(() => doc.validate());
  });

  test('rejects an empty knowledge body', async () => {
    const doc = new AnswerStudioKnowledge({
      title: 'Title',
      body: '   ',
      contentHash: 'hash-empty-body',
    });
    await assert.rejects(() => doc.validate(), /body/);
  });

  test('rejects an embedding that is not 1024 finite numbers', async () => {
    const wrongLength = new AnswerStudioKnowledge({
      title: 'Title',
      body: 'Body',
      contentHash: 'hash-bad-length',
      embedding: vector(3),
    });
    await assert.rejects(() => wrongLength.validate(), /embedding/);

    const nonFinite = new AnswerStudioKnowledge({
      title: 'Title',
      body: 'Body',
      contentHash: 'hash-nan',
      embedding: vector(1024).map((value, index) => (index === 0 ? Number.NaN : value)),
    });
    await assert.rejects(() => nonFinite.validate(), /embedding/);

    const badWidth = new AnswerStudioKnowledge({
      title: 'Title',
      body: 'Body',
      contentHash: 'hash-width',
      embeddingDimensions: 512,
    });
    await assert.rejects(() => badWidth.validate(), /embeddingDimensions/);
  });

  test('accepts a 1024-dimensional embedding', async () => {
    const doc = await AnswerStudioKnowledge.create({
      title: 'Indexed fact',
      body: 'A complete vector is stored as supplied.',
      contentHash: 'hash-full-vector',
      embedding: vector(1024, 0.25),
      embeddingModel: 'nvidia/llama-nemotron-embed-1b-v2',
    });
    assert.equal(doc.embedding.length, 1024);
    assert.equal(doc.embedding[0], 0.25);
    assert.equal(doc.embeddingModel, 'nvidia/llama-nemotron-embed-1b-v2');
  });

  test('contentHash is indexed and is not globally unique', () => {
    const contentHashIndex = findIndex(
      AnswerStudioKnowledge.schema,
      (fields) => fields.contentHash === 1 && Object.keys(fields).length === 1
    );
    assert.ok(contentHashIndex);
    assert.notEqual(contentHashIndex[1].unique, true);

    const activeIndex = findIndex(
      AnswerStudioKnowledge.schema,
      (fields) => fields.active === 1 && fields.updatedAt === -1
    );
    assert.ok(activeIndex);
  });

  test('rejects an unknown example platform', async () => {
    const doc = new AnswerStudioExample({
      platform: 'twitter',
      question: 'Question',
      answer: 'Answer',
    });
    await assert.rejects(() => doc.validate(), /platform/);
  });

  test('draft and archived examples cannot stay active', async () => {
    const draft = new AnswerStudioExample({
      platform: 'quora',
      question: 'How do I choose a branch?',
      answer: 'Compare curriculum and placements.',
      status: 'draft',
      active: true,
    });
    await draft.validate();
    assert.equal(draft.active, false);

    const archived = await AnswerStudioExample.create({
      platform: 'reddit',
      question: 'Old thread',
      answer: 'Old answer',
      status: 'archived',
      active: true,
    });
    assert.equal(archived.active, false);
    assert.equal(archived.status, 'archived');
  });

  test('approved examples require approver metadata and can be active', async () => {
    const admin = await Admin.create({
      username: 'example-approver',
      password: 'secret12',
      name: 'Approver',
    });
    const missing = new AnswerStudioExample({
      platform: 'quora',
      question: 'Question',
      answer: 'Answer',
      status: 'approved',
      active: true,
    });
    await assert.rejects(() => missing.validate(), /approvedBy/);

    const approvedAt = new Date('2026-11-06T12:00:00.000Z');
    const approved = await AnswerStudioExample.create({
      platform: 'quora',
      question: 'What is a good answer?',
      answer: 'Lead with the fact, then the caveat.',
      status: 'approved',
      active: true,
      approvedBy: admin._id,
      approvedAt,
    });
    assert.equal(approved.active, true);
    assert.equal(String(approved.approvedBy), String(admin._id));
    assert.equal(approved.approvedAt.toISOString(), approvedAt.toISOString());

    approved.status = 'draft';
    await approved.save();
    assert.equal(approved.status, 'draft');
    assert.equal(approved.active, false);
    assert.equal(String(approved.approvedBy), String(admin._id));
  });

  test('editing a generation cannot replace rawAnswer', async () => {
    const created = await AnswerStudioGeneration.create({
      platform: 'reddit',
      question: 'Is this college worth it?',
      rawAnswer: 'Original model output.',
      knowledgeReferences: [new mongoose.Types.ObjectId()],
      exampleReferences: [new mongoose.Types.ObjectId()],
      generationVersion: 1,
    });
    created.editedAnswer = 'Admin edit.';
    created.status = 'edited';
    await created.save();

    const stored = await AnswerStudioGeneration.findById(created._id).lean();
    assert.equal(stored.rawAnswer, 'Original model output.');
    assert.equal(stored.editedAnswer, 'Admin edit.');
    assert.equal(stored.status, 'edited');
    assert.equal(stored.knowledgeReferences.length, 1);
    assert.equal(stored.exampleReferences.length, 1);

    created.rawAnswer = 'Replaced output.';
    await assert.rejects(() => created.save(), /rawAnswer cannot be modified/);
    await assert.rejects(
      () =>
        AnswerStudioGeneration.updateOne(
          { _id: created._id },
          { $set: { rawAnswer: 'Query update' } }
        ),
      /rawAnswer cannot be modified/
    );
  });

  test('rejects a non-integer prompt version and preserves every version', async () => {
    const fractional = new AnswerStudioPrompt({
      key: 'answerStudio.quora',
      platform: 'quora',
      body: 'Use only the supplied facts.',
      version: 1.5,
    });
    await assert.rejects(() => fractional.validate(), /version/);

    const first = await AnswerStudioPrompt.create({
      key: 'answerStudio.quora',
      platform: 'quora',
      body: 'Version one.',
      version: 1,
    });
    const second = await AnswerStudioPrompt.create({
      key: 'answerStudio.quora',
      platform: 'quora',
      body: 'Version two.',
      version: 2,
    });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(await AnswerStudioPrompt.countDocuments({ key: 'answerStudio.quora' }), 2);

    await assert.rejects(
      () =>
        AnswerStudioPrompt.create({
          key: 'answerStudio.quora',
          platform: 'quora',
          body: 'Duplicate version.',
          version: 1,
        }),
      (error) => error && error.code === 11000
    );
  });

  test('activating a prompt deactivates the previous active version for that platform', async () => {
    const admin = await Admin.create({
      username: 'prompt-admin',
      password: 'secret12',
      name: 'Prompt Admin',
      isSuperAdmin: true,
    });
    const current = await AnswerStudioPrompt.create({
      key: 'answerStudio.reddit',
      platform: 'reddit',
      body: 'Current instructions.',
      version: 1,
      active: true,
      createdBy: admin._id,
    });
    const next = await AnswerStudioPrompt.create({
      key: 'answerStudio.reddit',
      platform: 'reddit',
      body: 'Next instructions.',
      version: 2,
      active: false,
      createdBy: admin._id,
    });

    await activatePrompt(next._id, admin._id);

    const storedCurrent = await AnswerStudioPrompt.findById(current._id).lean();
    const storedNext = await AnswerStudioPrompt.findById(next._id).lean();
    assert.equal(storedCurrent.active, false);
    assert.equal(storedNext.active, true);
    assert.equal(storedCurrent.body, 'Current instructions.');
    assert.equal(String(storedNext.updatedBy), String(admin._id));

    await assert.rejects(
      () =>
        AnswerStudioPrompt.create({
          key: 'answerStudio.reddit.alt',
          platform: 'reddit',
          body: 'Second active prompt.',
          version: 1,
          active: true,
        }),
      (error) => error && error.code === 11000
    );
  });

  test('declares the prompt and generation indexes', () => {
    const uniquePrompt = findIndex(
      AnswerStudioPrompt.schema,
      (fields, options) =>
        fields.key === 1 && fields.version === 1 && options.unique === true
    );
    assert.ok(uniquePrompt);

    const platformActive = findIndex(
      AnswerStudioPrompt.schema,
      (fields) => fields.platform === 1 && fields.active === 1
    );
    assert.ok(platformActive);

    const oneActive = findIndex(
      AnswerStudioPrompt.schema,
      (fields, options) =>
        fields.platform === 1 &&
        options.unique === true &&
        options.partialFilterExpression?.active === true
    );
    assert.ok(oneActive);

    const byAuthor = findIndex(
      AnswerStudioGeneration.schema,
      (fields) => fields.createdBy === 1 && fields.createdAt === -1
    );
    assert.ok(byAuthor);

    const byPlatform = findIndex(
      AnswerStudioGeneration.schema,
      (fields) => fields.platform === 1 && fields.status === 1 && fields.createdAt === -1
    );
    assert.ok(byPlatform);

    const examplePlatform = findIndex(
      AnswerStudioExample.schema,
      (fields) => fields.platform === 1 && fields.status === 1
    );
    assert.ok(examplePlatform);

    const exampleActive = findIndex(
      AnswerStudioExample.schema,
      (fields) => fields.active === 1 && fields.platform === 1
    );
    assert.ok(exampleActive);
  });
});
