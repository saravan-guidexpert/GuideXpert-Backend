'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-operations-test-secret';
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
const { ADMISSION_STATUSES, CRM_SECTION_KEY } = require('../constants/crm');
const { CRM_ACCESS_SECTION } = require('../constants/crmUsers');
const { previousBounds, resolveAnalyticsRange } = require('../utils/crmRange');
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
let phoneSerial = 8400000000;

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

function admissionTotal(rows) {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function statusCount(rows, status) {
  const found = rows.find((row) => row.status === status);
  assert.ok(found, `missing admission status ${status}`);
  return found.count;
}

function volumeTotal(volume) {
  return volume.points.reduce((sum, point) => sum + point.count, 0);
}

function pastWindow() {
  const now = new Date();
  const toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 40));
  const fromDate = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate() - 10));
  const from = fromDate.toISOString().slice(0, 10);
  const to = toDate.toISOString().slice(0, 10);
  const range = resolveAnalyticsRange({ period: 'custom', from, to, timeZone: 'UTC' }, now);
  const previous = previousBounds(range);
  return {
    from,
    to,
    range,
    previous,
    currentStamp: new Date(range.start.getTime() + (60 * 60 * 1000)),
    previousStamp: new Date(previous.start.getTime() + (60 * 60 * 1000)),
  };
}

