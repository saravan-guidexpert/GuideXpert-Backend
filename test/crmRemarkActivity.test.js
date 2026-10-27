'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-remark-activity-test-secret';
process.env.CRM_BCRYPT_ROUNDS = '4';
process.env.CRM_LOGIN_MAX_IP = '80';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const { requireCrmSession } = require('../middleware/requireCrmSession');
const crmPortalGate = require('../middleware/crmPortalGate');
const crmAuthRoutes = require('../routes/crmAuthRoutes');
const crmRoutes = require('../routes/crmRoutes');
const { adminCrmUserRoutes, portalCrmUserRoutes } = require('../routes/crmUserAdminRoutes');
const { CRM_SECTION_KEY } = require('../constants/crm');
const { CRM_ACCESS_SECTION } = require('../constants/crmUsers');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmAuditLog = require('../models/CrmAuditLog');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmStudent = require('../models/CrmStudent');
const CrmUser = require('../models/CrmUser');

let mongo;
let server;
let baseUrl;
let superAdmin;
let superToken;

function signAdmin(admin) {
  return jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
}

function storeCookies(response, jar) {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  lines.forEach((line) => {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index === -1) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value || /Max-Age=0/i.test(line) || /1970/.test(line)) delete jar[name];
    else jar[name] = decodeURIComponent(value);
  });
}

