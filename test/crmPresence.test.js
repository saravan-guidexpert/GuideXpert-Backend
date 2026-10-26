'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-presence-test-secret';
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
const { PRESENCE_ONLINE_MS } = require('../constants/crmPresence');
const { SESSION_MS } = require('../services/crm/crmCookies');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { resetHeartbeatLimiterForTests } = require('../services/crm/crmPresence');
const { setAuthAuditWriterForTests, resetAuthAuditWriterForTests } = require('../services/crm/crmAuthAudit');
const { setTransactionsEnabledForTests } = require('../utils/crmMutation');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');
const CrmAuditLog = require('../models/CrmAuditLog');

let mongo;
let server;
let baseUrl;
let superToken;
let staffToken;

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

function assertNoSecrets(payload, jar) {
  const text = JSON.stringify(payload);
  assert.equal(text.includes('tokenHash'), false);
  assert.equal(text.includes('csrfToken'), false);
  assert.equal(text.includes('passwordHash'), false);
  assert.equal(text.includes('gx_crm_session'), false);
  if (jar && jar.gx_crm_session) assert.equal(text.includes(jar.gx_crm_session), false);
}

describe('CRM session presence', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_presence_test' });
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
      username: 'presence-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const staff = await Admin.create({
      username: 'presence-staff',
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
    delete process.env.CRM_PRESENCE_HEARTBEAT_MAX;
    await Promise.all([
      CrmUser.deleteMany({}),
      CrmSession.deleteMany({}),
      CrmConsultancy.deleteMany({}),
      CrmConsultancyAssignment.deleteMany({}),
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
        permissions: overrides.permissions,
      },
    });
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

  async function heartbeat(session, body) {
    return request('POST', '/api/crm-auth/heartbeat', {
      jar: session.jar,
      csrf: session.csrf,
      body: body === undefined ? {} : body,
    });
  }

  test('heartbeats update only the caller and do not extend or disclose the session', async () => {
    const account = await createAccount({ email: 'beat@example.com', username: 'beat.user' });
    const other = await createAccount({ email: 'other-beat@example.com', username: 'other.beat' });
    assert.equal(account.status, 201);
    const session = await login(account.email);
    const otherSession = await login(other.email);
    assert.equal(session.status, 200);
    const stored = await CrmSession.findOne({ userId: account.data.data.user.id });
    const originalExpiry = stored.expiresAt.getTime();
    assert.ok(Math.abs(originalExpiry - (stored.createdAt.getTime() + SESSION_MS)) < 5000);
    const idle = await request('GET', '/api/crm-auth/presence?page=1&limit=10', { jar: session.jar });
    assert.equal(idle.data.data.state, 'idle');
    assert.equal(idle.data.data.lastSeenAt, null);

    const auditsBefore = await CrmAuthAuditLog.countDocuments({});
    const businessBefore = await CrmAuditLog.countDocuments({});
    const beat = await heartbeat(session);
    assert.equal(beat.status, 200);
    assert.equal(beat.data.data.state, 'online');
    assertNoSecrets(beat.data, session.jar);
    const afterBeat = await CrmSession.findById(stored._id).lean();
    assert.equal(afterBeat.expiresAt.getTime(), originalExpiry);
    assert.ok(afterBeat.lastSeenAt);
    assert.equal(await CrmAuthAuditLog.countDocuments({}), auditsBefore);
    assert.equal(await CrmAuditLog.countDocuments({}), businessBefore);

    const throttled = await heartbeat(session);
    assert.equal(throttled.status, 200);
    const afterThrottle = await CrmSession.findById(stored._id).lean();
    assert.equal(new Date(afterThrottle.lastSeenAt).getTime(), new Date(afterBeat.lastSeenAt).getTime());
    assert.equal(afterThrottle.expiresAt.getTime(), originalExpiry);
    await CrmSession.updateOne(
      { _id: stored._id },
      { $set: { lastSeenAt: new Date(Date.now() - 31000) } }
    );
    const rewritten = await heartbeat(session);
    assert.equal(rewritten.status, 200);
    const afterRewrite = await CrmSession.findById(stored._id).lean();
    assert.ok(new Date(afterRewrite.lastSeenAt).getTime() > Date.now() - 5000);

    const denied = await heartbeat(session, { userId: other.data.data.user.id });
    assert.equal(denied.status, 400);
    assert.equal(denied.data.code, 'invalid_body');
    const otherRow = await CrmSession.findOne({ userId: other.data.data.user.id }).lean();
    assert.equal(otherRow.lastSeenAt, null);
    const bySession = await heartbeat(session, { sessionId: String(otherRow._id) });
    assert.equal(bySession.status, 400);
    assert.equal((await CrmSession.findById(otherRow._id).lean()).lastSeenAt, null);

    const missing = await request('POST', '/api/crm-auth/heartbeat', { body: {} });
    assert.equal(missing.status, 401);
    assert.equal(missing.data.code, 'authentication_required');
    const invalid = await request('POST', '/api/crm-auth/heartbeat', {
      jar: { gx_crm_session: 'not-a-session' },
      csrf: session.csrf,
      body: {},
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.data.code, 'invalid_token');
    await CrmSession.updateOne({ _id: stored._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await heartbeat(session);
    assert.equal(expired.status, 401);
    assert.equal(expired.data.code, 'session_expired');
    await CrmSession.updateOne(
      { _id: stored._id },
      { $set: { expiresAt: new Date(originalExpiry), revokedAt: new Date() } }
    );
    const revoked = await heartbeat(session);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.data.code, 'session_revoked');
    assert.equal(session.jar.gx_crm_session ? true : false, true);

    process.env.CRM_PRESENCE_HEARTBEAT_MAX = '3';
    resetHeartbeatLimiterForTests();
    const fresh = await login(other.email);
    const freshRow = await CrmSession.findOne({ userId: other.data.data.user.id, revokedAt: null }).sort({ createdAt: -1 });
    const freshExpiry = freshRow.expiresAt.getTime();
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await heartbeat(fresh)).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal((await CrmSession.findById(freshRow._id).lean()).expiresAt.getTime(), freshExpiry);
    const still = await request('GET', '/api/crm-auth/me', { jar: fresh.jar });
    assert.equal(still.status, 200);
    assert.equal(otherSession.status, 200);
  });

  test('online, idle, and offline follow heartbeats across multiple sessions', async () => {
    const account = await createAccount({ email: 'state@example.com', username: 'state.user', role: 'crm_manager' });
    const first = await login(account.email);
    const second = await login(account.email);
    const userId = account.data.data.user.id;
    const rows = await CrmSession.find({ userId }).sort({ createdAt: 1 });
    assert.equal(rows.length, 2);
    await CrmSession.updateOne({ _id: rows[0]._id }, { $set: { lastSeenAt: new Date(Date.now() - 30 * 1000) } });
    await CrmSession.updateOne({ _id: rows[1]._id }, { $set: { lastSeenAt: new Date(Date.now() - PRESENCE_ONLINE_MS - 5000) } });
    const online = await request('GET', '/api/crm-auth/presence?page=1&limit=10', { jar: first.jar });
    assert.equal(online.data.data.state, 'online');
    assert.equal(online.data.data.sessions.total, 2);
    assert.equal(online.data.data.sessions.items.filter((item) => item.state === 'online').length, 1);
    assert.equal(online.data.data.sessions.items.filter((item) => item.state === 'idle').length, 1);
    assertNoSecrets(online.data, first.jar);

    await CrmSession.updateOne(
      { _id: rows[0]._id },
      { $set: { lastSeenAt: new Date(Date.now() - PRESENCE_ONLINE_MS - 1000) } }
    );
    const idle = await request('GET', '/api/crm-auth/presence?page=1&limit=10', { jar: second.jar });
    assert.equal(idle.data.data.state, 'idle');

    const signedOut = await request('POST', '/api/crm-auth/logout', { jar: first.jar, csrf: first.csrf });
    assert.equal(signedOut.status, 200);
    const afterLogout = await request('GET', '/api/admin/crm-users/presence?page=1&limit=10', { token: superToken });
    const listed = afterLogout.data.data.items.find((item) => item.userId === userId);
    assert.equal(listed.state, 'idle');
    const history = await request('GET', `/api/admin/crm-users/${userId}/sessions?page=1&limit=10`, { token: superToken });
    assert.equal(history.data.data.items.some((item) => item.endedReason === 'revoked'), true);
    assert.equal(history.data.data.user.state, 'idle');
    assertNoSecrets(history.data);

    const revoke = await request(
      'POST',
      `/api/admin/crm-users/${userId}/sessions/${rows[1]._id}/revoke`,
      { token: superToken }
    );
    assert.equal(revoke.status, 200);
    assert.equal(revoke.data.data.session.state, 'ended');
    const offline = await request('GET', '/api/admin/crm-users/presence?page=1&limit=10', { token: superToken });
    assert.equal(offline.data.data.items.find((item) => item.userId === userId).state, 'offline');
    const again = await heartbeat(second);
    assert.equal(again.status, 401);
    assert.equal((await CrmSession.findById(rows[1]._id).lean()).revokedAt != null, true);
  });

  test('revocation stays atomic and cannot be undone by a heartbeat', async () => {
    const account = await createAccount({ email: 'revoke@example.com', username: 'revoke.user' });
    const adminUser = await createAccount({
      role: 'crm_administrator',
      email: 'revoke-admin@example.com',
      username: 'revoke.admin',
    });
    const viewer = await createAccount({ email: 'revoke-viewer@example.com', username: 'revoke.viewer' });
    const session = await login(account.email);
    const adminSession = await login(adminUser.email);
    const viewerSession = await login(viewer.email);
    await heartbeat(session);
    const userId = account.data.data.user.id;
    const row = await CrmSession.findOne({ userId: account.data.data.user.id, revokedAt: null }).sort({ createdAt: -1 });
    const versionBefore = (await CrmUser.findById(userId).lean()).sessionVersion;

    setAuthAuditWriterForTests(async () => {
      throw new Error('forced auth audit failure');
    });
    const failed = await request('POST', `/api/admin/crm-users/${userId}/sessions/${row._id}/revoke`, { token: superToken });
    assert.equal(failed.status, 500);
    assert.equal((await CrmSession.findById(row._id).lean()).revokedAt, null);
    assert.equal((await CrmUser.findById(userId).lean()).sessionVersion, versionBefore);
    assert.equal(await CrmAuthAuditLog.countDocuments({ action: 'crm_session.revoked' }), 0);
    resetAuthAuditWriterForTests();

    setTransactionsEnabledForTests(false);
    const unavailable = await request('POST', `/api/admin/crm-users/${userId}/sessions/${row._id}/revoke`, { token: superToken });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.data.code, 'transaction_required');
    assert.equal((await CrmSession.findById(row._id).lean()).revokedAt, null);
    setTransactionsEnabledForTests(true);

    const viewerDenied = await request('POST', `/api/crm/users/${userId}/sessions/${row._id}/revoke`, {
      jar: viewerSession.jar,
      csrf: viewerSession.csrf,
    });
    assert.equal(viewerDenied.status, 403);
    assert.equal((await CrmSession.findById(row._id).lean()).revokedAt, null);
    const patched = await request('PATCH', `/api/crm/users/${userId}`, {
      jar: viewerSession.jar,
      csrf: viewerSession.csrf,
      body: { lastSeenAt: new Date().toISOString() },
    });
    assert.equal(patched.status, 403);

    const parallel = await Promise.all([
      heartbeat(session),
      request('POST', `/api/crm/users/${userId}/sessions/${row._id}/revoke`, {
        jar: adminSession.jar,
        csrf: adminSession.csrf,
      }),
    ]);
    assert.equal(parallel[1].status, 200);
    const stored = await CrmSession.findById(row._id).lean();
    assert.ok(stored.revokedAt);
    const follow = await heartbeat(session);
    assert.equal(follow.status, 401);
    assert.ok((await CrmSession.findById(row._id).lean()).revokedAt);
    const audit = await CrmAuthAuditLog.findOne({ action: 'crm_session.revoked', targetUserId: userId }).lean();
    assert.ok(audit);
    assert.equal(JSON.stringify(audit).includes('tokenHash'), false);
    assert.equal(audit.after.sessionId, String(row._id));
    const repeat = await request('POST', `/api/admin/crm-users/${userId}/sessions/${row._id}/revoke`, { token: superToken });
    assert.equal(repeat.status, 200);
    assert.equal(await CrmAuthAuditLog.countDocuments({ action: 'crm_session.revoked', targetUserId: userId }), 1);

    const replacement = await login(account.email);
    await heartbeat(replacement);
    const all = await request('POST', `/api/admin/crm-users/${userId}/sessions/revoke-all`, { token: superToken });
    assert.equal(all.status, 200);
    assert.equal(all.data.data.state, 'offline');
    assert.equal((await heartbeat(replacement)).status, 401);
    const allAudit = await CrmAuthAuditLog.findOne({ action: 'crm_session.revoked_all', targetUserId: userId }).lean();
    assert.ok(allAudit.after.revokedCount >= 1);

    const next = await login(account.email);
    await heartbeat(next);
    const deactivated = await request('POST', `/api/admin/crm-users/${userId}/deactivate`, { token: superToken });
    assert.equal(deactivated.status, 200);
    assert.equal((await heartbeat(next)).status, 401);
    const afterDeactivate = await request('GET', '/api/admin/crm-users/presence?page=1&limit=20', { token: superToken });
    assert.equal(afterDeactivate.data.data.items.find((item) => item.userId === userId).state, 'inactive');

    const passwordUser = await createAccount({ email: 'password-presence@example.com', username: 'password.presence' });
    const passwordSession = await login(passwordUser.email);
    await heartbeat(passwordSession);
    const reset = await request('POST', `/api/admin/crm-users/${passwordUser.data.data.user.id}/reset-password`, {
      token: superToken,
      body: { password: 'NewPassword123' },
    });
    assert.equal(reset.status, 200);
    assert.equal((await heartbeat(passwordSession)).status, 401);
    const hidden = await request(
      'GET',
      `/api/crm/users/${passwordUser.data.data.user.id}/sessions?page=1&limit=5`,
      { jar: viewerSession.jar }
    );
    assert.equal(hidden.status, 403);
  });

  test('presence reads stay permissioned and consultancy staff remain module-wide for business activity only', async () => {
    const alpha = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Alpha Presence House' },
    });
    const beta = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Beta Presence House' },
    });
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;
    const viewer = await createAccount({ email: 'scope-viewer@example.com', username: 'scope.viewer' });
    const manager = await createAccount({ role: 'crm_manager', email: 'scope-manager@example.com', username: 'scope.manager' });
    const administrator = await createAccount({
      role: 'crm_administrator',
      email: 'scope-admin@example.com',
      username: 'scope.admin',
    });
    const betaUser = await createAccount({ email: 'scope-beta@example.com', username: 'scope.beta' });
    await request('POST', `/api/admin/crm-users/${viewer.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: alphaId },
    });
    await request('POST', `/api/admin/crm-users/${administrator.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: alphaId },
    });
    await request('POST', `/api/admin/crm-users/${betaUser.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: betaId },
    });
    const viewerSession = await login(viewer.email);
    const managerSession = await login(manager.email);
    const adminSession = await login(administrator.email);
    await login(betaUser.email);

    const own = await request('GET', '/api/crm-auth/presence?page=1&limit=5', { jar: viewerSession.jar });
    assert.equal(own.status, 200);
    assert.equal(own.data.data.sessions.items.every((item) => item.current === true || item.current === false), true);
    assert.equal(own.data.data.sessions.total, 1);
    const viewerList = await request('GET', '/api/crm/users/presence?page=1&limit=10', { jar: viewerSession.jar });
    assert.equal(viewerList.status, 403);
    const managerList = await request('GET', `/api/crm/users/presence?page=1&limit=10&consultancyId=${betaId}`, {
      jar: managerSession.jar,
    });
    assert.equal(managerList.status, 403);
    const staffList = await request('GET', '/api/admin/crm-users/presence?page=1&limit=10', { token: staffToken });
    assert.equal(staffList.status, 403);
    assert.equal(staffList.data.code, 'section_forbidden');

    const scoped = await request('GET', `/api/crm/users/presence?page=1&limit=10&consultancyId=${betaId}`, {
      jar: adminSession.jar,
    });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.data.data.total, 1);
    assert.equal(scoped.data.data.items[0].userId, betaUser.data.data.user.id);
    assert.equal(scoped.data.data.items.some((item) => item.userId === viewer.data.data.user.id), false);
    const alphaScoped = await request('GET', `/api/crm/users/presence?page=1&limit=10&consultancyId=${alphaId}`, {
      jar: adminSession.jar,
    });
    assert.equal(alphaScoped.data.data.items.some((item) => item.userId === betaUser.data.data.user.id), false);
    const missingConsultancy = await request(
      'GET',
      `/api/crm/users/presence?page=1&limit=10&consultancyId=${new mongoose.Types.ObjectId()}`,
      { jar: adminSession.jar }
    );
    assert.equal(missingConsultancy.status, 404);

    const created = await request('POST', '/api/admin/crm-users', {
      token: superToken,
      body: {
        fullName: 'No Presence',
        email: 'no-presence@example.com',
        username: 'no.presence',
        password: 'Password123',
        role: 'crm_viewer',
        lastSeenAt: new Date().toISOString(),
      },
    });
    assert.equal(created.status, 400);
    assert.equal(created.data.code, 'invalid_body');

    const viewerActivity = await request('GET', '/api/crm/activity?page=1&limit=50', { jar: viewerSession.jar });
    assert.equal(JSON.stringify(viewerActivity.data).includes('Beta Presence House'), false);
    const staffActivity = await request('GET', '/api/admin/crm/activity?page=1&limit=50', { token: staffToken });
    assert.equal(staffActivity.status, 200);
    assert.equal(JSON.stringify(staffActivity.data).includes('Beta Presence House'), true);
    assert.equal(staffActivity.data.data.items.some((item) => item.action === 'crm_user.login_succeeded'), false);
    const betaEvent = staffActivity.data.data.items.find((item) => item.source === 'business' && item.consultancyId === betaId);
    assert.ok(betaEvent);
    const hiddenEvent = await request('GET', `/api/crm/activity/business/${betaEvent.id}`, { jar: viewerSession.jar });
    assert.equal(hiddenEvent.status, 404);
    assert.equal(hiddenEvent.data.code, 'not_found');
    const staffEvent = await request('GET', `/api/admin/crm/activity/business/${betaEvent.id}`, { token: staffToken });
    assert.equal(staffEvent.status, 200);
    const otherSessions = await request(
      'GET',
      `/api/crm/users/${betaUser.data.data.user.id}/sessions?page=1&limit=5`,
      { jar: viewerSession.jar }
    );
    assert.equal(otherSessions.status, 403);
    assert.equal(managerSession.status, 200);
  });
});