describe('CRM operations and directory', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_operations_test' });
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
      username: 'operations-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const staff = await Admin.create({
      username: 'operations-staff',
      password: 'secret12',
      name: 'Staff',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm'],
    });
    superToken = signAdmin(superAdmin);
    staffToken = signAdmin(staff);
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

  async function createAccount(overrides = {}) {
    const email = overrides.email || `user${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;
    const result = await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: {
        fullName: overrides.fullName || 'Asha Rao',
        email,
        username: overrides.username,
        password: 'Password123',
        role: overrides.role || 'crm_viewer',
      },
    });
    assert.equal(result.status, 201);
    return { ...result, email, password: 'Password123' };
  }

  async function login(email, password = 'Password123') {
    const jar = {};
    const result = await request('POST', '/api/crm-auth/login', {
      jar,
      body: { identifier: email, password },
    });
    return { ...result, jar, csrf: result.data.data && result.data.data.csrfToken };
  }

  async function createConsultancy(name, status = 'active') {
    const result = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name, status },
    });
    assert.equal(result.status, 201);
    return result.data.data.consultancy;
  }

  async function createStudent(name, extra = {}) {
    const result = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: name, phone: nextPhone(), ...extra },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.data;
  }

  async function assign(userId, consultancyId) {
    return request('POST', `/api/admin/crm-users/${userId}/assignments`, {
      token: superToken,
      body: { consultancyId },
    });
  }

  function operationsPath(query) {
    const params = new URLSearchParams({ page: '1', limit: '20', ...query });
    return `/operations?${params.toString()}`;
  }

  test('empty datasets, invalid ranges, and the existing analytics contract', async () => {
    const empty = await request('GET', `/api/admin/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      token: superToken,
    });
    assert.equal(empty.status, 200);
    const body = empty.data.data;
    assert.equal(body.scope, 'module');
    assert.equal(body.current.consultancies.total, 0);
    assert.equal(body.current.consultancies.active, 0);
    assert.equal(body.current.consultancies.inactive, 0);
    assert.equal(body.current.students.withCurrentReferral, 0);
    assert.equal(body.current.students.withoutReferral, 0);
    assert.equal(body.current.students.total, 0);
    assert.equal(body.current.referrals.total, 0);
    assert.equal(body.current.admissionStatus.history, null);
    assert.equal(body.current.admissionStatus.population, 'all_non_deleted_students');
    assert.deepEqual(body.current.admissionStatus.rows.map((row) => row.status), [...ADMISSION_STATUSES]);
    assert.equal(admissionTotal(body.current.admissionStatus.rows), 0);
    assert.equal(body.period.newReferrals, 0);
    assert.equal(body.period.previousNewReferrals, null);
    assert.equal(body.consultancies.unassigned, 0);
    assert.equal(body.consultancies.total, 0);
    assert.equal(body.presence.online, 0);
    assert.equal(body.presence.idle, 0);
    assert.equal(body.presence.offline, 0);
    assert.equal(body.presence.activeAccounts, 0);
    assert.equal(body.presence.includesAddresses, false);
    assert.equal(JSON.stringify(body).includes('"pipelineStage"'), false);
    assert.equal(JSON.stringify(body).includes('"transitions"'), false);

    const reversed = await request(
      'GET',
      `/api/admin/crm${operationsPath({ period: 'custom', from: '2026-02-01', to: '2026-01-01', timeZone: 'UTC' })}`,
      { token: superToken }
    );
    assert.equal(reversed.status, 400);
    const unknownPeriod = await request('GET', `/api/admin/crm${operationsPath({ period: 'nope' })}`, {
      token: superToken,
    });
    assert.equal(unknownPeriod.status, 400);
    assert.equal(unknownPeriod.data.code, 'invalid_query');
    const flagged = await request('GET', `/api/admin/crm${operationsPath({ isSuperAdmin: 'true' })}`, {
      token: superToken,
    });
    assert.equal(flagged.status, 400);
    assert.equal(flagged.data.code, 'unsupported_filter');
    const stage = await request('GET', `/api/admin/crm${operationsPath({ pipelineStage: 'fresh' })}`, {
      token: superToken,
    });
    assert.equal(stage.status, 400);
    assert.equal(stage.data.code, 'unsupported_filter');
    const missingPage = await request('GET', '/api/admin/crm/operations?period=30', { token: superToken });
    assert.equal(missingPage.status, 400);

    const summary = await request('GET', '/api/admin/crm/activity/summary?outcome=denied', { token: superToken });
    assert.equal(summary.status, 400);
    assert.equal(summary.data.code, 'unsupported_filter');
    const paged = await request('GET', '/api/admin/crm/activity/summary?page=1', { token: superToken });
    assert.equal(paged.status, 400);
    assert.equal(paged.data.code, 'unsupported_filter');
    const huge = await request('GET', '/api/admin/crm/activity/summary?limit=50', { token: superToken });
    assert.equal(huge.status, 400);

    const directory = await request('GET', '/api/admin/crm-users/directory?presence=asleep&page=1&limit=10', {
      token: superToken,
    });
    assert.equal(directory.status, 400);
    assert.equal(directory.data.code, 'invalid_query');
    const directoryFlag = await request('GET', '/api/admin/crm-users/directory?isSuperAdmin=true&page=1&limit=10', {
      token: superToken,
    });
    assert.equal(directoryFlag.status, 400);
    assert.equal(directoryFlag.data.code, 'unsupported_filter');

    const analytics = await request('GET', '/api/admin/crm/analytics?period=all&timeZone=UTC', { token: superToken });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.data.data.referralsInPeriod, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(analytics.data.data, 'presence'), false);
    assert.equal(analytics.data.data.basis, 'current_admission_status');
  });

  test('directory, assignments, presence, and hand-checked operations totals', async () => {
    const window = pastWindow();
    assert.ok(window.currentStamp >= window.range.start && window.currentStamp <= window.range.end);
    assert.ok(window.previousStamp >= window.previous.start && window.previousStamp <= window.previous.end);
    assert.ok(window.previousStamp < window.range.start);

    const alpha = await createConsultancy('Alpha House');
    const beta = await createConsultancy('Beta House');
    const gamma = await createConsultancy('Gamma Quiet', 'inactive');
    const admitted = await createStudent('Admitted Alpha', {
      consultancyId: alpha.id,
      admissionStatus: 'Admitted',
      referredAt: window.currentStamp.toISOString(),
    });
    const earlier = await createStudent('Earlier Beta', {
      consultancyId: beta.id,
      admissionStatus: 'Contacted',
      referredAt: window.previousStamp.toISOString(),
    });
    const orphan = await createStudent('Orphan Student');
    await CrmStudent.updateOne({ _id: earlier.student.id }, { $unset: { admissionStatus: '' } });
    await CrmStudent.updateOne({ _id: orphan.student.id }, { $unset: { admissionStatus: '' } });

    const aaron = await createAccount({ fullName: 'Aaron Online', email: 'aaron@example.com', username: 'aaron.online' });
    const bianca = await createAccount({ fullName: 'Bianca Idle', email: 'bianca@example.com', username: 'bianca.idle' });
    const carmen = await createAccount({ fullName: 'Carmen Offline', email: 'carmen@example.com', username: 'carmen.offline' });
    const dana = await createAccount({
      fullName: 'Dana Admin',
      email: 'dana@example.com',
      username: 'dana.admin',
      role: 'crm_administrator',
    });
    const elena = await createAccount({ fullName: 'Elena Revoked', email: 'elena@example.com', username: 'elena.revoked' });
    const felix = await createAccount({ fullName: 'Felix Inactive', email: 'felix@example.com', username: 'felix.inactive' });
    const aaronId = aaron.data.data.user.id;
    const biancaId = bianca.data.data.user.id;
    const danaId = dana.data.data.user.id;
    const elenaId = elena.data.data.user.id;
    const felixId = felix.data.data.user.id;

    assert.equal((await assign(aaronId, alpha.id)).status, 201);
    assert.equal((await assign(biancaId, beta.id)).status, 201);
    assert.equal((await assign(danaId, alpha.id)).status, 201);
    const duplicate = await assign(aaronId, alpha.id);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_assignment');
    assert.equal(await CrmConsultancyAssignment.countDocuments({ consultancyId: alpha.id, revokedAt: null }), 2);

    const failed = await login(aaron.email, 'wrong-password');
    assert.equal(failed.status, 401);
    const first = await login(aaron.email);
    const second = await login(aaron.email);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const beat = await request('POST', '/api/crm-auth/heartbeat', {
      jar: second.jar,
      csrf: second.csrf,
      body: {},
    });
    assert.equal(beat.status, 200);
    await CrmSession.updateMany(
      { userId: aaronId, _id: { $ne: beat.data.data.sessionId } },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );
    const biancaSession = await login(bianca.email);
    assert.equal(biancaSession.status, 200);
    const danaSession = await login(dana.email);
    assert.equal(danaSession.status, 200);
    const elenaSession = await login(elena.email);
    assert.equal(elenaSession.status, 200);
    const elenaSessions = await request('GET', `/api/admin/crm-users/${elenaId}/sessions?page=1&limit=10`, {
      token: superToken,
    });
    assert.equal(elenaSessions.status, 200);
    const revoked = await request(
      'POST',
      `/api/admin/crm-users/${elenaId}/sessions/${elenaSessions.data.data.items[0].id}/revoke`,
      { token: superToken }
    );
    assert.equal(revoked.status, 200);
    const closed = await request('POST', `/api/admin/crm-users/${felixId}/deactivate`, {
      token: superToken,
      body: { reason: 'Closed for the operations fixture.' },
    });
    assert.equal(closed.status, 200);
    const inactiveLogin = await login(felix.email);
    assert.equal(inactiveLogin.status, 403);

    const storedAdmitted = await CrmStudent.findById(admitted.student.id).lean();
    const storedEarlier = await CrmStudent.findById(earlier.student.id).lean();
    const storedOrphan = await CrmStudent.findById(orphan.student.id).lean();
    assert.equal(storedAdmitted.admissionStatus, 'Admitted');
    assert.equal(storedEarlier.admissionStatus, undefined);
    assert.equal(storedOrphan.admissionStatus, undefined);
    const alphaReferral = await CrmReferral.findOne({ crmStudentId: admitted.student.id }).lean();
    const betaReferral = await CrmReferral.findOne({ crmStudentId: earlier.student.id }).lean();
    assert.equal(alphaReferral.referredAt.toISOString(), window.currentStamp.toISOString());
    assert.equal(betaReferral.referredAt.toISOString(), window.previousStamp.toISOString());
    assert.equal(String(alphaReferral.consultancyId), alpha.id);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: orphan.student.id }), 0);

    const customQuery = {
      period: 'custom',
      from: window.from,
      to: window.to,
      timeZone: 'UTC',
    };
    const custom = await request('GET', `/api/admin/crm${operationsPath(customQuery)}`, { token: superToken });
    assert.equal(custom.status, 200);
    const operations = custom.data.data;
    assert.equal(operations.scope, 'module');
    assert.equal(operations.current.meaning.includes('generatedAt'), true);
    assert.equal(operations.current.consultancies.total, 3);
    assert.equal(operations.current.consultancies.active, 2);
    assert.equal(operations.current.consultancies.inactive, 1);
    assert.equal(operations.current.students.withCurrentReferral, 2);
    assert.equal(operations.current.students.withoutReferral, 1);
    assert.equal(operations.current.students.total, 3);
    assert.equal(operations.current.referrals.total, 2);
    assert.equal(operations.current.admissionStatus.population, 'all_non_deleted_students');
    assert.equal(operations.current.admissionStatus.history, null);
    assert.equal(statusCount(operations.current.admissionStatus.rows, 'Admitted'), 1);
    assert.equal(statusCount(operations.current.admissionStatus.rows, 'Not started'), 2);
    assert.equal(statusCount(operations.current.admissionStatus.rows, 'Contacted'), 0);
    assert.equal(admissionTotal(operations.current.admissionStatus.rows), 3);
    assert.equal(operations.period.newReferrals, 1);
    assert.equal(operations.period.previousNewReferrals, 1);
    assert.equal(volumeTotal(operations.period.volume), 1);
    assert.equal(operations.consultancies.unassigned, 1);
    assert.equal(operations.consultancies.total, 3);
    assert.deepEqual(operations.consultancies.items.map((row) => row.name), ['Alpha House', 'Beta House', 'Gamma Quiet']);
    const alphaRow = operations.consultancies.items[0];
    const betaRow = operations.consultancies.items[1];
    const gammaRow = operations.consultancies.items[2];
    assert.equal(alphaRow.students, 1);
    assert.equal(alphaRow.referrals, 1);
    assert.equal(alphaRow.newReferrals, 1);
    assert.equal(alphaRow.previousNewReferrals, 0);
    assert.equal(alphaRow.activeAssignees, 2);
    assert.equal(betaRow.students, 1);
    assert.equal(betaRow.newReferrals, 0);
    assert.equal(betaRow.previousNewReferrals, 1);
    assert.equal(betaRow.activeAssignees, 1);
    assert.equal(gammaRow.students, 0);
    assert.equal(gammaRow.referrals, 0);
    assert.equal(gammaRow.newReferrals, 0);
    assert.equal(gammaRow.previousNewReferrals, 0);
    assert.equal(gammaRow.activeAssignees, 0);
    assert.equal(gammaRow.status, 'inactive');
    assert.equal(operations.security.accountEventsIncluded, true);
    assert.equal(operations.security.signInFailed, 0);
    assert.equal(operations.security.signInInactive, 0);
    assert.equal(operations.security.sessionRevocations, 0);
    assert.equal(operations.presence.online, 1);
    assert.equal(operations.presence.idle, 2);
    assert.equal(operations.presence.offline, 3);
    assert.equal(operations.presence.activeAccounts, 5);
    assert.equal(operations.presence.scope, 'all_crm_accounts');
    assert.equal(operations.presence.includesAddresses, false);
    assert.equal(
      operations.presence.online + operations.presence.idle + operations.presence.offline,
      6
    );
    assertNoSecrets(operations);
    assert.equal(JSON.stringify(operations).includes('"pipelineStage"'), false);

    const whole = await request('GET', `/api/admin/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      token: superToken,
    });
    assert.equal(whole.status, 200);
    assert.equal(whole.data.data.period.newReferrals, 2);
    assert.equal(whole.data.data.period.previousNewReferrals, null);
    assert.equal(volumeTotal(whole.data.data.period.volume), 2);
    assert.equal(whole.data.data.security.signInFailed, 1);
    assert.equal(whole.data.data.security.signInInactive, 1);
    assert.equal(whole.data.data.security.signInSucceeded, 5);
    assert.equal(whole.data.data.security.sessionRevocations, 1);
    assert.equal(whole.data.data.security.assignmentCreated, 3);
    assert.equal(whole.data.data.security.assignmentRevoked, 0);
    assert.equal(whole.data.data.presence.online, 1);
    assert.equal(whole.data.data.current.students.total, 3);

    const stillUnset = await CrmStudent.findById(earlier.student.id).lean();
    const orphanStillUnset = await CrmStudent.findById(orphan.student.id).lean();
    assert.equal(stillUnset.admissionStatus, undefined);
    assert.equal(orphanStillUnset.admissionStatus, undefined);

    const analytics = await request('GET', '/api/admin/crm/analytics?period=all&timeZone=UTC', { token: superToken });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.data.data.referralsInPeriod, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(analytics.data.data, 'presence'), false);
    assert.equal(admissionTotal(analytics.data.data.statusDistribution), 2);
    assert.equal(statusCount(analytics.data.data.statusDistribution, 'Admitted'), 1);
    assert.equal(statusCount(analytics.data.data.statusDistribution, 'Not started'), 1);

    const viewerOps = await request('GET', `/api/crm${operationsPath(customQuery)}`, { jar: second.jar });
    assert.equal(viewerOps.status, 200);
    assert.equal(viewerOps.data.data.scope, 'assigned');
    assert.equal(viewerOps.data.data.current.consultancies.total, 1);
    assert.equal(viewerOps.data.data.current.students.withCurrentReferral, 1);
    assert.equal(viewerOps.data.data.current.students.withoutReferral, null);
    assert.equal(viewerOps.data.data.current.students.total, 1);
    assert.equal(viewerOps.data.data.period.newReferrals, 1);
    assert.equal(viewerOps.data.data.period.previousNewReferrals, 0);
    assert.equal(admissionTotal(viewerOps.data.data.current.admissionStatus.rows), 1);
    assert.equal(statusCount(viewerOps.data.data.current.admissionStatus.rows, 'Admitted'), 1);
    assert.equal(viewerOps.data.data.consultancies.unassigned, null);
    assert.equal(viewerOps.data.data.consultancies.items.length, 1);
    assert.equal(viewerOps.data.data.consultancies.items[0].name, 'Alpha House');
    assert.equal(viewerOps.data.data.presence, null);
    assert.equal(viewerOps.data.data.security.signInFailed, null);
    assert.equal(viewerOps.data.data.security.signInInactive, null);
    assert.equal(viewerOps.data.data.security.sessionRevocations, null);
    assert.equal(viewerOps.data.data.security.accountEventsIncluded, false);
    const viewerText = JSON.stringify(viewerOps.data.data);
    assert.equal(viewerText.includes('Beta House'), false);
    assert.equal(viewerText.includes('Gamma Quiet'), false);
    assert.equal(viewerText.includes('Earlier Beta'), false);
    assert.equal(viewerText.includes('Orphan Student'), false);

    const foreign = await request('GET', `/api/crm${operationsPath({ ...customQuery, consultancyId: beta.id })}`, {
      jar: second.jar,
    });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.data.code, 'not_found');

    const danaOps = await request('GET', `/api/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      jar: danaSession.jar,
    });
    assert.equal(danaOps.status, 200);
    assert.equal(danaOps.data.data.scope, 'assigned');
    assert.equal(danaOps.data.data.current.students.total, 1);
    assert.equal(danaOps.data.data.consultancies.items.length, 1);
    assert.equal(danaOps.data.data.consultancies.unassigned, null);
    assert.equal(danaOps.data.data.presence.online, 1);
    assert.equal(danaOps.data.data.presence.idle, 2);
    assert.equal(danaOps.data.data.presence.offline, 3);
    assert.equal(danaOps.data.data.presence.scope, 'all_crm_accounts');
    assert.equal(danaOps.data.data.security.signInFailed, 1);
    assert.equal(danaOps.data.data.security.signInInactive, 1);
    assert.equal(danaOps.data.data.security.assignmentCreated, 2);
    assert.equal(JSON.stringify(danaOps.data.data).includes('Beta House'), false);

    const staffOps = await request('GET', `/api/admin/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      token: staffToken,
    });
    assert.equal(staffOps.status, 200);
    assert.equal(staffOps.data.data.scope, 'module');
    assert.equal(staffOps.data.data.current.students.total, 3);
    assert.equal(staffOps.data.data.current.consultancies.total, 3);
    assert.equal(staffOps.data.data.consultancies.unassigned, 1);
    assert.equal(staffOps.data.data.presence, null);
    assert.equal(staffOps.data.data.security.signInFailed, null);
    assert.equal(staffOps.data.data.security.signInSucceeded, null);
    assert.equal(staffOps.data.data.security.accountEventsIncluded, false);
    assert.equal(staffOps.data.data.security.assignmentCreated, 3);
    assert.equal(staffOps.data.data.consultancies.items.some((row) => row.name === 'Beta House'), true);

    const staffDirectory = await request('GET', '/api/admin/crm-users/directory?page=1&limit=10', { token: staffToken });
    assert.equal(staffDirectory.status, 403);
    const viewerDirectory = await request('GET', '/api/crm/users/directory?page=1&limit=10', { jar: second.jar });
    assert.equal(viewerDirectory.status, 403);

    const pages = [];
    for (let page = 1; page <= 6; page += 1) {
      const listed = await request('GET', `/api/admin/crm-users/directory?page=${page}&limit=1`, { token: superToken });
      assert.equal(listed.status, 200);
      assert.equal(listed.data.data.total, 6);
      assert.equal(listed.data.data.items.length, 1);
      assert.equal(listed.data.data.unassignedUsers, 3);
      pages.push(listed.data.data.items[0]);
    }
    assert.deepEqual(pages.map((row) => row.fullName), [
      'Aaron Online',
      'Bianca Idle',
      'Carmen Offline',
      'Dana Admin',
      'Elena Revoked',
      'Felix Inactive',
    ]);
    assert.equal(new Set(pages.map((row) => row.id)).size, 6);
    const aaronRow = pages[0];
    assert.equal(aaronRow.assignmentCount, 1);
    assert.equal(aaronRow.consultancies[0].name, 'Alpha House');
    assert.equal(aaronRow.presence.state, 'online');
    assert.equal(aaronRow.presence.activeSessions, 1);
    assert.equal(typeof aaronRow.lastActivityAt, 'string');
    assert.equal(typeof aaronRow.permissionSummary, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(aaronRow, 'permissions'), false);
    assert.equal(pages[1].presence.state, 'idle');
    assert.equal(pages[1].presence.activeSessions, 1);
    assert.equal(pages[4].presence.state, 'offline');
    assert.equal(pages[5].status, 'inactive');
    assert.equal(pages[5].presence.state, 'offline');
    assertNoSecrets(pages, second.jar);

    const online = await request('GET', '/api/admin/crm-users/directory?page=1&limit=10&presence=online', {
      token: superToken,
    });
    const idle = await request('GET', '/api/admin/crm-users/directory?page=1&limit=10&presence=idle', {
      token: superToken,
    });
    const offline = await request('GET', '/api/admin/crm-users/directory?page=1&limit=10&presence=offline', {
      token: superToken,
    });
    assert.equal(online.data.data.total, 1);
    assert.equal(online.data.data.items[0].id, aaronId);
    assert.equal(idle.data.data.total, 2);
    assert.equal(offline.data.data.total, 3);
    assert.equal(online.data.data.total, whole.data.data.presence.online);
    assert.equal(idle.data.data.total, whole.data.data.presence.idle);
    assert.equal(offline.data.data.total, whole.data.data.presence.offline);

    const unassignedPeople = await request(
      'GET',
      '/api/admin/crm-users/directory?page=1&limit=10&assignment=unassigned',
      { token: superToken }
    );
    assert.equal(unassignedPeople.data.data.total, 3);
    const alphaPeople = await request(
      'GET',
      `/api/admin/crm-users/directory?page=1&limit=10&consultancyId=${alpha.id}`,
      { token: superToken }
    );
    assert.equal(alphaPeople.data.data.total, 2);
    const missingConsultancy = await request(
      'GET',
      '/api/admin/crm-users/directory?page=1&limit=10&consultancyId=507f1f77bcf86cd799439011',
      { token: superToken }
    );
    assert.equal(missingConsultancy.status, 404);

    const aaronSessions = await CrmSession.find({ userId: aaronId }).lean();
    assert.equal(aaronSessions.length, 2);
    assert.equal(aaronSessions.filter((session) => session.expiresAt.getTime() <= Date.now() && !session.revokedAt).length, 1);
    const elenaStored = await CrmSession.find({ userId: elenaId }).lean();
    assert.equal(elenaStored.length, 1);
    assert.ok(elenaStored[0].revokedAt);
    assert.equal(await CrmSession.countDocuments({ userId: felixId }), 0);

    const overview = await request('GET', '/api/admin/crm/consultancies/overview?page=1&limit=10', {
      token: superToken,
    });
    assert.equal(overview.status, 200);
    assert.equal(overview.data.data.total, 3);
    assert.equal(overview.data.data.unassignedConsultancies, 1);
    assert.equal(overview.data.data.items.find((row) => row.name === 'Alpha House').activeAssignees, 2);
    const unassignedHouses = await request(
      'GET',
      '/api/admin/crm/consultancies/overview?page=1&limit=10&assignment=unassigned',
      { token: superToken }
    );
    assert.equal(unassignedHouses.data.data.total, 1);
    assert.equal(unassignedHouses.data.data.items[0].name, 'Gamma Quiet');
    assert.equal(unassignedHouses.data.data.items[0].activeAssignees, 0);
    const viewerOverview = await request(
      'GET',
      '/api/crm/consultancies/overview?page=1&limit=10&assignment=unassigned',
      { jar: second.jar }
    );
    assert.equal(viewerOverview.status, 200);
    assert.equal(viewerOverview.data.data.total, 0);
    assert.equal(viewerOverview.data.data.unassignedConsultancies, null);

    const pastSummary = await request(
      'GET',
      `/api/admin/crm/activity/summary?from=${window.from}&to=${window.to}`,
      { token: superToken }
    );
    assert.equal(pastSummary.status, 200);
    assert.equal(pastSummary.data.data.business.total, 0);
    assert.equal(pastSummary.data.data.security.signInFailed, 0);
    assert.equal(pastSummary.data.data.security.total, 0);

    const superSummary = await request('GET', '/api/admin/crm/activity/summary', { token: superToken });
    const failedFeed = await request(
      'GET',
      '/api/admin/crm/activity?page=1&limit=20&action=crm_user.login_failed',
      { token: superToken }
    );
    const inactiveFeed = await request(
      'GET',
      '/api/admin/crm/activity?page=1&limit=20&action=crm_user.login_inactive',
      { token: superToken }
    );
    const assignmentFeed = await request(
      'GET',
      '/api/admin/crm/activity?page=1&limit=20&action=crm_assignment.created',
      { token: superToken }
    );
    assert.equal(superSummary.data.data.accountEventsIncluded, true);
    assert.equal(superSummary.data.data.security.signInFailed, failedFeed.data.data.total);
    assert.equal(superSummary.data.data.security.signInInactive, inactiveFeed.data.data.total);
    assert.equal(superSummary.data.data.security.assignmentCreated, assignmentFeed.data.data.total);
    assert.equal(superSummary.data.data.security.signInFailed, 1);
    assert.equal(superSummary.data.data.security.sessionRevocations, 1);
    const actionSum = superSummary.data.data.security.byAction.reduce((sum, row) => sum + row.count, 0);
    assert.equal(actionSum, superSummary.data.data.security.total);

    const viewerSummary = await request('GET', '/api/crm/activity/summary', { jar: second.jar });
    const viewerFailed = await request(
      'GET',
      '/api/crm/activity?page=1&limit=20&action=crm_user.login_failed',
      { jar: second.jar }
    );
    assert.equal(viewerSummary.data.data.accountEventsIncluded, false);
    assert.equal(viewerSummary.data.data.security.signInFailed, null);
    assert.equal(viewerSummary.data.data.security.sessionRevocations, null);
    assert.equal(viewerFailed.data.data.total, 0);
    assert.equal(JSON.stringify(viewerSummary.data.data).includes('Beta House'), false);

    const danaFailed = await request(
      'GET',
      '/api/crm/activity?page=1&limit=20&action=crm_user.login_failed',
      { jar: danaSession.jar }
    );
    const danaAssignments = await request(
      'GET',
      '/api/crm/activity?page=1&limit=20&action=crm_assignment.created',
      { jar: danaSession.jar }
    );
    assert.equal(danaFailed.data.data.total, 1);
    assert.equal(danaAssignments.data.data.total, 2);
    assert.equal(danaOps.data.data.security.signInFailed, danaFailed.data.data.total);
    assert.equal(danaOps.data.data.security.assignmentCreated, danaAssignments.data.data.total);

    const staffSummary = await request('GET', '/api/admin/crm/activity/summary', { token: staffToken });
    const staffFailed = await request(
      'GET',
      '/api/admin/crm/activity?page=1&limit=20&action=crm_user.login_failed',
      { token: staffToken }
    );
    const staffBusiness = await request(
      'GET',
      `/api/admin/crm/activity?page=1&limit=20&consultancyId=${beta.id}&source=business`,
      { token: staffToken }
    );
    assert.equal(staffSummary.data.data.security.signInFailed, null);
    assert.equal(staffFailed.data.data.total, 0);
    assert.ok(staffBusiness.data.data.total > 0);
    assert.equal(staffSummary.data.data.security.assignmentCreated, 3);
  });

  test('referral counts follow the current consultancy after a source correction', async () => {
    const alpha = await createConsultancy('Origin House');
    const beta = await createConsultancy('Destination House');
    const student = await createStudent('Moving Student', {
      consultancyId: alpha.id,
      admissionStatus: 'Applied',
    });
    const userA = await createAccount({ fullName: 'Origin Viewer', email: 'origin@example.com', username: 'origin.viewer' });
    const userB = await createAccount({ fullName: 'Destination Viewer', email: 'destination@example.com', username: 'destination.viewer' });
    assert.equal((await assign(userA.data.data.user.id, alpha.id)).status, 201);
    assert.equal((await assign(userB.data.data.user.id, beta.id)).status, 201);
    const sessionA = await login(userA.email);
    const sessionB = await login(userB.email);
    const beforeA = await request('GET', `/api/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      jar: sessionA.jar,
    });
    const beforeB = await request('GET', `/api/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      jar: sessionB.jar,
    });
    assert.equal(beforeA.data.data.current.students.total, 1);
    assert.equal(beforeA.data.data.consultancies.items[0].students, 1);
    assert.equal(beforeB.data.data.current.students.total, 0);

    const corrected = await request(
      'POST',
      `/api/admin/crm/referrals/${student.referral.id}/source-correction`,
      {
        token: superToken,
        body: { consultancyId: beta.id, reason: 'The live source is now the destination house.' },
      }
    );
    assert.equal(corrected.status, 200);
    const stored = await CrmReferral.findById(student.referral.id).lean();
    assert.equal(String(stored.originalConsultancyId), alpha.id);
    assert.equal(String(stored.consultancyId), beta.id);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: student.student.id }), 1);

    const afterA = await request('GET', `/api/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      jar: sessionA.jar,
    });
    const afterB = await request('GET', `/api/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      jar: sessionB.jar,
    });
    const afterModule = await request('GET', `/api/admin/crm${operationsPath({ period: 'all', timeZone: 'UTC' })}`, {
      token: superToken,
    });
    assert.equal(afterA.data.data.current.students.total, 0);
    assert.equal(afterA.data.data.consultancies.items[0].students, 0);
    assert.equal(afterB.data.data.current.students.total, 1);
    assert.equal(afterB.data.data.consultancies.items[0].students, 1);
    assert.equal(afterModule.data.data.current.students.withCurrentReferral, 1);
    assert.equal(afterModule.data.data.current.admissionStatus.history, null);
    assert.equal(statusCount(afterModule.data.data.current.admissionStatus.rows, 'Applied'), 1);
    assert.equal(JSON.stringify(afterModule.data.data).includes('transitions'), false);
    const originRow = afterModule.data.data.consultancies.items.find((row) => row.name === 'Origin House');
    const destinationRow = afterModule.data.data.consultancies.items.find((row) => row.name === 'Destination House');
    assert.equal(originRow.students, 0);
    assert.equal(destinationRow.students, 1);
  });

  test('a platform admin token is not a CRM session and assignment writes require CSRF', async () => {
    const adminOperations = await request('GET', '/api/crm/operations?page=1&limit=5&period=30&timeZone=UTC', {
      token: superToken,
    });
    assert.equal(adminOperations.status, 401);
    assert.equal(adminOperations.data.code, 'authentication_required');
    const adminDirectory = await request('GET', '/api/crm/users/directory?page=1&limit=5', { token: superToken });
    assert.equal(adminDirectory.status, 401);

    const administrator = await createAccount({ role: 'crm_administrator', fullName: 'Portal Admin' });
    const session = await login(administrator.email);
    assert.equal(session.status, 200);
    const viewer = await createAccount({ role: 'crm_viewer', fullName: 'Portal Viewer' });
    const viewerSession = await login(viewer.email);
    const denied = await request('GET', '/api/crm/users/directory?page=1&limit=5', { jar: viewerSession.jar });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'permission_denied');
    const allowed = await request('GET', '/api/crm/users/directory?page=1&limit=5', { jar: session.jar });
    assert.equal(allowed.status, 200);

    const house = await createConsultancy('Portal House');
    const missingCsrf = await request('POST', `/api/crm/users/${viewer.data.data.user.id}/assignments`, {
      jar: session.jar,
      body: { consultancyId: house.id },
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.data.code, 'csrf_failed');
    const assigned = await request('POST', `/api/crm/users/${viewer.data.data.user.id}/assignments`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { consultancyId: house.id },
    });
    assert.equal(assigned.status, 201);
  });
});