async function request(method, urlPath, { token, jar, csrf, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (jar && Object.keys(jar).length) {
    headers.Cookie = Object.entries(jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
  }
  if (csrf) headers['x-crm-csrf'] = csrf;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (jar) storeCookies(response, jar);
  return { status: response.status, data };
}

describe('CRM remark audits and activity labels', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_remark_activity_test' });
    await syncCrmIndexes();
    const app = express();
    app.use(express.json());
    app.use('/api/crm-auth', crmAuthRoutes);
    app.use('/api/crm/users', requireCrmSession, portalCrmUserRoutes);
    app.use('/api/crm', requireCrmSession, crmPortalGate, crmRoutes);
    app.use(
      '/api/admin/crm-users',
      requireAdmin,
      requireAdminSection(CRM_ACCESS_SECTION, 'CRM access management is required.'),
      adminCrmUserRoutes
    );
    app.use(
      '/api/admin/crm',
      requireAdmin,
      requireAdminSection(CRM_SECTION_KEY, 'Consultancy CRM access is required.'),
      crmRoutes
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      Admin.deleteMany({}),
      CrmUser.deleteMany({}),
      CrmConsultancy.deleteMany({}),
      CrmStudent.deleteMany({}),
      CrmAuditLog.deleteMany({}),
    ]);
    superAdmin = await Admin.create({
      name: 'Super',
      username: 'super-remark',
      email: 'super-remark@example.com',
      password: 'hashed',
      isSuperAdmin: true,
      sectionAccess: [CRM_SECTION_KEY, CRM_ACCESS_SECTION],
    });
    superToken = signAdmin(superAdmin);
  });

  async function createAccount(overrides = {}) {
    const email = overrides.email || `user${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;
    const result = await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: {
        fullName: overrides.fullName || 'Remark Author',
        email,
        username: overrides.username,
        password: 'Password123',
        role: overrides.role || 'crm_manager',
        permissions: overrides.permissions,
      },
    });
    return { ...result, email, password: 'Password123' };
  }

  async function login(email, password) {
    const jar = {};
    const result = await request('POST', '/api/crm-auth/login', {
      jar,
      body: { identifier: email, password },
    });
    return { ...result, jar, csrf: result.data.data && result.data.data.csrfToken };
  }

  test('remark create and edit audits store text, skip no-ops, and redact without consultancies.read', async () => {
    const house = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Remark House' },
    });
    const consultancyId = house.data.data.consultancy.id;
    const author = await createAccount({
      role: 'crm_manager',
      email: 'remark-author@example.com',
      username: 'remark.author',
      fullName: 'Remark Author',
    });
    assert.equal(author.status, 201);
    assert.equal((await request('POST', `/api/admin/crm-users/${author.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const session = await login(author.email, author.password);

    const created = await request('POST', `/api/crm/consultancies/${consultancyId}/remarks`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: 'First private note' },
    });
    assert.equal(created.status, 201);
    const remarkId = created.data.data.remark.id;
    const added = await CrmAuditLog.findOne({ action: 'consultancy.remark_added', 'after.remarkId': remarkId }).lean();
    assert.ok(added);
    assert.equal(added.after.text, 'First private note');
    assert.equal(String(added.entityId), consultancyId);
    assert.equal(String(added.actorCrmUserId), author.data.data.user.id);

    const noChange = await request('PATCH', `/api/crm/consultancies/${consultancyId}/remarks/${remarkId}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: 'First private note' },
    });
    assert.equal(noChange.status, 200);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'consultancy.remark_edited', 'after.remarkId': remarkId }), 0);

    const edited = await request('PATCH', `/api/crm/consultancies/${consultancyId}/remarks/${remarkId}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: 'Updated private note' },
    });
    assert.equal(edited.status, 200);
    const editAudits = await CrmAuditLog.find({ action: 'consultancy.remark_edited', 'after.remarkId': remarkId }).lean();
    assert.equal(editAudits.length, 1);
    assert.equal(editAudits[0].before.text, 'First private note');
    assert.equal(editAudits[0].after.text, 'Updated private note');

    const visible = await request(
      'GET',
      `/api/crm/activity?page=1&limit=20&action=consultancy.remark_edited&consultancyId=${consultancyId}`,
      { jar: session.jar }
    );
    assert.equal(visible.status, 200);
    assert.equal(visible.data.data.total, 1);
    const visibleEvent = visible.data.data.items[0];
    assert.equal(visibleEvent.actor.displayName, 'Remark Author');
    assert.equal(visibleEvent.consultancyName, 'Remark House');
    assert.equal(visibleEvent.entityLabel, 'Remark House');
    assert.equal(visibleEvent.after.text, 'Updated private note');
    assert.equal(visibleEvent.before.text, 'First private note');
    const textChange = visibleEvent.changes.find((change) => change.field === 'text');
    assert.equal(textChange.before, 'First private note');
    assert.equal(textChange.after, 'Updated private note');

    const auditOnly = await createAccount({
      role: 'crm_viewer',
      email: 'audit-only@example.com',
      username: 'audit.only',
      fullName: 'Audit Only',
      permissions: ['crm.audit.read', 'crm.dashboard.read'],
    });
    assert.equal(auditOnly.status, 201);
    assert.equal((await request('POST', `/api/admin/crm-users/${auditOnly.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const limited = await login(auditOnly.email, auditOnly.password);
    const redacted = await request(
      'GET',
      `/api/crm/activity?page=1&limit=20&action=consultancy.remark_edited&consultancyId=${consultancyId}`,
      { jar: limited.jar }
    );
    assert.equal(redacted.status, 200);
    assert.equal(redacted.data.data.total, 1);
    assert.equal(redacted.data.data.items[0].after.text, '[redacted]');
    assert.equal(redacted.data.data.items[0].before.text, '[redacted]');
    const redactedChange = redacted.data.data.items[0].changes.find((change) => change.field === 'text');
    assert.equal(redactedChange.before, '[redacted]');
    assert.equal(redactedChange.after, '[redacted]');
    assert.equal(JSON.stringify(redacted.data).includes('Updated private note'), false);

    const foreign = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Hidden Remark House' },
    });
    const foreignId = foreign.data.data.consultancy.id;
    const blocked = await request(
      'GET',
      `/api/crm/activity?page=1&limit=20&consultancyId=${foreignId}`,
      { jar: session.jar }
    );
    assert.equal(blocked.status, 404);
  });

  test('activity resolves actor and student labels and tolerates missing actors', async () => {
    const house = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Label House' },
    });
    const consultancyId = house.data.data.consultancy.id;
    const author = await createAccount({
      role: 'crm_administrator',
      email: 'label-admin@example.com',
      username: 'label.admin',
      fullName: 'Label Admin',
    });
    assert.equal(author.status, 201);
    assert.equal((await request('POST', `/api/admin/crm-users/${author.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const session = await login(author.email, author.password);
    const student = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Label Student', phone: '9111000001', consultancyId },
    });
    assert.equal(student.status, 201);
    const studentId = student.data.data.student.id;

    const listed = await request(
      'GET',
      `/api/crm/activity?page=1&limit=20&action=student.created&entityType=student&entityId=${studentId}`,
      { jar: session.jar }
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.data.data.total, 1);
    assert.equal(listed.data.data.items[0].entityLabel, 'Label Student');
    assert.equal(listed.data.data.items[0].actor.displayName, 'Label Admin');
    assert.equal(listed.data.data.items[0].actor.name, 'Label Admin');

    const orphanId = new mongoose.Types.ObjectId();
    await CrmAuditLog.create({
      actorCrmUserId: orphanId,
      action: 'consultancy.updated',
      entityType: 'consultancy',
      entityId: consultancyId,
      before: { name: 'Label House' },
      after: { name: 'Label House Renamed' },
    });
    const orphan = await request(
      'GET',
      `/api/crm/activity?page=1&limit=20&action=consultancy.updated&actorId=${String(orphanId)}&actorType=crm-user`,
      { jar: session.jar }
    );
    assert.equal(orphan.status, 200);
    assert.equal(orphan.data.data.total, 1);
    assert.equal(orphan.data.data.items[0].actor.displayName, 'Unknown actor');
    assert.equal(orphan.data.data.items[0].actor.name, '');
    assert.equal(orphan.data.data.items[0].entityLabel, 'Label House Renamed');
    assert.equal(orphan.data.data.items[0].consultancyName, 'Label House');

    const contactAction = await request(
      'GET',
      '/api/crm/activity?page=1&limit=5&action=crm_permission.updated&source=business',
      { jar: session.jar }
    );
    assert.equal(contactAction.status, 200);

    const crmCookieOnAdmin = await request('GET', '/api/admin/crm/activity?page=1&limit=5', { jar: session.jar });
    assert.equal(crmCookieOnAdmin.status, 401);
    const adminOnPortal = await request('GET', '/api/crm/activity?page=1&limit=5', { token: superToken });
    assert.equal(adminOnPortal.status, 401);
  });
});
