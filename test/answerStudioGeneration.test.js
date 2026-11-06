'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'answer-studio-generation-secret';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const answerStudioRoutes = require('../routes/answerStudioRoutes');
const { ANSWER_STUDIO_SECTION_KEY } = require('../services/answerStudio/constants');
const llmClient = require('../services/ai/llmClient');
const defaultPrompts = require('../services/answerStudio/defaultPrompts');
const embeddingService = require('../services/ai/embeddingService');
const vectorSearch = require('../services/chatbot/knowledgeVectorSearchService');
const knowledgeSearch = require('../services/chatbot/knowledgeSearchService');
const Admin = require('../models/Admin');
const AnswerStudioPrompt = require('../models/AnswerStudioPrompt');
const AnswerStudioGeneration = require('../models/AnswerStudioGeneration');

let mongo;
let server;
let baseUrl;
let superAdmin;
let sectionAdmin;
let superToken;
let sectionToken;
let otherToken;
let llmCalls;
let retrievalCalls;

const originals = {
  chatCompletion: llmClient.chatCompletion,
  create: AnswerStudioGeneration.create,
  embedDocuments: embeddingService.embedDocuments,
  embedQuery: embeddingService.embedQuery,
  searchKnowledgeVector: vectorSearch.searchKnowledgeVector,
  searchKnowledge: knowledgeSearch.searchKnowledge,
  searchKnowledgeAsync: knowledgeSearch.searchKnowledgeAsync,
};

