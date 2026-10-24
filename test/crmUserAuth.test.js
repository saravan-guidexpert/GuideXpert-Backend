'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-user-admin-test-secret';
process.env.CRM_BCRYPT_ROUNDS = '4';
process.env.CRM_LOGIN_MAX_IP = '50';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
const { validatePassword } = require('../services/crm/crmUserPassword');
const { CrmError } = require('../utils/crmError');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmPasswordReset = require('../models/CrmPasswordReset');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');
const CrmStudent = require('../models/CrmStudent');

let mongo;
let server;
let baseUrl;
let superToken;
let staffToken;
let phoneSerial = 6000000000;

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
  return lines.join('\n');
}

async function request(method, urlPath, { token, jar, csrf, body, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (jar && Object.keys(jar).length) {
    headers.Cookie = Object.entries(jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
  }
  if (csrf) headers['x-crm-csrf'] = csrf;
  if (origin) headers.Origin = origin;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  const cookieHeader = jar ? storeCookies(response, jar) : '';
  return { status: response.status, data, cookieHeader };
}

async function login(identifier, password, extra = {}) {
  const jar = {};
  const result = await request('POST', '/api/crm-auth/login', {
    jar,
    body: { identifier, password, remember: extra.remember === true },
  });
  return { ...result, jar, csrf: result.data.data && result.data.data.csrfToken };
}

test('CRM request permissions stay separate from the admin section key', () => {
  assert.equal(permissionForCrmRequest('POST', '/api/crm/students'), 'crm.students.create');
  assert.equal(permissionForCrmRequest('GET', '/api/crm/students?page=1'), 'crm.students.read');
  assert.equal(permissionForCrmRequest('POST', '/api/crm/referrals/507f1f77bcf86cd799439011/source-correction'), 'crm.referrals.correct_source');
  assert.equal(permissionForCrmRequest('GET', '/api/crm-auth/me'), null);
  assert.throws(() => validatePassword('short', []), (err) => err instanceof CrmError && err.code === 'weak_password');
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(__dirname, '../services/crm/crmAuthService.js'), 'utf8');
  assert.match(serverSource, /\/api\/crm-auth/);
  assert.match(serverSource, /\/api\/admin\/crm-users/);
  assert.match(serverSource, /requireAdminSection\(CRM_SECTION_KEY/);
  assert.equal(authSource.includes('ADMIN_JWT_SECRET'), false);
  assert.equal(authSource.includes('guidexpert_crm_demo_v1'), false);
});

describe('CRM user authentication and access management', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_user_auth_test' });
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
      username: 'crm-access-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const staff = await Admin.create({
      username: 'crm-access-staff',
      password: 'secret12',
      name: 'Staff',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm'],
    });
    superToken = signAdmin(superAdmin);
    staffToken = signAdmin(staff);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    resetLoginLimiterForTests();
    process.env.CRM_LOGIN_MAX_IP = '50';
    await Promise.all([
      CrmUser.deleteMany({}),
      CrmSession.deleteMany({}),
      CrmPasswordReset.deleteMany({}),
      CrmAuthAuditLog.deleteMany({}),
      CrmStudent.deleteMany({}),
    ]);
  });

  async function createAccount(overrides = {}) {
    const email = overrides.email || `user${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;
    const result = await request('POST', '/api/admin/crm-users', {
      token: overrides.token || superToken,
      body: {
        fullName: overrides.fullName || 'Asha Rao',
        email,
        username: overrides.username,
        password: overrides.password || 'Password123',
        role: overrides.role || 'crm_viewer',
        permissions: overrides.permissions,
        invite: overrides.invite,
        status: overrides.status,
      },
    });
    return { ...result, email, password: overrides.password || 'Password123' };
  }

  test('valid login sets an HttpOnly session and rejects a bad password', async () => {
    const created = await createAccount({ role: 'crm_manager' });
    assert.equal(created.status, 201);
    const signedIn = await login(created.email, created.password, { remember: true });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.data.data.user.email, created.email);
    assert.equal(signedIn.data.token, undefined);
    assert.equal(JSON.stringify(signedIn.data).includes('passwordHash'), false);
    assert.match(signedIn.cookieHeader, /gx_crm_session=/);
    assert.match(signedIn.cookieHeader, /HttpOnly/);
    assert.match(signedIn.cookieHeader, /Max-Age=/);
    const me = await request('GET', '/api/crm-auth/me', { jar: signedIn.jar });
    assert.equal(me.status, 200);
    assert.equal(me.data.data.user.role, 'crm_manager');
    const bad = await login(created.email, 'wrong-password-1');
    assert.equal(bad.status, 401);
    assert.equal(bad.data.code, 'invalid_credentials');
    const missing = await login('missing.person@example.com', 'Password123');
    assert.equal(missing.status, 401);
    assert.equal(missing.data.code, 'invalid_credentials');
    assert.equal(missing.data.message, bad.data.message);
  });

  test('inactive accounts and rate limits do not reveal a usable session', async () => {
    const created = await createAccount({ status: 'inactive' });
    const inactive = await login(created.email, created.password);
    assert.equal(inactive.status, 403);
    assert.equal(inactive.data.code, 'account_inactive');
    process.env.CRM_LOGIN_MAX_IP = '3';
    resetLoginLimiterForTests();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await login('nobody@example.com', 'Password123');
      assert.equal(result.status, 401);
    }
    const limited = await login('nobody@example.com', 'Password123');
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'rate_limited');
  });

  test('duplicate accounts and unauthorized admin creation are rejected', async () => {
    const adminCount = await Admin.countDocuments();
    const first = await createAccount({ email: 'dup@example.com', username: 'dup.user' });
    assert.equal(first.status, 201);
    const duplicate = await createAccount({ email: 'DUP@example.com' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_account');
    const staff = await createAccount({ token: staffToken, email: 'staff-made@example.com' });
    assert.equal(staff.status, 403);
    assert.equal(staff.data.code, 'section_forbidden');
    assert.equal(await Admin.countDocuments(), adminCount);
  });

  test('a manager cannot elevate privileges and a viewer cannot write', async () => {
    const manager = await createAccount({ role: 'crm_manager', email: 'manager@example.com' });
    const session = await login(manager.email, manager.password);
    const elevated = await request('POST', '/api/crm/users', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'New Admin', email: 'new-admin@example.com', password: 'Password123', role: 'crm_administrator' },
    });
    assert.equal(elevated.status, 403);
    assert.equal(elevated.data.code, 'permission_denied');
    const viewer = await createAccount({ role: 'crm_viewer', email: 'viewer@example.com' });
    const viewerSession = await login(viewer.email, viewer.password);
    const write = await request('POST', '/api/crm/students', {
      jar: viewerSession.jar,
      csrf: viewerSession.csrf,
      body: { fullName: 'Blocked Student', phone: nextPhone() },
    });
    assert.equal(write.status, 403);
    assert.equal(write.data.code, 'permission_denied');
    const correction = await request('POST', '/api/crm/referrals/507f1f77bcf86cd799439011/source-correction', {
      jar: viewerSession.jar,
      csrf: viewerSession.csrf,
      body: { consultancyId: '507f1f77bcf86cd799439012', reason: 'This reason is long enough.' },
    });
    assert.equal(correction.status, 403);
    const created = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Allowed Student', phone: nextPhone() },
    });
    assert.equal(created.status, 201);
    const audit = await CrmStudent.findOne({ fullName: 'Allowed Student' }).lean();
    const dataAudit = await mongoose.connection.collection('crmAuditLogs').findOne({ entityId: audit._id });
    assert.equal(String(dataAudit.actorCrmUserId), manager.data.data.user.id);
    assert.equal(dataAudit.actorAdminId, null);
  });

  test('permission changes apply on the next request and deactivation revokes the session', async () => {
    const account = await createAccount({ role: 'crm_viewer', email: 'promote@example.com' });
    const session = await login(account.email, account.password);
    const denied = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Before Promotion', phone: nextPhone() },
    });
    assert.equal(denied.status, 403);
    const promoted = await request('PATCH', `/api/admin/crm-users/${account.data.data.user.id}`, {
      token: superToken,
      body: { role: 'crm_manager' },
    });
    assert.equal(promoted.status, 200);
    const allowed = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'After Promotion', phone: nextPhone() },
    });
    assert.equal(allowed.status, 201);
    const deactivated = await request('POST', `/api/admin/crm-users/${account.data.data.user.id}/deactivate`, {
      token: superToken,
      body: { reason: 'Left the consultancy desk.' },
    });
    assert.equal(deactivated.status, 200);
    const again = await request('GET', '/api/crm-auth/me', { jar: session.jar });
    assert.equal(again.status, 401);
    assert.equal(again.data.code, 'session_revoked');
  });

  test('missing, invalid, expired, and logged-out sessions are rejected', async () => {
    const missing = await request('GET', '/api/crm/students?page=1&limit=5');
    assert.equal(missing.status, 401);
    assert.equal(missing.data.code, 'authentication_required');
    const account = await createAccount({ email: 'session@example.com' });
    const session = await login(account.email, account.password);
    const sessionToken = session.jar.gx_crm_session;
    const badCookie = await request('GET', '/api/crm-auth/me', { jar: { gx_crm_session: 'not-a-session' } });
    assert.equal(badCookie.status, 401);
    assert.equal(badCookie.data.code, 'invalid_token');
    await CrmSession.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request('GET', '/api/crm-auth/me', { jar: session.jar });
    assert.equal(expired.status, 401);
    assert.equal(expired.data.code, 'session_expired');
    await CrmSession.updateMany({}, { $set: { expiresAt: new Date(Date.now() + 60 * 60 * 1000), revokedAt: null } });
    const logout = await request('POST', '/api/crm-auth/logout', { jar: session.jar, csrf: session.csrf, body: {} });
    assert.equal(logout.status, 200);
    assert.equal(session.jar.gx_crm_session, undefined);
    const after = await request('GET', '/api/crm-auth/me', { jar: { gx_crm_session: sessionToken } });
    assert.equal(after.status, 401);
    assert.equal(after.data.code, 'session_revoked');
  });

  test('admin and CRM credentials are not interchangeable', async () => {
    const account = await createAccount({ role: 'crm_administrator', email: 'bridge@example.com' });
    const session = await login(account.email, account.password);
    const adminRoute = await request('GET', '/api/admin/crm/students?page=1&limit=5', { jar: session.jar });
    assert.equal(adminRoute.status, 401);
    const portal = await request('GET', '/api/crm/students?page=1&limit=5', { token: superToken });
    assert.equal(portal.status, 401);
    const evil = await request('POST', '/api/crm-auth/login', {
      origin: 'https://evil.example',
      body: { identifier: account.email, password: account.password },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.data.code, 'origin_forbidden');
  });

  test('password reset codes expire and work once', async () => {
    const account = await createAccount({ email: 'reset@example.com' });
    const issued = await request('POST', `/api/admin/crm-users/${account.data.data.user.id}/reset-password`, {
      token: superToken,
      body: { issueToken: true },
    });
    assert.equal(issued.status, 200);
    assert.equal(issued.data.data.delivery, 'admin_display');
    assert.equal(JSON.stringify(issued.data).toLowerCase().includes('passwordhash'), false);
    const token = issued.data.data.resetToken;
    const expired = await CrmPasswordReset.findOne({ userId: account.data.data.user.id });
    expired.expiresAt = new Date(Date.now() - 1000);
    await expired.save();
    const tooLate = await request('POST', '/api/crm-auth/reset-password', { body: { token, password: 'Changed1234' } });
    assert.equal(tooLate.status, 400);
    assert.equal(tooLate.data.code, 'reset_invalid');
    expired.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    expired.usedAt = null;
    await expired.save();
    const updated = await request('POST', '/api/crm-auth/reset-password', { body: { token, password: 'Changed1234' } });
    assert.equal(updated.status, 200);
    const second = await request('POST', '/api/crm-auth/reset-password', { body: { token, password: 'Changed5678' } });
    assert.equal(second.status, 400);
    assert.equal(second.data.code, 'reset_invalid');
    const oldPassword = await login(account.email, account.password);
    assert.equal(oldPassword.status, 401);
    const signedIn = await login(account.email, 'Changed1234');
    assert.equal(signedIn.status, 200);
  });

  test('account audit, filters, pagination, and the last privileged account are enforced', async () => {
    const first = await createAccount({ role: 'crm_administrator', fullName: 'Priya Nair', email: 'priya@example.com' });
    assert.equal(first.status, 201);
    const only = await request('POST', `/api/admin/crm-users/${first.data.data.user.id}/deactivate`, {
      token: superToken,
      body: { reason: 'Trying to remove the last administrator.' },
    });
    assert.equal(only.status, 409);
    assert.equal(only.data.code, 'last_privileged_account');
    const second = await createAccount({ role: 'crm_administrator', fullName: 'Kiran Das', email: 'kiran@example.com' });
    assert.equal(second.status, 201);
    await createAccount({ role: 'crm_viewer', fullName: 'Viewer One', email: 'view1@example.com' });
    const removed = await request('POST', `/api/admin/crm-users/${first.data.data.user.id}/deactivate`, {
      token: superToken,
      body: { reason: 'A second administrator remains.' },
    });
    assert.equal(removed.status, 200);
    const page = await request('GET', '/api/admin/crm-users?page=1&limit=2&role=crm_administrator', { token: superToken });
    assert.equal(page.status, 200);
    assert.equal(page.data.data.limit, 2);
    assert.equal(page.data.data.total, 2);
    assert.equal(page.data.data.items.length, 2);
    const search = await request('GET', '/api/admin/crm-users?page=1&limit=10&q=priya', { token: superToken });
    assert.equal(search.data.data.total, 1);
    assert.equal(search.data.data.items[0].email, 'priya@example.com');
    const inactive = await request('GET', '/api/admin/crm-users?page=1&limit=10&status=inactive', { token: superToken });
    assert.equal(inactive.data.data.items.every((item) => item.status === 'inactive'), true);
    const audit = await request('GET', `/api/admin/crm-users/${first.data.data.user.id}/audit?page=1&limit=10`, { token: superToken });
    assert.equal(audit.status, 200);
    assert.equal(audit.data.data.items.some((item) => item.action === 'crm_user.created'), true);
    assert.equal(JSON.stringify(audit.data).toLowerCase().includes('password'), false);
    const summary = await request('GET', '/api/admin/crm-users/summary', { token: superToken });
    assert.equal(summary.status, 200);
    assert.equal(summary.data.data.total, 3);
    assert.ok(summary.data.data.byRole.some((row) => row.role === 'crm_viewer' && row.count === 1));
  });

  test('existing admin CRM access and super-admin bypass still work', async () => {
    const created = await request('POST', '/api/admin/crm/consultancies', {
      token: staffToken,
      body: { name: 'North Bridge Desk', status: 'active' },
    });
    assert.equal(created.status, 201);
    const outsider = await Admin.create({
      username: `outsider-${Date.now()}`,
      password: 'secret12',
      name: 'Outsider',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    const denied = await request('GET', '/api/admin/crm/consultancies?page=1&limit=5', { token: signAdmin(outsider) });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'section_forbidden');
    const bypass = await request('GET', '/api/admin/crm/consultancies?page=1&limit=5', { token: superToken });
    assert.equal(bypass.status, 200);
    const csrf = await createAccount({ role: 'crm_manager', email: 'csrf@example.com' });
    const session = await login(csrf.email, csrf.password);
    const blocked = await request('POST', '/api/crm/students', {
      jar: session.jar,
      body: { fullName: 'No CSRF', phone: nextPhone() },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'csrf_failed');
  });
});
