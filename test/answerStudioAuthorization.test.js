'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'answer-studio-auth-secret';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const answerStudioRoutes = require('../routes/answerStudioRoutes');
const { ADMIN_SECTION_KEYS } = require('../constants/adminSectionKeys');
const { ANSWER_STUDIO_SECTION_KEY } = require('../services/answerStudio/constants');
const Admin = require('../models/Admin');

let mongo;
let server;
let baseUrl;
let superToken;
let sectionToken;
let otherToken;

function sign(admin) {
  return jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function request(method, urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, { method, headers });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

describe('Answer Studio authorization', { timeout: 120000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'answer_studio_auth' });

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

    const superAdmin = await Admin.create({
      username: 'studio-super',
      password: 'secret12',
      name: 'Studio Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const sectionAdmin = await Admin.create({
      username: 'studio-section',
      password: 'secret12',
      name: 'Studio Section',
      isSuperAdmin: false,
      sectionAccess: [ANSWER_STUDIO_SECTION_KEY],
    });
    const otherAdmin = await Admin.create({
      username: 'studio-other',
      password: 'secret12',
      name: 'Studio Other',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    superToken = sign(superAdmin);
    sectionToken = sign(sectionAdmin);
    otherToken = sign(otherAdmin);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  test('registers the answer-studio section and mounts it before generic admin routes', () => {
    assert.ok(ADMIN_SECTION_KEYS.includes(ANSWER_STUDIO_SECTION_KEY));
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const mountAt = source.indexOf("'/api/admin/answer-studio'");
    const genericAt = source.indexOf("app.use('/api/admin', adminRoutes)");
    assert.ok(mountAt > -1);
    assert.ok(genericAt > mountAt);
    assert.match(source, /requireAdminSection\(ANSWER_STUDIO_SECTION_KEY/);
  });

  test('unauthenticated requests receive 401', async () => {
    const status = await request('GET', '/api/admin/answer-studio/status');
    assert.equal(status.status, 401);
    assert.equal(status.data.success, false);

    const knowledge = await request('POST', '/api/admin/answer-studio/knowledge');
    assert.equal(knowledge.status, 401);
  });

  test('super admin and section admin can read module status', async () => {
    const superStatus = await request('GET', '/api/admin/answer-studio/status', superToken);
    assert.equal(superStatus.status, 200);
    assert.equal(superStatus.data.module, 'answer-studio');
    assert.equal(superStatus.data.permissions.knowledge, true);
    assert.equal(superStatus.data.permissions.examples, true);
    assert.equal(superStatus.data.permissions.exampleApproval, true);
    assert.equal(superStatus.data.permissions.prompts, true);
    assert.equal(superStatus.data.permissions.generations, true);

    const sectionStatus = await request('GET', '/api/admin/answer-studio/status', sectionToken);
    assert.equal(sectionStatus.status, 200);
    assert.equal(sectionStatus.data.permissions.module, true);
    assert.equal(sectionStatus.data.permissions.knowledge, false);
    assert.equal(sectionStatus.data.permissions.examples, false);
    assert.equal(sectionStatus.data.permissions.prompts, false);
    assert.equal(sectionStatus.data.permissions.generations, true);
  });

  test('an admin without the section receives 403', async () => {
    const result = await request('GET', '/api/admin/answer-studio/status', otherToken);
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'section_forbidden');
  });

  test('section admins cannot manage knowledge, examples, approvals, or prompts', async () => {
    const paths = [
      ['POST', '/api/admin/answer-studio/knowledge'],
      ['PATCH', '/api/admin/answer-studio/knowledge/507f1f77bcf86cd799439011'],
      ['POST', '/api/admin/answer-studio/examples'],
      ['POST', '/api/admin/answer-studio/examples/507f1f77bcf86cd799439011/approve'],
      ['PUT', '/api/admin/answer-studio/prompts'],
      ['PUT', '/api/admin/answer-studio/prompts/quora'],
    ];
    for (const [method, urlPath] of paths) {
      const result = await request(method, urlPath, sectionToken);
      assert.equal(result.status, 403, `${method} ${urlPath}`);
      assert.equal(result.data.message, 'Super admin access required');
    }
  });

  test('super admin passes the prompt gate and receives no stored data', async () => {
    const paths = [
      ['PUT', '/api/admin/answer-studio/prompts', 'prompts'],
      ['GET', '/api/admin/answer-studio/prompts/quora', 'prompts'],
    ];
    for (const [method, urlPath, scope] of paths) {
      const result = await request(method, urlPath, superToken);
      assert.equal(result.status, 501, `${method} ${urlPath}`);
      assert.equal(result.data.success, false);
      assert.equal(result.data.implemented, false);
      assert.equal(result.data.scope, scope);
      assert.equal(result.data.knowledge, undefined);
      assert.equal(result.data.examples, undefined);
      assert.equal(result.data.prompts, undefined);
    }
  });
});
