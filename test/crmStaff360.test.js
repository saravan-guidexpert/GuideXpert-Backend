'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-staff360-test-secret';
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
const { CRM_SECTION_KEY, OPEN_FOLLOW_UP_STATUSES } = require('../constants/crm');
const { CRM_ACCESS_SECTION } = require('../constants/crmUsers');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { resetHeartbeatLimiterForTests } = require('../services/crm/crmPresence');
const { resetAuthAuditWriterForTests } = require('../services/crm/crmAuthAudit');
const { setTransactionsEnabledForTests } = require('../utils/crmMutation');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const { daySessionMetrics } = require('../services/crm/staff360Service');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmConsultancyFollowUp = require('../models/CrmConsultancyFollowUp');
const CrmStudent = require('../models/CrmStudent');
const CrmReferral = require('../models/CrmReferral');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');
const CrmAuditLog = require('../models/CrmAuditLog');

let mongo;
let server;
let baseUrl;
let superToken;
let phoneSerial = 8700000000;

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
  if (jar && jar.gx_crm_session) assert.equal(text.includes(jar.gx_crm_session), false);
}

describe('Staff 360 Intelligence', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_staff360_test' });
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
      username: 'staff360-super',
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
      CrmConsultancyFollowUp.deleteMany({}),
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

  test('session metrics merge overlaps, span midnight, and ignore heartbeat as work', () => {
    const dayStart = new Date('2026-03-10T00:00:00.000+05:30');
    const dayEnd = new Date('2026-03-10T23:59:59.999+05:30');
    const now = new Date('2026-03-10T18:00:00.000+05:30');
    const metrics = daySessionMetrics([
      {
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date('2026-03-09T22:00:00.000+05:30'),
        expiresAt: new Date('2026-03-11T22:00:00.000+05:30'),
        revokedAt: new Date('2026-03-10T02:00:00.000+05:30'),
        lastSeenAt: new Date('2026-03-10T01:59:00.000+05:30'),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date('2026-03-10T01:00:00.000+05:30'),
        expiresAt: new Date('2026-03-11T01:00:00.000+05:30'),
        revokedAt: new Date('2026-03-10T04:00:00.000+05:30'),
        lastSeenAt: new Date('2026-03-10T03:50:00.000+05:30'),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date('2026-03-10T10:00:00.000+05:30'),
        expiresAt: new Date('2026-03-11T10:00:00.000+05:30'),
        revokedAt: null,
        lastSeenAt: new Date('2026-03-10T12:00:00.000+05:30'),
      },
    ], dayStart, dayEnd, now);

    // First two overlap 01:00–02:00; merged morning span is 00:00–04:00 = 4h, plus open 10:00–18:00 = 8h → 12h
    assert.equal(metrics.totalObservedMs, 12 * 60 * 60 * 1000);
    assert.equal(metrics.intervalsMerged, 2);
    assert.equal(metrics.idleTimeAvailable, false);
    assert.equal(metrics.idleTime, null);
    assert.equal(metrics.openSessionCount, 1);
    assert.ok(metrics.sessions.every((row) => row.durationBasis === 'createdAt_to_revokedAt_or_expiresAt_or_now'));
  });

  test('staff 360 returns portfolio for administrator and forbids managers', async () => {
    const admin = await createAccount('Ada Admin', 'crm_administrator');
    const manager = await createAccount('Morgan Manager', 'crm_manager');
    const adminSession = await login(admin.email);

    const house = await request('POST', '/api/crm/consultancies', {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { name: 'Orbit Education', status: 'active' },
    });
    assert.equal(house.status, 201, JSON.stringify(house.data));
    const houseId = house.data.data.consultancy.id;

    const assigned = await request('POST', `/api/crm/users/${manager.id}/assignments`, {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { consultancyId: houseId },
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.data));

    const actorId = new mongoose.Types.ObjectId();
    const student = await CrmStudent.create({
      fullName: 'Ravi Student',
      phone: nextPhone(),
      admissionStatus: 'Applied',
      createdBy: actorId,
    });
    await CrmReferral.create({
      crmStudentId: student._id,
      consultancyId: houseId,
      originalConsultancyId: houseId,
      consultancyNameSnapshot: 'Orbit Education',
      originalConsultancyName: 'Orbit Education',
      referredAt: new Date(),
      createdBy: actorId,
    });
    await CrmConsultancyFollowUp.create({
      consultancyId: houseId,
      type: 'follow_up',
      status: OPEN_FOLLOW_UP_STATUSES[1],
      scheduledAt: new Date(Date.now() - 60 * 60 * 1000),
      notes: 'Call back',
      createdByCrmUserId: admin.id,
      actorName: 'Ada Admin',
    });
    await CrmAuditLog.create({
      actorCrmUserId: manager.id,
      action: 'student.updated',
      entityType: 'crmStudent',
      entityId: student._id,
      after: { admissionStatus: 'Applied' },
    });

    const today = new Date().toISOString().slice(0, 10);
    const view = await request(
      'GET',
      `/api/crm/intelligence/staff/${manager.id}?date=${today}&timeZone=Asia/Kolkata&from=${today}&to=${today}&consultancyPage=1&consultancyLimit=10&studentPage=1&studentLimit=10`,
      { jar: adminSession.jar }
    );
    assert.equal(view.status, 200, JSON.stringify(view.data));
    const body = view.data.data;
    assert.equal(body.profile.id, manager.id);
    assert.equal(body.profile.fullName, 'Morgan Manager');
    assert.equal(body.timeZoneConfirmed, false);
    assert.equal(body.summary.assignedConsultancies, 1);
    assert.equal(body.summary.assignedStudents, 1);
    assert.equal(body.summary.overdueFollowUps, 1);
    assert.equal(body.consultancies.items[0].name, 'Orbit Education');
    assert.equal(body.students.items[0].fullName, 'Ravi Student');
    assert.ok(body.day.sessions);
    assert.equal(body.day.sessions.idleTimeAvailable, false);
    assert.ok(Array.isArray(body.limitations));
    assertNoSecrets(body, adminSession.jar);

    const emptyStaff = await createAccount('Empty Em', 'crm_viewer');
    const emptyView = await request(
      'GET',
      `/api/crm/intelligence/staff/${emptyStaff.id}?date=${today}&timeZone=Asia/Kolkata&consultancyPage=1&consultancyLimit=5&studentPage=1&studentLimit=5`,
      { jar: adminSession.jar }
    );
    assert.equal(emptyView.status, 200, JSON.stringify(emptyView.data));
    assert.equal(emptyView.data.data.summary.assignedConsultancies, 0);
    assert.equal(emptyView.data.data.summary.assignedStudents, 0);
    assert.equal(emptyView.data.data.students.total, 0);

    const managerSession = await login(manager.email);
    const denied = await request(
      'GET',
      `/api/crm/intelligence/staff/${admin.id}?date=${today}&timeZone=Asia/Kolkata&consultancyPage=1&consultancyLimit=5&studentPage=1&studentLimit=5`,
      { jar: managerSession.jar }
    );
    assert.equal(denied.status, 403);

    const missing = await request(
      'GET',
      `/api/crm/intelligence/staff/${new mongoose.Types.ObjectId()}?date=${today}&timeZone=Asia/Kolkata&consultancyPage=1&consultancyLimit=5&studentPage=1&studentLimit=5`,
      { jar: adminSession.jar }
    );
    assert.equal(missing.status, 404);

    const badKey = await request(
      'GET',
      `/api/crm/intelligence/staff/${manager.id}?date=${today}&timeZone=Asia/Kolkata&consultancyPage=1&consultancyLimit=5&studentPage=1&studentLimit=5&rank=1`,
      { jar: adminSession.jar }
    );
    assert.equal(badKey.status, 400);
  });

  test('historical assignment does not inflate current portfolio', async () => {
    const admin = await createAccount('Dana Admin', 'crm_administrator');
    const staff = await createAccount('Past Person', 'crm_manager');
    const adminSession = await login(admin.email);
    const house = await request('POST', '/api/crm/consultancies', {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { name: 'Former Desk' },
    });
    const houseId = house.data.data.consultancy.id;
    const actorId = new mongoose.Types.ObjectId();
    await CrmConsultancyAssignment.create({
      crmUserId: staff.id,
      consultancyId: houseId,
      createdByAdminId: actorId,
      revokedAt: new Date(),
    });
    const student = await CrmStudent.create({ fullName: 'Old Link', phone: nextPhone(), createdBy: actorId });
    await CrmReferral.create({
      crmStudentId: student._id,
      consultancyId: houseId,
      originalConsultancyId: houseId,
      consultancyNameSnapshot: 'Former Desk',
      originalConsultancyName: 'Former Desk',
      referredAt: new Date(),
      createdBy: actorId,
    });

    const today = new Date().toISOString().slice(0, 10);
    const view = await request(
      'GET',
      `/api/crm/intelligence/staff/${staff.id}?date=${today}&timeZone=UTC&consultancyPage=1&consultancyLimit=10&studentPage=1&studentLimit=10`,
      { jar: adminSession.jar }
    );
    assert.equal(view.status, 200, JSON.stringify(view.data));
    assert.equal(view.data.data.summary.assignedConsultancies, 0);
    assert.equal(view.data.data.summary.assignedStudents, 0);
  });
});
