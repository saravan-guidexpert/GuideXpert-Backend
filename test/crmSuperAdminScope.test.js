'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-super-admin-scope-secret';
process.env.CRM_BCRYPT_ROUNDS = '4';
process.env.CRM_LOGIN_MAX_IP = '80';

const { describe, test, before, after } = require('node:test');
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
const { CRM_SECTION, CRM_SECTION_KEY } = require('../constants/crm');
const { CRM_ACCESS_SECTION } = require('../constants/crmUsers');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { auditCrmPermissionChange } = require('../services/crm/permissionAudit');
const { canReadOrganization, reportingConsultancyIds } = require('../services/crm/crmAccess');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');

let mongo;
let server;
let baseUrl;
let platform;
let platformToken;
let phoneSerial = 8600000000;
const ids = {};
const sessions = {};

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

async function request(method, urlPath, { token, session, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session && Object.keys(session.jar).length) {
    headers.Cookie = Object.entries(session.jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
  }
  if (session && session.csrf) headers['x-crm-csrf'] = session.csrf;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (session) storeCookies(response, session.jar);
  return { status: response.status, data };
}

async function login(email) {
  const session = { jar: {}, csrf: '' };
  const result = await request('POST', '/api/crm-auth/login', { session, body: { identifier: email, password: 'Password123' } });
  assert.equal(result.status, 200);
  session.csrf = result.data.data.csrfToken;
  return session;
}

const RANGE = 'from=2024-01-01&to=2030-12-31&timeZone=Asia/Kolkata';

describe('Super Admin organization-wide reporting scope', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_super_admin_scope_test' });
    await syncCrmIndexes();
    const app = express();
    app.use(express.json());
    app.use('/api/crm-auth', crmAuthRoutes);
    app.use('/api/crm/users', requireCrmSession, portalCrmUserRoutes);
    app.use('/api/crm', requireCrmSession, crmPortalGate, crmRoutes);
    app.use('/api/admin/crm-users', requireAdmin, requireAdminSection(CRM_ACCESS_SECTION, 'CRM access management is required.'), adminCrmUserRoutes);
    app.use('/api/admin/crm', requireAdmin, requireAdminSection(CRM_SECTION_KEY, 'Consultancy CRM access is required.'), crmRoutes);
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resetLoginLimiterForTests();

    platform = await Admin.create({ username: 'scope-platform', password: 'secret12', name: 'Scope Platform', isSuperAdmin: true, sectionAccess: [] });
    platformToken = jwt.sign({ adminId: platform._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
    const target = await Admin.create({ username: 'scope-target', password: 'secret12', name: 'Scope Target', isSuperAdmin: false, sectionAccess: [] });

    async function consultancy(name) {
      const created = await request('POST', '/api/admin/crm/consultancies', { token: platformToken, body: { name } });
      assert.equal(created.status, 201);
      return created.data.data.consultancy.id;
    }
    ids.alpha = await consultancy('Alpha Scope');
    ids.beta = await consultancy('Beta Scope');

    async function user(fullName, email, username, role) {
      const created = await request('POST', '/api/admin/crm-users', {
        token: platformToken,
        body: { fullName, email, username, password: 'Password123', role },
      });
      assert.equal(created.status, 201);
      return created.data.data.user.id;
    }
    ids.superUser = await user('Scope Super Admin', 'scope-super@example.com', 'scope.super', 'crm_administrator');
    ids.manager = await user('Scope Manager', 'scope-manager@example.com', 'scope.manager', 'crm_manager');
    ids.viewer = await user('Scope Viewer', 'scope-viewer@example.com', 'scope.viewer', 'crm_viewer');
    ids.betaStaff = await user('Beta Staff', 'scope-beta@example.com', 'scope.beta', 'crm_manager');
    for (const [userId, consultancyId] of [[ids.manager, ids.alpha], [ids.viewer, ids.alpha], [ids.betaStaff, ids.beta]]) {
      const assigned = await request('POST', `/api/admin/crm-users/${userId}/assignments`, { token: platformToken, body: { consultancyId } });
      assert.equal(assigned.status, 201);
    }

    const alphaStudent = await request('POST', '/api/admin/crm/students', {
      token: platformToken,
      body: { fullName: 'Alpha Learner', phone: nextPhone(), consultancyId: ids.alpha },
    });
    const betaStudent = await request('POST', '/api/admin/crm/students', {
      token: platformToken,
      body: { fullName: 'Beta Learner', phone: nextPhone(), consultancyId: ids.beta },
    });
    const orphan = await request('POST', '/api/admin/crm/students', {
      token: platformToken,
      body: { fullName: 'Unreferred Learner', phone: nextPhone() },
    });
    assert.equal(orphan.status, 201);
    ids.alphaStudent = alphaStudent.data.data.student.id;
    ids.betaStudent = betaStudent.data.data.student.id;
    ids.orphan = orphan.data.data.student.id;
    for (const id of [ids.alphaStudent, ids.betaStudent, ids.orphan]) {
      assert.equal((await request('PATCH', `/api/admin/crm/students/${id}`, { token: platformToken, body: { admissionStatus: 'Contacted' } })).status, 200);
    }
    for (const id of [ids.alpha, ids.beta]) {
      const recorded = await request('POST', `/api/admin/crm/consultancies/${id}/follow-ups`, {
        token: platformToken,
        body: { followUpStatus: 'Follow-up Required', nextAction: 'Call back', scheduledAt: new Date(Date.now() - 3600000).toISOString() },
      });
      assert.equal(recorded.status, 200);
    }
    await auditCrmPermissionChange({
      actorAdminId: platform._id,
      targetAdminId: target._id,
      beforeAdmin: { isSuperAdmin: false, sectionAccess: [] },
      afterAdmin: { isSuperAdmin: false, sectionAccess: [CRM_SECTION] },
    });

    sessions.superUser = await login('scope-super@example.com');
    sessions.manager = await login('scope-manager@example.com');
    sessions.viewer = await login('scope-viewer@example.com');
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  test('the policy reads stored permissions and does not widen anyone without crm.roles.manage', async () => {
    const superUser = await CrmUser.findById(ids.superUser).lean();
    const manager = await CrmUser.findById(ids.manager).lean();
    assert.equal(superUser.permissions.includes('crm.roles.manage'), true);
    assert.equal(manager.permissions.includes('crm.roles.manage'), false);
    assert.equal(canReadOrganization({ _id: superUser._id, actorType: 'crm-user', permissions: superUser.permissions }), true);
    assert.equal(canReadOrganization({ _id: manager._id, actorType: 'crm-user', permissions: manager.permissions }), false);
    assert.equal(canReadOrganization({ _id: platform._id, actorType: 'admin', isSuperAdmin: true }), false);
    assert.equal(await reportingConsultancyIds({ _id: superUser._id, actorType: 'crm-user', permissions: superUser.permissions }), null);
    const managerIds = await reportingConsultancyIds({ _id: manager._id, actorType: 'crm-user', permissions: manager.permissions });
    assert.deepEqual(managerIds.map(String), [ids.alpha]);
  });

  test('a Super Admin reads activity, permission events, and unreferred students across the organization', async () => {
    const business = await request('GET', '/api/crm/activity?source=business&page=1&limit=100', { session: sessions.superUser });
    assert.equal(business.status, 200);
    assert.equal(business.data.data.recordScope, 'module');
    assert.equal(business.data.data.scopeBasis, 'organization_permission');
    const items = business.data.data.items;
    assert.ok(items.some((row) => row.entityId === ids.beta && row.action === 'consultancy.created'));
    assert.ok(items.some((row) => row.action === 'crm_permission.updated'));
    assert.ok(items.some((row) => row.entityId === ids.orphan));
    const security = await request('GET', '/api/crm/activity?source=security&page=1&limit=100', { session: sessions.superUser });
    assert.ok(security.data.data.items.some((row) => row.action === 'crm_assignment.created' && row.consultancyId === ids.beta));
    assert.ok(security.data.data.items.some((row) => row.action === 'crm_user.login_succeeded'));
    const permissionOnly = await request('GET', '/api/crm/activity?action=crm_permission.updated&page=1&limit=20', { session: sessions.superUser });
    assert.equal(permissionOnly.data.data.total, 1);
    const betaOnly = await request('GET', `/api/crm/activity?consultancyId=${ids.beta}&page=1&limit=50`, { session: sessions.superUser });
    assert.equal(betaOnly.status, 200);
    assert.equal(betaOnly.data.data.recordScope, 'consultancy');
    assert.ok(betaOnly.data.data.items.length > 0);
  });

  test('a Super Admin reads history, day-end, follow-ups, workload, and consultancy analytics across the organization', async () => {
    const admissions = await request('GET', `/api/crm/history/admissions?${RANGE}&page=1&limit=50`, { session: sessions.superUser });
    assert.equal(admissions.data.data.recordScope, 'module');
    const students = admissions.data.data.items.map((row) => row.studentId);
    assert.ok(students.includes(ids.betaStudent));
    assert.ok(students.includes(ids.orphan));
    const assignments = await request('GET', `/api/crm/history/assignments?${RANGE}&page=1&limit=50`, { session: sessions.superUser });
    assert.ok(assignments.data.data.items.some((row) => row.consultancyId === ids.beta));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const dayEnd = await request('GET', `/api/crm/intelligence/day-end?date=${today}&timeZone=Asia/Kolkata&page=1&limit=100`, { session: sessions.superUser });
    assert.equal(dayEnd.data.data.recordScope, 'module');
    assert.equal(dayEnd.data.data.aggregateScope, 'module');
    assert.ok(dayEnd.data.data.items.some((row) => row.consultancyId === ids.beta));
    const follow = await request('GET', `/api/crm/intelligence/follow-ups?${RANGE}&page=1&limit=50`, { session: sessions.superUser });
    assert.ok(follow.data.data.items.some((row) => row.consultancyId === ids.beta));
    assert.equal(follow.data.data.current.overdue, 2);
    const workload = await request('GET', `/api/crm/intelligence/workload?${RANGE}&page=1&limit=50`, { session: sessions.superUser });
    assert.ok(workload.data.data.items.some((row) => row.userId === ids.betaStaff));
    const operations = await request('GET', '/api/crm/operations?period=30&timeZone=Asia/Kolkata&page=1&limit=50', { session: sessions.superUser });
    assert.equal(operations.data.data.recordScope, 'module');
    assert.deepEqual(operations.data.data.consultancies.items.map((row) => row.id).sort(), [ids.alpha, ids.beta].sort());
    const overview = await request('GET', '/api/crm/consultancies/overview?page=1&limit=50', { session: sessions.superUser });
    assert.equal(overview.data.data.total, 2);
  });

  test('managers and viewers stay inside their assigned consultancies', async () => {
    for (const name of ['manager', 'viewer']) {
      const session = sessions[name];
      const business = await request('GET', '/api/crm/activity?source=business&page=1&limit=100', { session });
      assert.equal(business.status, 200);
      assert.equal(business.data.data.recordScope, 'assigned');
      assert.equal(business.data.data.scopeBasis, 'assignment');
      const items = business.data.data.items;
      assert.equal(items.some((row) => row.entityId === ids.beta || row.entityId === ids.betaStudent), false);
      assert.equal(items.some((row) => row.action === 'crm_permission.updated'), false);
      assert.equal(items.some((row) => row.entityId === ids.orphan), false);
      const security = await request('GET', '/api/crm/activity?source=security&page=1&limit=100', { session });
      assert.equal(security.data.data.items.some((row) => row.action === 'crm_user.login_succeeded'), false);
      assert.equal(security.data.data.items.some((row) => row.consultancyId === ids.beta), false);
      assert.equal((await request('GET', `/api/crm/activity?consultancyId=${ids.beta}&page=1&limit=20`, { session })).status, 404);
      const admissions = await request('GET', `/api/crm/history/admissions?${RANGE}&page=1&limit=50`, { session });
      assert.deepEqual(admissions.data.data.items.map((row) => row.studentId), [ids.alphaStudent, ids.alphaStudent]);
      const follow = await request('GET', `/api/crm/intelligence/follow-ups?${RANGE}&page=1&limit=50`, { session });
      assert.equal(follow.data.data.aggregateScope, 'assigned');
      assert.equal(follow.data.data.current.overdue, 1);
      assert.equal(follow.data.data.items.some((row) => row.consultancyId === ids.beta), false);
      const workload = await request('GET', `/api/crm/intelligence/workload?${RANGE}&page=1&limit=50`, { session });
      assert.equal(workload.data.data.items.some((row) => row.userId === ids.betaStaff), false);
      const operations = await request('GET', '/api/crm/operations?period=30&timeZone=Asia/Kolkata&page=1&limit=50', { session });
      assert.deepEqual(operations.data.data.consultancies.items.map((row) => row.id), [ids.alpha]);
      assert.equal(operations.data.data.aggregateScope, 'assigned');
    }
    const viewerWrite = await request('POST', `/api/crm/consultancies/${ids.alpha}/follow-ups`, {
      session: sessions.viewer,
      body: { followUpStatus: 'Contacted' },
    });
    assert.equal(viewerWrite.status, 403);
  });

  test('organization-wide reads do not grant writes, and platform-admin and CRM sessions stay separate', async () => {
    const superWrite = await request('POST', `/api/crm/consultancies/${ids.beta}/follow-ups`, {
      session: sessions.superUser,
      body: { followUpStatus: 'Contacted' },
    });
    assert.equal(superWrite.status, 404);
    const record = await request('GET', `/api/crm/consultancies/${ids.beta}`, { session: sessions.superUser });
    assert.equal(record.status, 404);
    const bearerOnCrm = await request('GET', '/api/crm/activity?page=1&limit=5', { token: platformToken });
    assert.equal(bearerOnCrm.status, 401);
    const cookieOnAdmin = await request('GET', '/api/admin/crm/activity?page=1&limit=5', { session: sessions.superUser });
    assert.equal(cookieOnAdmin.status, 401);
    const platformRead = await request('GET', '/api/admin/crm/activity?source=business&page=1&limit=100', { token: platformToken });
    assert.equal(platformRead.status, 200);
    assert.equal(platformRead.data.data.scopeBasis, 'platform_admin');
    const after = await CrmUser.findById(ids.manager).lean();
    assert.equal(after.permissions.includes('crm.roles.manage'), false);
  });
});
