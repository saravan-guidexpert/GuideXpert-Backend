'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-intelligence-test-secret';
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
const { resetAuditWriterForTests } = require('../services/crm/auditService');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmConsultancyFollowUp = require('../models/CrmConsultancyFollowUp');
const CrmStudent = require('../models/CrmStudent');
const CrmReferral = require('../models/CrmReferral');
const CrmAuditLog = require('../models/CrmAuditLog');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');

let mongo;
let server;
let baseUrl;
let superAdmin;
let superToken;
let phoneSerial = 8400000000;

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

describe('CRM staff intelligence', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_intelligence_test' });
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
    superAdmin = await Admin.create({
      username: 'intelligence-super',
      password: 'secret12',
      name: 'Intelligence Super',
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
      CrmConsultancyFollowUp.deleteMany({}),
      CrmStudent.deleteMany({}),
      CrmReferral.deleteMany({}),
      CrmAuditLog.deleteMany({}),
      CrmAuthAuditLog.deleteMany({}),
    ]);
  });

  test('classifies recorded follow-ups, keeps staff totals scoped, and labels past overdue as approximate', async () => {
    assert.equal(permissionForCrmRequest('GET', '/api/crm/intelligence/follow-ups?page=1'), 'crm.audit.read');
    assert.equal(permissionForCrmRequest('GET', '/api/crm/intelligence/day-end'), 'crm.audit.read');
    assert.equal(permissionForCrmRequest('GET', '/api/crm/intelligence/workload'), 'crm.audit.read');

    const alpha = await request('POST', '/api/admin/crm/consultancies', { token: superToken, body: { name: 'Alpha Intelligence' } });
    const beta = await request('POST', '/api/admin/crm/consultancies', { token: superToken, body: { name: 'Beta Intelligence' } });
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;
    const studentPhone = nextPhone();
    const student = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Alpha Student', phone: studentPhone, consultancyId: alphaId },
    });
    const studentId = student.data.data.student.id;
    const changed = await request('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: superToken,
      body: { admissionStatus: 'Contacted' },
    });
    assert.equal(changed.status, 200);
    const legacy = await CrmStudent.create({
      fullName: 'Legacy Without Audit',
      phone: nextPhone(),
      createdBy: superAdmin._id,
      admissionStatus: 'Enrolled',
    });
    const boundaryAudit = await CrmAuditLog.findOne({ action: 'student.updated', entityId: studentId });
    await CrmAuditLog.collection.updateOne(
      { _id: boundaryAudit._id },
      { $set: { createdAt: new Date('2026-04-02T18:30:00.000Z') } }
    );

    async function followUp(consultancyId, scheduledAt) {
      return request('POST', `/api/admin/crm/consultancies/${consultancyId}/follow-ups`, {
        token: superToken,
        body: { followUpStatus: 'Follow-up Required', nextAction: 'Call again', scheduledAt },
      });
    }
    const overdue = await followUp(alphaId, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const upcoming = await followUp(alphaId, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
    const scheduled = await followUp(alphaId, '2020-06-01T09:00:00.000Z');
    const cancelled = await followUp(alphaId, '2020-06-02T09:00:00.000Z');
    const hidden = await followUp(betaId, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    assert.equal(overdue.status, 200);
    assert.equal(upcoming.status, 200);
    assert.equal(scheduled.status, 200);
    assert.equal(cancelled.status, 200);
    assert.equal(hidden.status, 200);
    const cancel = await request('POST', `/api/admin/crm/consultancies/${alphaId}/follow-ups/${cancelled.data.data.followUp.id}/cancel`, { token: superToken });
    assert.equal(cancel.status, 200);
    const cannotComplete = await request('POST', `/api/admin/crm/consultancies/${alphaId}/follow-ups/${cancelled.data.data.followUp.id}/complete`, { token: superToken });
    assert.equal(cannotComplete.status, 409);
    await CrmConsultancyFollowUp.create({
      consultancyId: alphaId,
      type: 'follow_up',
      status: 'Follow-up Required',
      scheduledAt: null,
      actorName: 'Intelligence Super',
      createdByAdminId: superAdmin._id,
    });
    const boundary = await CrmConsultancyFollowUp.create({
      consultancyId: alphaId,
      type: 'follow_up',
      status: 'Follow-up Required',
      scheduledAt: new Date('2026-04-02T18:30:00.000Z'),
      actorName: 'Intelligence Super',
      createdByAdminId: superAdmin._id,
    });
    await CrmConsultancyFollowUp.collection.updateOne(
      { _id: boundary._id },
      { $set: { createdAt: new Date('2026-04-01T00:00:00.000Z') } }
    );

    async function createUser(fullName, email, username) {
      const created = await request('POST', '/api/admin/crm-users', {
        token: superToken,
        body: { fullName, email, username, password: 'Password123', role: 'crm_manager' },
      });
      assert.equal(created.status, 201);
      return created.data.data.user.id;
    }
    const adminId = (await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: { fullName: 'History Admin', email: 'intel-admin@example.com', username: 'intel.admin', password: 'Password123', role: 'crm_administrator' },
    })).data.data.user.id;
    const managerId = await createUser('History Manager', 'intel-manager@example.com', 'intel.manager');
    const ashaId = await createUser('Asha Staff', 'asha-staff@example.com', 'asha.staff');
    const zaraId = await createUser('Zara Staff', 'zara-staff@example.com', 'zara.staff');
    const limitedId = await createUser('Limited Reader', 'limited-intel@example.com', 'limited.intel');
    await request('PATCH', `/api/admin/crm-users/${limitedId}`, { token: superToken, body: { permissions: ['crm.students.read'] } });
    for (const [userId, consultancy] of [[adminId, alphaId], [ashaId, alphaId], [zaraId, alphaId], [managerId, betaId]]) {
      assert.equal((await request('POST', `/api/admin/crm-users/${userId}/assignments`, { token: superToken, body: { consultancyId: consultancy } })).status, 201);
    }

    async function login(email) {
      const jar = {};
      const result = await request('POST', '/api/crm-auth/login', { jar, body: { identifier: email, password: 'Password123' } });
      return { status: result.status, jar, csrf: result.data.data && result.data.data.csrfToken };
    }
    const adminSession = await login('intel-admin@example.com');
    const managerSession = await login('intel-manager@example.com');
    const zaraSession = await login('zara-staff@example.com');
    const limitedSession = await login('limited-intel@example.com');
    assert.equal(adminSession.status, 200);

    const window = 'from=2020-01-01&to=2026-12-31&timeZone=Asia/Kolkata&page=1&limit=50';
    const denied = await request('GET', `/api/crm/intelligence/follow-ups?${window}`, { jar: limitedSession.jar });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'permission_denied');
    const unsupported = await request('GET', `/api/crm/intelligence/follow-ups?${window}&rank=1`, { jar: adminSession.jar });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.data.code, 'unsupported_filter');

    const adminFollow = await request('GET', `/api/crm/intelligence/follow-ups?${window}`, { jar: adminSession.jar });
    const again = await request('GET', `/api/crm/intelligence/follow-ups?${window}`, { jar: adminSession.jar });
    assert.equal(adminFollow.status, 200);
    assert.equal(adminFollow.data.data.timeZoneConfirmed, false);
    assert.equal(adminFollow.data.data.aggregateScope, 'module');
    assert.equal(adminFollow.data.data.scope, 'module');
    assert.equal(adminFollow.data.data.excluded.includes('working time'), true);
    assert.equal(adminFollow.data.data.excluded.includes('conversion'), true);
    assert.equal(adminFollow.data.data.current.overdue, 4);
    assert.equal(again.data.data.current.overdue, 4);
    assert.equal(adminFollow.data.data.current.unscheduled, 1);
    assert.equal(adminFollow.data.data.items.some((row) => row.consultancyName === 'Beta Intelligence'), true);
    assert.equal(adminFollow.data.data.items.some((row) => row.bucket === 'unscheduled'), false);
    assert.equal(JSON.stringify(adminFollow.data).includes(studentPhone), false);
    const managerFollow = await request('GET', `/api/crm/intelligence/follow-ups?${window}`, { jar: managerSession.jar });
    assert.equal(managerFollow.data.data.aggregateScope, 'assigned');
    assert.equal(managerFollow.data.data.current.overdue, 1);
    assert.equal(managerFollow.data.data.items.every((row) => row.consultancyName === 'Beta Intelligence'), true);

    const rate = await request('GET', '/api/crm/intelligence/follow-ups?from=2020-06-01&to=2020-06-02&timeZone=UTC&page=1&limit=20', { jar: adminSession.jar });
    assert.equal(rate.data.data.current.completion.denominator, 1);
    assert.equal(rate.data.data.current.completion.numerator, 0);
    assert.equal(rate.data.data.current.completion.rate, 0);
    const emptyRate = await request('GET', '/api/crm/intelligence/follow-ups?from=2019-01-01&to=2019-01-02&timeZone=UTC&page=1&limit=20', { jar: adminSession.jar });
    assert.equal(emptyRate.data.data.current.completion.rate, null);
    assert.equal(emptyRate.data.data.current.completion.denominator, 0);

    const firstComplete = await request('POST', `/api/crm/consultancies/${alphaId}/follow-ups/${overdue.data.data.followUp.id}/complete`, {
      jar: zaraSession.jar,
      csrf: zaraSession.csrf,
    });
    const secondComplete = await request('POST', `/api/crm/consultancies/${alphaId}/follow-ups/${overdue.data.data.followUp.id}/complete`, {
      jar: zaraSession.jar,
      csrf: zaraSession.csrf,
    });
    assert.equal(firstComplete.status, 200);
    assert.equal(secondComplete.status, 200);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'consultancy.follow_up_completed', 'after.followUpId': overdue.data.data.followUp.id }), 1);

    const workload = await request('GET', `/api/crm/intelligence/workload?${window}`, { jar: adminSession.jar });
    assert.equal(workload.status, 200);
    assert.equal(workload.data.data.ranked, false);
    const names = workload.data.data.items.map((row) => row.name);
    assert.deepEqual(names.slice().sort((left, right) => left.localeCompare(right)), names);
    const asha = workload.data.data.items.find((row) => row.userId === ashaId);
    const zara = workload.data.data.items.find((row) => row.userId === zaraId);
    assert.equal(asha.overdueFollowUps, zara.overdueFollowUps);
    assert.equal(zara.followUpsCompleted > asha.followUpsCompleted, true);
    assert.ok(names.indexOf('Asha Staff') < names.indexOf('Zara Staff'));
    const managerRow = workload.data.data.items.find((row) => row.userId === managerId);
    assert.equal(managerRow.overdueFollowUps, 1);
    assert.equal(asha.overdueFollowUps < managerRow.overdueFollowUps + asha.overdueFollowUps, true);

    const april3 = await request('GET', '/api/admin/crm/intelligence/day-end?date=2026-04-03&timeZone=Asia/Kolkata&page=1&limit=50', { token: superToken });
    const april2 = await request('GET', '/api/admin/crm/intelligence/day-end?date=2026-04-02&timeZone=Asia/Kolkata&page=1&limit=50', { token: superToken });
    assert.equal(april3.status, 200);
    assert.equal(april3.data.data.exactSnapshot, false);
    assert.equal(april3.data.data.summary.overdue.exact, false);
    assert.equal(april3.data.data.summary.overdue.count, 1);
    assert.equal(april2.data.data.summary.overdue.count, 0);
    assert.equal(april2.data.data.summary.overdue.exact, false);
    assert.equal(april3.data.data.summary.admissionChanges, 1);
    assert.equal(april2.data.data.summary.admissionChanges, 0);
    assert.equal(april3.data.data.items.some((row) => row.studentId === String(legacy._id)), false);
    const scopedDay = await request('GET', '/api/crm/intelligence/day-end?date=2026-04-03&timeZone=Asia/Kolkata&page=1&limit=50', { jar: managerSession.jar });
    assert.equal(scopedDay.data.data.summary.admissionChanges, 0);
    assert.equal(scopedDay.data.data.summary.overdue.count, 0);
    assert.equal(scopedDay.data.data.items.some((row) => row.studentId === studentId), false);
  });
});
