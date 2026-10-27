'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-activity-intel-test-secret';
process.env.CRM_BCRYPT_ROUNDS = '4';
process.env.CRM_LOGIN_MAX_IP = '200';

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
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { resetHeartbeatLimiterForTests } = require('../services/crm/crmPresence');
const { resetAuthAuditWriterForTests } = require('../services/crm/crmAuthAudit');
const { setTransactionsEnabledForTests } = require('../utils/crmMutation');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmStudent = require('../models/CrmStudent');
const CrmReferral = require('../models/CrmReferral');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');
const CrmAuditLog = require('../models/CrmAuditLog');

let mongo;
let server;
let baseUrl;
let superToken;
let staffToken;
let phoneSerial = 8600000000;

function signAdmin(admin) {
  return jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
}

function nextPhone() {
  phoneSerial += 1;
  return String(phoneSerial);
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

function assertNoSecrets(payload, jar) {
  const text = JSON.stringify(payload);
  assert.equal(text.includes('tokenHash'), false);
  assert.equal(text.includes('csrfToken'), false);
  assert.equal(text.includes('passwordHash'), false);
  assert.equal(text.includes('gx_crm_session'), false);
  assert.equal(text.includes('userAgent'), false);
  if (jar && jar.gx_crm_session) assert.equal(text.includes(jar.gx_crm_session), false);
}


describe('Activity & Audit Intelligence', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_activity_intel_test' });
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
    const superAdmin = await Admin.create({
      username: 'activity-intel-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    superToken = signAdmin(superAdmin);
  });

  after(async () => {
    resetAuthAuditWriterForTests();
    setTransactionsEnabledForTests(true);
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    resetLoginLimiterForTests();
    resetHeartbeatLimiterForTests();
    resetAuthAuditWriterForTests();
    setTransactionsEnabledForTests(true);
    await Promise.all([
      CrmUser.deleteMany({}),
      CrmSession.deleteMany({}),
      CrmConsultancy.deleteMany({}),
      CrmConsultancyAssignment.deleteMany({}),
      CrmStudent.deleteMany({}),
      CrmReferral.deleteMany({}),
      CrmAuthAuditLog.deleteMany({}),
      CrmAuditLog.deleteMany({}),
    ]);
  });

  async function createAccount(fullName, role) {
    const email = `${fullName.toLowerCase().replace(/\s+/g, '.')}@example.com`;
    const result = await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: { fullName, email, password: 'Password123', role },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { id: result.data.data.user.id, email };
  }

  async function login(email) {
    const jar = {};
    const result = await request('POST', '/api/crm-auth/login', { jar, body: { identifier: email, password: 'Password123' } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { jar, csrf: result.data.data.csrfToken };
  }

  test('organization summary names actors and exposes transparent insights', async () => {
    const admin = await createAccount('Dana Admin', 'crm_administrator');
    const manager = await createAccount('Mira Manager', 'crm_manager');
    const session = await login(admin.email);
    const created = await request('POST', '/api/crm/consultancies', {
      jar: session.jar,
      csrf: session.csrf,
      body: { name: 'Horizon Study Circle', status: 'active' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const houseId = created.data.data.consultancy.id;
    const assigned = await request('POST', `/api/crm/users/${manager.id}/assignments`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { consultancyId: houseId },
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.data));

    const today = new Date().toISOString().slice(0, 10);
    const summary = await request(
      'GET',
      `/api/crm/activity/summary?from=${today}&to=${today}&timeZone=Asia/Kolkata&limit=10`,
      { jar: session.jar }
    );
    assert.equal(summary.status, 200, JSON.stringify(summary.data));
    const body = summary.data.data;
    assert.equal(body.timeZone, 'Asia/Kolkata');
    assert.equal(body.timeZoneConfirmed, false);
    assert.ok(body.business.total >= 1);
    assert.ok(body.insights.activeCrmUsers >= 1);
    assert.ok(body.insights.consultanciesTouched >= 1);
    assert.ok(body.insights.recordsCreated >= 1);
    assert.ok(Array.isArray(body.series.business));
    assert.ok(body.staff.some((row) => row.fullName === 'Dana Admin'));
    assert.ok(body.recent.some((row) => row.actor && row.actor.name === 'Dana Admin'));
    assertNoSecrets(body, session.jar);

    const list = await request(
      'GET',
      `/api/crm/activity?page=1&limit=20&from=${today}&to=${today}&timeZone=Asia/Kolkata&action=crm_assignment.created`,
      { jar: session.jar }
    );
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const event = list.data.data.items.find((row) => row.action === 'crm_assignment.created');
    assert.ok(event);
    assert.equal(event.actor.name, 'Dana Admin');
    assert.equal(event.targetUserName, 'Mira Manager');
    assert.equal(event.consultancyName, 'Horizon Study Circle');

    const detail = await request('GET', `/api/crm/activity/${event.source}/${event.id}`, { jar: session.jar });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.event.actor.name, 'Dana Admin');
    assertNoSecrets(detail.data.data, session.jar);
  });

  test('managers stay assignment-scoped and cannot read organization staff directory', async () => {
    const admin = await createAccount('Dana Admin', 'crm_administrator');
    const manager = await createAccount('Mira Manager', 'crm_manager');
    const adminSession = await login(admin.email);
    const house = await request('POST', '/api/crm/consultancies', {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { name: 'Scoped House' },
    });
    assert.equal(house.status, 201);
    await request('POST', `/api/crm/users/${manager.id}/assignments`, {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { consultancyId: house.data.data.consultancy.id },
    });
    // create a second consultancy the manager cannot see
    await request('POST', '/api/crm/consultancies', {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { name: 'Hidden House' },
    });

    const managerSession = await login(manager.email);
    const today = new Date().toISOString().slice(0, 10);
    const summary = await request(
      'GET',
      `/api/crm/activity/summary?from=${today}&to=${today}&timeZone=Asia/Kolkata&limit=5`,
      { jar: managerSession.jar }
    );
    assert.equal(summary.status, 200);
    assert.equal(summary.data.data.recordScope, 'assigned');
    assert.equal(summary.data.data.accountEventsIncluded, false);
    assert.equal(summary.data.data.security.signInFailed, null);
    const text = JSON.stringify(summary.data.data);
    assert.equal(text.includes('Hidden House'), false);

    const directory = await request('GET', '/api/crm/users/directory?page=1&limit=10', { jar: managerSession.jar });
    assert.equal(directory.status, 403);

    const signedOut = await request('GET', '/api/crm/activity?page=1&limit=10', { jar: {} });
    assert.equal(signedOut.status, 401);
  });
});
