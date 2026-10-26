'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-history-test-secret';
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
const { CRM_ACCESS_SECTION, permissionForCrmRequest } = require('../constants/crmUsers');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { setAuditWriterForTests, resetAuditWriterForTests } = require('../services/crm/auditService');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmStudent = require('../models/CrmStudent');
const CrmReferral = require('../models/CrmReferral');
const CrmAuditLog = require('../models/CrmAuditLog');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');

let mongo;
let server;
let baseUrl;
let superAdmin;
let superToken;
let phoneSerial = 8300000000;

function nextPhone() {
  phoneSerial += 1;
  return String(phoneSerial);
}

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
  const data = await response.json().catch(() => ({}));
  if (jar) storeCookies(response, jar);
  return { status: response.status, data };
}

describe('CRM historical reporting', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_history_test' });
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
    superAdmin = await Admin.create({
      username: 'history-super',
      password: 'secret12',
      name: 'History Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    superToken = signAdmin(superAdmin);
  });

  after(async () => {
    resetAuditWriterForTests();
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    resetLoginLimiterForTests();
    resetAuditWriterForTests();
    await Promise.all([
      CrmUser.deleteMany({}),
      CrmSession.deleteMany({}),
      CrmConsultancy.deleteMany({}),
      CrmConsultancyAssignment.deleteMany({}),
      CrmStudent.deleteMany({}),
      CrmReferral.deleteMany({}),
      CrmAuditLog.deleteMany({}),
      CrmAuthAuditLog.deleteMany({}),
    ]);
  });

  test('records real admission changes once, keeps assignment rows, and uses the supplied day boundary', async () => {
    assert.equal(permissionForCrmRequest('GET', '/api/crm/history/admissions?page=1'), 'crm.audit.read');
    assert.equal(permissionForCrmRequest('GET', '/api/crm/history/assignments'), 'crm.audit.read');
    assert.equal(permissionForCrmRequest('GET', '/api/crm/history/daily'), 'crm.audit.read');

    const alpha = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Alpha History' },
    });
    const beta = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Beta History' },
    });
    assert.equal(alpha.status, 201);
    assert.equal(beta.status, 201);
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;

    const studentPhone = nextPhone();
    const created = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'History Student', phone: studentPhone, consultancyId: alphaId },
    });
    assert.equal(created.status, 201);
    const studentId = created.data.data.student.id;
    const other = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Other History Student', phone: nextPhone(), consultancyId: betaId, admissionStatus: 'Admitted' },
    });
    assert.equal(other.status, 201);
    const legacy = await CrmStudent.create({
      fullName: 'Legacy Without Audit',
      phone: nextPhone(),
      createdBy: superAdmin._id,
      admissionStatus: 'Enrolled',
    });

    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const failed = await request('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: superToken,
      body: { admissionStatus: 'Enrolled' },
    });
    resetAuditWriterForTests();
    assert.notEqual(failed.status, 200);
    assert.equal((await CrmStudent.findById(studentId).lean()).admissionStatus, 'Not started');

    const contacted = await request('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: superToken,
      body: { admissionStatus: 'Contacted' },
    });
    assert.equal(contacted.status, 200);
    const renamed = await request('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: superToken,
      body: { fullName: 'History Student Renamed' },
    });
    assert.equal(renamed.status, 200);
    const repeated = await request('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: superToken,
      body: { admissionStatus: 'Contacted' },
    });
    assert.equal(repeated.status, 200);
    const applied = await request('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: superToken,
      body: { admissionStatus: 'Applied' },
    });
    assert.equal(applied.status, 200);

    const window = 'from=2024-01-01&to=2026-12-31&timeZone=Asia/Kolkata&page=1&limit=50';
    const admissions = await request('GET', `/api/admin/crm/history/admissions?${window}&studentId=${studentId}`, {
      token: superToken,
    });
    assert.equal(admissions.status, 200);
    assert.equal(admissions.data.data.timeZone, 'Asia/Kolkata');
    assert.equal(admissions.data.data.timeZoneConfirmed, undefined);
    const kinds = admissions.data.data.items.map((row) => `${row.kind}:${row.previousStatus || ''}:${row.nextStatus}`);
    assert.deepEqual(kinds, [
      'transition:Contacted:Applied',
      'transition:Not started:Contacted',
      'initial::Not started',
    ]);
    assert.equal(admissions.data.data.items.filter((row) => row.nextStatus === 'Contacted' && row.kind === 'transition').length, 1);
    assert.equal(admissions.data.data.items.some((row) => row.studentId === String(legacy._id)), false);
    assert.equal(JSON.stringify(admissions.data).includes(studentPhone), false);
    assert.equal(admissions.data.data.limitations.some((line) => line.includes('not filled in')), true);

    const administrator = await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: {
        fullName: 'History Admin',
        email: 'history-admin@example.com',
        username: 'history.admin',
        password: 'Password123',
        role: 'crm_administrator',
      },
    });
    const manager = await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: {
        fullName: 'History Manager',
        email: 'history-manager@example.com',
        username: 'history.manager',
        password: 'Password123',
        role: 'crm_manager',
      },
    });
    assert.equal(administrator.status, 201);
    assert.equal(manager.status, 201);
    const adminId = administrator.data.data.user.id;
    const managerId = manager.data.data.user.id;
    assert.equal((await request('POST', `/api/admin/crm-users/${adminId}/assignments`, {
      token: superToken,
      body: { consultancyId: alphaId },
    })).status, 201);
    assert.equal((await request('POST', `/api/admin/crm-users/${managerId}/assignments`, {
      token: superToken,
      body: { consultancyId: betaId },
    })).status, 201);

    async function login(email) {
      const jar = {};
      const result = await request('POST', '/api/crm-auth/login', {
        jar,
        body: { identifier: email, password: 'Password123' },
      });
      return { ...result, jar, csrf: result.data.data && result.data.data.csrfToken };
    }
    const adminSession = await login('history-admin@example.com');
    const managerSession = await login('history-manager@example.com');
    assert.equal(adminSession.status, 200);
    assert.equal(managerSession.status, 200);
    const deniedAssign = await request('POST', `/api/crm/users/${adminId}/assignments`, {
      jar: managerSession.jar,
      csrf: managerSession.csrf,
      body: { consultancyId: alphaId },
    });
    assert.equal(deniedAssign.status, 403);

    const adminList = await request('GET', `/api/crm/history/admissions?${window}`, { jar: adminSession.jar });
    assert.equal(adminList.status, 200);
    assert.equal(adminList.data.data.scope, 'assigned');
    assert.equal(adminList.data.data.items.some((row) => row.studentId === studentId), true);
    assert.equal(adminList.data.data.items.some((row) => row.studentId === other.data.data.student.id), false);
    const managerList = await request('GET', `/api/crm/history/admissions?${window}`, { jar: managerSession.jar });
    assert.equal(managerList.data.data.items.some((row) => row.studentId === other.data.data.student.id), true);
    assert.equal(managerList.data.data.items.some((row) => row.studentId === studentId), false);

    const adminDaily = await request('GET', `/api/crm/history/daily?${window}`, { jar: adminSession.jar });
    assert.equal(adminDaily.status, 200);
    assert.equal(adminDaily.data.data.aggregateScope, 'module');
    assert.equal(adminDaily.data.data.scope, 'assigned');
    assert.equal(adminDaily.data.data.timeZoneConfirmed, false);
    assert.equal(adminDaily.data.data.excluded.includes('conversion'), true);
    const createdDays = adminDaily.data.data.items.filter((row) => row.action === 'student.created');
    assert.equal(createdDays.reduce((sum, row) => sum + row.count, 0) >= 2, true);
    const managerDaily = await request('GET', `/api/crm/history/daily?${window}`, { jar: managerSession.jar });
    assert.equal(managerDaily.data.data.aggregateScope, 'assigned');
    const managerCreated = managerDaily.data.data.items.filter((row) => row.action === 'student.created');
    assert.equal(managerCreated.reduce((sum, row) => sum + row.count, 0), 1);

    const boundary = await CrmAuditLog.create({
      actorAdminId: superAdmin._id,
      action: 'student.updated',
      entityType: 'crmStudent',
      entityId: studentId,
      before: { admissionStatus: 'Applied' },
      after: { admissionStatus: 'Admitted' },
    });
    await CrmAuditLog.collection.updateOne(
      { _id: boundary._id },
      { $set: { createdAt: new Date('2026-04-02T18:30:00.000Z') } }
    );
    const kolkata = await request('GET', '/api/admin/crm/history/daily?from=2026-04-02&to=2026-04-03&timeZone=Asia/Kolkata&page=1&limit=20', {
      token: superToken,
    });
    const utc = await request('GET', '/api/admin/crm/history/daily?from=2026-04-02&to=2026-04-03&timeZone=UTC&page=1&limit=20', {
      token: superToken,
    });
    assert.equal(kolkata.status, 200);
    assert.equal(utc.status, 200);
    assert.equal(kolkata.data.data.items.some((row) => row.day === '2026-04-03' && row.action === 'student.updated'), true);
    assert.equal(kolkata.data.data.items.some((row) => row.day === '2026-04-02' && row.action === 'student.updated'), false);
    assert.equal(utc.data.data.items.some((row) => row.day === '2026-04-02' && row.action === 'student.updated'), true);
    assert.equal(utc.data.data.items.some((row) => row.day === '2026-04-03' && row.action === 'student.updated'), false);
    assert.equal(kolkata.data.data.items.some((row) => row.count === 0), false);

    const intervals = await request('GET', `/api/admin/crm/history/assignments?${window}&consultancyId=${alphaId}`, {
      token: superToken,
    });
    assert.equal(intervals.status, 200);
    assert.equal(intervals.data.data.source, 'crmConsultancyAssignments');
    const open = intervals.data.data.items.find((row) => row.userId === adminId);
    assert.ok(open);
    assert.equal(open.state, 'active');
    assert.deepEqual(open.events.map((event) => event.action), ['assigned']);
    assert.equal(open.consultancyName, 'Alpha History');
    const revoked = await request('DELETE', `/api/admin/crm-users/${adminId}/assignments/${alphaId}`, {
      token: superToken,
    });
    assert.equal(revoked.status, 200);
    const closed = await request('GET', `/api/admin/crm/history/assignments?${window}&consultancyId=${alphaId}&assignment=revoked`, {
      token: superToken,
    });
    const closedRow = closed.data.data.items.find((row) => row.userId === adminId);
    assert.ok(closedRow);
    assert.equal(closedRow.state, 'revoked');
    assert.deepEqual(closedRow.events.map((event) => event.action), ['assigned', 'revoked']);
    assert.equal(await CrmAuthAuditLog.countDocuments({ action: 'crm_assignment.revoked', targetUserId: adminId }), 1);
  });
});
