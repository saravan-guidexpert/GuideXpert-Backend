'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-consultancy-workspace-test-secret';
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
let phoneSerial = 8500000000;

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

describe('Super Admin consultancy workspace', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_consultancy_workspace_test' });
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
      username: 'workspace-super',
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

  async function createConsultancy(name, status = 'active') {
    const result = await request('POST', '/api/admin/crm/consultancies', { token: superToken, body: { name, status } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.data.consultancy;
  }

  async function adminAssign(userId, consultancyId) {
    const result = await request('POST', `/api/admin/crm-users/${userId}/assignments`, {
      token: superToken,
      body: { consultancyId },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
  }

  async function seed() {
    const admin = await createAccount('Dana Admin', 'crm_administrator');
    const manager = await createAccount('Mira Manager', 'crm_manager');
    const viewer = await createAccount('Vik Viewer', 'crm_viewer');
    const alpha = await createConsultancy('Alpha House');
    const beta = await createConsultancy('Beta Bridge');
    const gamma = await createConsultancy('Gamma Quiet', 'inactive');
    const delta = await createConsultancy('Delta Point');
    await adminAssign(manager.id, alpha.id);
    await adminAssign(viewer.id, alpha.id);
    await adminAssign(manager.id, beta.id);
    const student = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Referred Student', phone: nextPhone(), consultancyId: alpha.id },
    });
    assert.equal(student.status, 201, JSON.stringify(student.data));
    return { admin, manager, viewer, alpha, beta, gamma, delta };
  }

  test('organization-wide overview, summary, filters, sort and pagination for crm.roles.manage', async () => {
    const { admin, manager, alpha, beta } = await seed();
    const session = await login(admin.email);
    const base = '/api/crm/consultancies/overview';

    const all = await request('GET', `${base}?page=1&limit=10`, { jar: session.jar });
    assert.equal(all.status, 200, JSON.stringify(all.data));
    const body = all.data.data;
    assert.equal(body.total, 4);
    assert.deepEqual(body.items.map((row) => row.name), ['Alpha House', 'Beta Bridge', 'Delta Point', 'Gamma Quiet']);
    assert.equal(body.summary.scope, 'organization');
    assert.equal(body.summary.total, 4);
    assert.equal(body.summary.active, 3);
    assert.equal(body.summary.inactive, 1);
    assert.equal(body.summary.assigned, 2);
    assert.equal(body.summary.unassigned, 2);
    assert.equal(body.summary.staffAssigned, 2);
    assert.equal(body.summary.staff[0].fullName, 'Mira Manager');
    assert.equal(body.summary.staff[0].consultancies, 2);
    const alphaRow = body.items[0];
    assert.equal(alphaRow.activeAssignees, 2);
    assert.equal(alphaRow.students, 1);
    assert.equal(typeof alphaRow.createdAt, 'string');
    assert.equal(typeof alphaRow.updatedAt, 'string');
    const mira = alphaRow.assignees.find((row) => row.fullName === 'Mira Manager');
    assert.equal(mira.email, 'mira.manager@example.com');
    assert.equal(mira.roleLabel, 'CRM Manager');
    assert.equal(typeof mira.assignedAt, 'string');
    assertNoSecrets(body, session.jar);

    const searched = await request('GET', `${base}?page=1&limit=10&q=${encodeURIComponent('bridge')}`, { jar: session.jar });
    assert.deepEqual(searched.data.data.items.map((row) => row.name), ['Beta Bridge']);
    assert.equal(searched.data.data.summary.total, 4);
    const regexText = await request('GET', `${base}?page=1&limit=10&q=${encodeURIComponent('.*')}`, { jar: session.jar });
    assert.equal(regexText.status, 200);
    assert.equal(regexText.data.data.total, 0);

    const byStaff = await request('GET', `${base}?page=1&limit=10&userId=${manager.id}`, { jar: session.jar });
    assert.deepEqual(byStaff.data.data.items.map((row) => row.id), [alpha.id, beta.id]);
    const staffUnassigned = await request('GET', `${base}?page=1&limit=10&userId=${manager.id}&assignment=unassigned`, {
      jar: session.jar,
    });
    assert.equal(staffUnassigned.data.data.total, 0);
    const inactive = await request('GET', `${base}?page=1&limit=10&status=inactive`, { jar: session.jar });
    assert.deepEqual(inactive.data.data.items.map((row) => row.name), ['Gamma Quiet']);
    const unassigned = await request('GET', `${base}?page=1&limit=10&assignment=unassigned&status=active`, { jar: session.jar });
    assert.deepEqual(unassigned.data.data.items.map((row) => row.name), ['Delta Point']);

    const byAssignees = await request('GET', `${base}?page=1&limit=10&sort=assignees`, { jar: session.jar });
    assert.deepEqual(byAssignees.data.data.items.map((row) => row.name).slice(0, 2), ['Alpha House', 'Beta Bridge']);
    await CrmConsultancy.updateOne({ name: 'Delta Point' }, { $set: { notes: 'touched' } });
    const updated = await request('GET', `${base}?page=1&limit=10&sort=updated`, { jar: session.jar });
    assert.equal(updated.data.data.items[0].name, 'Delta Point');

    const pages = [];
    for (let page = 1; page <= 2; page += 1) {
      const listed = await request('GET', `${base}?page=${page}&limit=2`, { jar: session.jar });
      assert.equal(listed.data.data.total, 4);
      pages.push(...listed.data.data.items.map((row) => row.name));
    }
    assert.deepEqual(pages, ['Alpha House', 'Beta Bridge', 'Delta Point', 'Gamma Quiet']);

    for (const bad of ['sort=newest', 'userId=nope', 'assignment=maybe', 'status=archived', `q=${'x'.repeat(101)}`, 'extra=1']) {
      const rejected = await request('GET', `${base}?page=1&limit=10&${bad}`, { jar: session.jar });
      assert.equal(rejected.status, 400, bad);
    }
  });

  test('managers and viewers stay assignment-scoped with no organization summary or contact details', async () => {
    const { manager, viewer } = await seed();
    const managerSession = await login(manager.email);
    const listed = await request('GET', '/api/crm/consultancies/overview?page=1&limit=10', { jar: managerSession.jar });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.data.items.map((row) => row.name), ['Alpha House', 'Beta Bridge']);
    assert.equal(listed.data.data.summary, null);
    assert.equal(listed.data.data.unassignedConsultancies, null);
    listed.data.data.items.forEach((row) => row.assignees.forEach((person) => assert.equal(person.email, null)));

    const viewerSession = await login(viewer.email);
    const viewerList = await request('GET', '/api/crm/consultancies/overview?page=1&limit=10&q=delta', { jar: viewerSession.jar });
    assert.equal(viewerList.status, 200);
    assert.equal(viewerList.data.data.total, 0);
    assert.equal(viewerList.data.data.summary, null);

    const directory = await request('GET', '/api/crm/users/directory?page=1&limit=10', { jar: managerSession.jar });
    assert.equal(directory.status, 403);
    const create = await request('POST', '/api/crm/consultancies', {
      jar: viewerSession.jar,
      csrf: viewerSession.csrf,
      body: { name: 'Viewer Made' },
    });
    assert.equal(create.status, 403);
  });

  test('assignment workflow: assign, duplicate, revoke, history, and authorization', async () => {
    const { admin, manager, viewer, delta } = await seed();
    const session = await login(admin.email);
    const assignPath = `/api/crm/users/${viewer.id}/assignments`;

    const noCsrf = await request('POST', assignPath, { jar: session.jar, body: { consultancyId: delta.id } });
    assert.equal(noCsrf.status, 403);
    const assigned = await request('POST', assignPath, { jar: session.jar, csrf: session.csrf, body: { consultancyId: delta.id } });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.data));
    const duplicate = await request('POST', assignPath, { jar: session.jar, csrf: session.csrf, body: { consultancyId: delta.id } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_assignment');
    assert.equal(await CrmConsultancyAssignment.countDocuments({ consultancyId: delta.id, revokedAt: null }), 1);

    const managerSession = await login(manager.email);
    const managerAssign = await request('POST', assignPath, {
      jar: managerSession.jar,
      csrf: managerSession.csrf,
      body: { consultancyId: delta.id },
    });
    assert.equal(managerAssign.status, 403);

    const assignees = await request('GET', `/api/crm/users/by-consultancy/${delta.id}?page=1&limit=20`, { jar: session.jar });
    assert.equal(assignees.status, 200);
    assert.equal(assignees.data.data.items.length, 1);
    assert.equal(assignees.data.data.items[0].userName, 'Vik Viewer');

    const revoked = await request('DELETE', `${assignPath}/${delta.id}`, { jar: session.jar, csrf: session.csrf });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
    const after = await request('GET', '/api/crm/consultancies/overview?page=1&limit=10&q=delta', { jar: session.jar });
    assert.equal(after.data.data.items[0].activeAssignees, 0);
    assert.equal(after.data.data.summary.unassigned, 2);

    const today = new Date().toISOString().slice(0, 10);
    const history = await request(
      'GET',
      `/api/crm/history/assignments?consultancyId=${delta.id}&from=2020-01-01&to=${today}&page=1&limit=20`,
      { jar: session.jar }
    );
    assert.equal(history.status, 200, JSON.stringify(history.data));
    assert.equal(history.data.data.items.length, 1);
    assert.equal(history.data.data.items[0].state, 'revoked');
    assert.deepEqual(history.data.data.items[0].events.map((event) => event.action), ['assigned', 'revoked']);
    assertNoSecrets(history.data.data, session.jar);

    const signedOut = await request('GET', '/api/crm/consultancies/overview?page=1&limit=10', { jar: {} });
    assert.equal(signedOut.status, 401);
  });

  test('creating a consultancy from the portal rejects duplicates and auto-assigns the creator', async () => {
    const { admin } = await seed();
    const session = await login(admin.email);
    const created = await request('POST', '/api/crm/consultancies', {
      jar: session.jar,
      csrf: session.csrf,
      body: { name: 'Epsilon Works', status: 'active', notes: 'Pilot partner' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.data.consultancy.id;
    assert.equal(await CrmConsultancyAssignment.countDocuments({ consultancyId: id, crmUserId: admin.id, revokedAt: null }), 1);

    const duplicate = await request('POST', '/api/crm/consultancies', {
      jar: session.jar,
      csrf: session.csrf,
      body: { name: '  epsilon   works ' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_consultancy');
    assert.equal(await CrmConsultancy.countDocuments({ deletedAt: null }), 5);

    const invalid = await request('POST', '/api/crm/consultancies', {
      jar: session.jar,
      csrf: session.csrf,
      body: { name: 'X' },
    });
    assert.equal(invalid.status, 400);
  });
});