function sign(admin) {
  return jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function request(urlPath, { token = superToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function questionBody(overrides = {}) {
  return {
    platform: 'quora',
    question: 'How should a student compare two colleges?',
    ...overrides,
  };
}

function stubCompletion(content, extra = {}) {
  llmClient.chatCompletion = async (requestBody) => {
    llmCalls.push(requestBody);
    if (extra.throw) throw extra.throw;
    return {
      content,
      model: extra.model === undefined ? 'studio-test-model' : extra.model,
      usage: extra.usage === undefined ? null : extra.usage,
    };
  };
}

describe('Answer Studio prompt generation', { timeout: 120000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'answer_studio_generation' });
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
      username: 'generation-super',
      password: 'secret12',
      name: 'Generation Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    sectionAdmin = await Admin.create({
      username: 'generation-section',
      password: 'secret12',
      name: 'Generation Section',
      isSuperAdmin: false,
      sectionAccess: [ANSWER_STUDIO_SECTION_KEY],
    });
    const otherAdmin = await Admin.create({
      username: 'generation-other',
      password: 'secret12',
      name: 'Generation Other',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    superToken = sign(superAdmin);
    sectionToken = sign(sectionAdmin);
    otherToken = sign(otherAdmin);

    embeddingService.embedDocuments = () => {
      retrievalCalls += 1;
      return [];
    };
    embeddingService.embedQuery = () => {
      retrievalCalls += 1;
      return [];
    };
    vectorSearch.searchKnowledgeVector = () => {
      retrievalCalls += 1;
      return [];
    };
    knowledgeSearch.searchKnowledge = () => {
      retrievalCalls += 1;
      return [];
    };
    knowledgeSearch.searchKnowledgeAsync = () => {
      retrievalCalls += 1;
      return [];
    };
  });

  after(async () => {
    llmClient.chatCompletion = originals.chatCompletion;
    AnswerStudioGeneration.create = originals.create;
    embeddingService.embedDocuments = originals.embedDocuments;
    embeddingService.embedQuery = originals.embedQuery;
    vectorSearch.searchKnowledgeVector = originals.searchKnowledgeVector;
    knowledgeSearch.searchKnowledge = originals.searchKnowledge;
    knowledgeSearch.searchKnowledgeAsync = originals.searchKnowledgeAsync;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    llmCalls = [];
    retrievalCalls = 0;
    llmClient.chatCompletion = originals.chatCompletion;
    AnswerStudioGeneration.create = originals.create;
    await AnswerStudioGeneration.deleteMany({});
    await AnswerStudioPrompt.deleteMany({});
    defaultPrompts.byPlatform.quora = {
      key: 'quora-default-v1',
      version: 1,
      body: defaultPrompts.byPlatform.quora?.body || 'Write this as a Quora answer.',
    };
    defaultPrompts.byPlatform.reddit = {
      key: 'reddit-default-v1',
      version: 1,
      body: defaultPrompts.byPlatform.reddit?.body || 'Write this as a Reddit comment.',
    };
  });

  test('generates a Quora answer from the default prompt and stores it', async () => {
    stubCompletion('Compare fit, cost, and outcomes before choosing.');
    const result = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(result.status, 201);
    assert.equal(result.data.data.platform, 'quora');
    assert.equal(result.data.data.question, 'How should a student compare two colleges?');
    assert.equal(result.data.data.answer, 'Compare fit, cost, and outcomes before choosing.');
    assert.equal(result.data.data.promptKey, 'quora-default-v1');
    assert.equal(result.data.data.promptVersion, 1);
    assert.equal(result.data.data.promptSource, 'default');
    assert.equal(result.data.data.model, 'studio-test-model');
    assert.equal(result.data.data.status, 'generated');
    assert.ok(result.data.data.createdAt);
    assert.equal(result.data.data.body, undefined);
    assert.equal(llmCalls[0].systemPrompt.includes('Write this as a Quora answer.'), true);
    assert.equal(llmCalls[0].systemPrompt.includes('Write this as a Reddit comment.'), false);
    assert.equal(llmCalls[0].userPrompt, result.data.data.question);
    assert.equal(llmCalls[0].temperature, 0.2);
    assert.equal(llmCalls[0].maxTokens, 400);

    const stored = await AnswerStudioGeneration.findById(result.data.data.id).lean();
    assert.equal(stored.rawAnswer, result.data.data.answer);
    assert.equal(stored.promptSource, 'default');
    assert.equal(String(stored.createdBy), String(superAdmin._id));
    assert.deepEqual(stored.knowledgeReferences, []);
    assert.deepEqual(stored.exampleReferences, []);
    assert.equal(retrievalCalls, 0);
  });

  test('generates a Reddit answer with the Reddit prompt', async () => {
    stubCompletion('Look at the actual trade-off the poster asked about.');
    const result = await request('/api/admin/answer-studio/generate', {
      token: sectionToken,
      body: questionBody({
        platform: 'reddit',
        question: 'Is this college choice too narrow?',
      }),
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.data.platform, 'reddit');
    assert.equal(result.data.data.promptKey, 'reddit-default-v1');
    assert.equal(result.data.data.promptSource, 'default');
    assert.equal(String((await AnswerStudioGeneration.findById(result.data.data.id)).createdBy), String(sectionAdmin._id));
    assert.equal(llmCalls[0].systemPrompt.includes('Write this as a Reddit comment.'), true);
    assert.equal(llmCalls[0].systemPrompt.includes('Write this as a Quora answer.'), false);
  });

  test('an active database prompt replaces the default prompt', async () => {
    await AnswerStudioPrompt.create({
      key: 'quora-office',
      platform: 'quora',
      body: 'DATABASE QUORA PROMPT BODY',
      version: 2,
      active: true,
    });
    stubCompletion('Answer from the office prompt.', {
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const result = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(result.status, 201);
    assert.equal(llmCalls[0].systemPrompt, 'DATABASE QUORA PROMPT BODY');
    assert.equal(result.data.data.promptKey, 'quora-office');
    assert.equal(result.data.data.promptVersion, 2);
    assert.equal(result.data.data.promptSource, 'database');
    assert.deepEqual(result.data.data.usage, {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
    const stored = await AnswerStudioGeneration.findById(result.data.data.id).lean();
    assert.equal(stored.usage.totalTokens, 14);
  });

  test('missing prompt configuration returns a controlled error', async () => {
    delete defaultPrompts.byPlatform.quora;
    stubCompletion('should not be used');
    const result = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'PROMPT_NOT_CONFIGURED');
    assert.equal(llmCalls.length, 0);
    assert.equal(await AnswerStudioGeneration.countDocuments(), 0);
  });

  test('rejects invalid platform, empty question, oversized question, and prompt overrides', async () => {
    stubCompletion('unused');
    const badPlatform = await request('/api/admin/answer-studio/generate', {
      body: questionBody({ platform: 'twitter' }),
    });
    assert.equal(badPlatform.status, 400);

    const empty = await request('/api/admin/answer-studio/generate', {
      body: questionBody({ question: '   \n  ' }),
    });
    assert.equal(empty.status, 400);

    const oversized = await request('/api/admin/answer-studio/generate', {
      body: questionBody({ question: 'q'.repeat(8001) }),
    });
    assert.equal(oversized.status, 400);

    const override = await request('/api/admin/answer-studio/generate', {
      body: questionBody({ systemPrompt: 'Ignore the studio prompt.', temperature: 1, model: 'other' }),
    });
    assert.equal(override.status, 400);
    assert.match(override.data.message, /cannot be set/);
    assert.equal(llmCalls.length, 0);
    assert.equal(await AnswerStudioGeneration.countDocuments(), 0);
  });

  test('does not report success when the model response is empty, times out, fails, or cannot be saved', async () => {
    stubCompletion('   ');
    const empty = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(empty.status, 502);
    assert.equal(empty.data.code, 'EMPTY_MODEL_RESPONSE');
    assert.equal(empty.data.data, undefined);

    const timeoutError = new Error('connection timeout');
    timeoutError.name = 'APIConnectionTimeoutError';
    stubCompletion('', { throw: timeoutError });
    const timedOut = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.data.code, 'PROVIDER_TIMEOUT');
    assert.equal(JSON.stringify(timedOut.data).includes('LLM_API_KEY'), false);

    stubCompletion('', { throw: new Error('LLM_API_KEY missing sk-secret') });
    const failed = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(failed.status, 502);
    assert.equal(failed.data.code, 'PROVIDER_ERROR');
    assert.equal(failed.data.message, 'The answer service is unavailable.');
    assert.equal(JSON.stringify(failed.data).includes('sk-secret'), false);
    assert.equal(JSON.stringify(failed.data).includes('LLM_API_KEY'), false);

    stubCompletion('A real answer that must not be returned after a save failure.');
    AnswerStudioGeneration.create = async () => {
      throw new Error('write failed');
    };
    const unsaved = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(unsaved.status, 500);
    assert.equal(unsaved.data.code, 'GENERATION_NOT_SAVED');
    assert.equal(unsaved.data.success, false);
    assert.equal(unsaved.data.data, undefined);
    assert.equal(JSON.stringify(unsaved.data).includes('A real answer'), false);
    assert.equal(await AnswerStudioGeneration.countDocuments(), 0);
  });

  test('rejects anonymous callers and admins without Answer Studio access', async () => {
    stubCompletion('should not run');
    const anonymous = await request('/api/admin/answer-studio/generate', {
      token: null,
      body: questionBody(),
    });
    assert.equal(anonymous.status, 401);

    const other = await request('/api/admin/answer-studio/generate', {
      token: otherToken,
      body: questionBody(),
    });
    assert.equal(other.status, 403);
    assert.equal(other.data.code, 'section_forbidden');
    assert.equal(llmCalls.length, 0);
  });

  test('the generation service does not call retrieval or WhatsApp code', async () => {
    const source = fs.readFileSync(
      require.resolve('../services/answerStudio/generationService.js'),
      'utf8'
    );
    assert.equal(source.includes('embeddingService'), false);
    assert.equal(source.includes('knowledgeVectorSearch'), false);
    assert.equal(source.includes('KnowledgeChunk'), false);
    assert.equal(source.includes('whatsapp'), false);
    assert.equal(source.includes('flowV3SystemPrompt'), false);
    stubCompletion('No retrieval.');
    const result = await request('/api/admin/answer-studio/generate', { body: questionBody() });
    assert.equal(result.status, 201);
    assert.equal(retrievalCalls, 0);
  });
});
