'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-activity-test-secret';
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
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyContact = require('../models/CrmConsultancyContact');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmStudent = require('../models/CrmStudent');
const CrmReferral = require('../models/CrmReferral');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');
const CrmAuditLog = require('../models/CrmAuditLog');

let mongo;
let server;
let baseUrl;
let superAdmin;
let superToken;
let staffToken;
let accessToken;
let phoneSerial = 8200000000;

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
  const data = await response.json();
  if (jar) storeCookies(response, jar);
  return { status: response.status, data };
}

async function collectActivity(auth, query = '') {
  const root = auth.token ? '/api/admin/crm/activity' : '/api/crm/activity';
  const items = [];
  let page = 1;
  let total = 0;
  let order = '';
  for (;;) {
    const suffix = query ? `&${query}` : '';
    const result = await request('GET', `${root}?page=${page}&limit=2${suffix}`, auth);
    assert.equal(result.status, 200);
    total = result.data.data.total;
    order = result.data.data.order;
    items.push(...result.data.data.items);
    if (items.length >= total || result.data.data.items.length === 0) break;
    page += 1;
    assert.ok(page < 30);
  }
  return { items, total, order };
}

describe('CRM activity timeline', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_activity_test' });
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
      username: 'activity-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const staff = await Admin.create({
      username: 'activity-staff',
      password: 'secret12',
      name: 'Staff',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm'],
    });
    const accessAdmin = await Admin.create({
      username: 'activity-access',
      password: 'secret12',
      name: 'Access',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm', 'crm-access-management'],
    });
    superToken = signAdmin(superAdmin);
    staffToken = signAdmin(staff);
    accessToken = signAdmin(accessAdmin);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    resetLoginLimiterForTests();
    await Promise.all([
      CrmUser.deleteMany({}),
      CrmSession.deleteMany({}),
      CrmConsultancy.deleteMany({}),
      CrmConsultancyContact.deleteMany({}),
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
        permissions: overrides.permissions,
        status: overrides.status,
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

  test('merges both sources in a stable order and rejects unsafe filters', async () => {
    assert.equal(permissionForCrmRequest('GET', '/api/crm/activity?page=1'), 'crm.audit.read');
    assert.equal(
      permissionForCrmRequest('GET', '/api/crm/activity/business/507f1f77bcf86cd799439011'),
      'crm.audit.read'
    );
    const stamp = new Date('2024-01-01T00:00:00.000Z');
    const newer = new Date('2024-06-01T00:00:00.000Z');
    const actor = { actorAdminId: superAdmin._id, entityType: 'consultancy', entityId: superAdmin._id };
    const older = await CrmAuditLog.create({ ...actor, action: 'order.probe', reason: 'older business' });
    const later = await CrmAuditLog.create({ ...actor, action: 'order.probe', reason: 'later business' });
    const security = await CrmAuthAuditLog.create({
      actorAdminId: superAdmin._id,
      targetUserId: superAdmin._id,
      action: 'order.probe',
      reason: 'security tie',
    });
    const fresh = await CrmAuditLog.create({ ...actor, action: 'order.probe', reason: 'newer business' });
    await CrmAuditLog.collection.updateMany(
      { _id: { $in: [older._id, later._id] } },
      { $set: { createdAt: stamp } }
    );
    await CrmAuthAuditLog.collection.updateOne({ _id: security._id }, { $set: { createdAt: stamp } });
    await CrmAuditLog.collection.updateOne({ _id: fresh._id }, { $set: { createdAt: newer } });

    const listed = await collectActivity({ token: superToken }, 'action=order.probe');
    assert.equal(listed.total, 4);
    assert.equal(listed.items.length, 4);
    assert.equal(listed.order, 'createdAt_desc,source_asc,id_desc');
    assert.deepEqual(listed.items.map((item) => item.id), [
      String(fresh._id),
      String(later._id),
      String(older._id),
      String(security._id),
    ]);
    assert.deepEqual(listed.items.map((item) => item.source), ['business', 'business', 'business', 'security']);
    assert.equal(new Set(listed.items.map((item) => `${item.source}:${item.id}`)).size, 4);
    const pageOne = await request('GET', '/api/admin/crm/activity?page=1&limit=1&action=order.probe', { token: superToken });
    const pageTwo = await request('GET', '/api/admin/crm/activity?page=2&limit=1&action=order.probe', { token: superToken });
    assert.equal(pageOne.data.data.total, 4);
    assert.equal(pageOne.data.data.items.length, 1);
    assert.equal(pageTwo.data.data.items[0].id, String(later._id));
    assert.notEqual(pageOne.data.data.items[0].id, pageTwo.data.data.items[0].id);

    const day = await request('GET', '/api/admin/crm/activity?page=1&limit=10&action=order.probe&from=2024-01-01&to=2024-01-01', {
      token: superToken,
    });
    assert.equal(day.data.data.total, 3);
    assert.equal(day.data.data.items.some((item) => item.id === String(fresh._id)), false);
    const typed = await request('GET', '/api/admin/crm/activity?page=1&limit=10&source=security&action=order.probe', {
      token: superToken,
    });
    assert.equal(typed.data.data.total, 1);
    assert.equal(typed.data.data.items[0].source, 'security');
    const found = await request('GET', '/api/admin/crm/activity?page=1&limit=10&q=security+tie', { token: superToken });
    assert.equal(found.data.data.total, 1);
    const literal = await request('GET', '/api/admin/crm/activity?page=1&limit=10&q=.*', { token: superToken });
    assert.equal(literal.status, 200);
    assert.equal(literal.data.data.total, 0);

    const invalid = [
      ['/api/admin/crm/activity?page=1&limit=10&from=2024-02-01&to=2024-01-01', 'invalid_query'],
      ['/api/admin/crm/activity?page=1&limit=10&from=not-a-date', 'invalid_query'],
      ['/api/admin/crm/activity?page=1&limit=10&source=demo', 'invalid_query'],
      ['/api/admin/crm/activity?page=1&limit=10&actorType=owner', 'invalid_query'],
      ['/api/admin/crm/activity?page=1&limit=10&outcome=failure', 'unsupported_filter'],
      ['/api/admin/crm/activity?page=1&limit=10&isSuperAdmin=true', 'unsupported_filter'],
      ['/api/admin/crm/activity?page=1&limit=101', 'invalid_query'],
      ['/api/admin/crm/activity?limit=10', 'invalid_query'],
      [`/api/admin/crm/activity?page=1&limit=10&source=security&entityId=${String(superAdmin._id)}`, 'unsupported_filter'],
    ];
    for (const [path, code] of invalid) {
      const result = await request('GET', path, { token: superToken });
      assert.equal(result.status, 400, path);
      assert.equal(result.data.code, code, path);
    }
  });

  test('shows recorded changes, redacts secrets, and hides ambiguous ownership from CRM users', async () => {
    const created = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Delta House' },
    });
    const consultancyId = created.data.data.consultancy.id;
    const renamed = await request('PATCH', `/api/admin/crm/consultancies/${consultancyId}`, {
      token: superToken,
      body: { name: 'Delta Updated' },
    });
    assert.equal(renamed.status, 200);
    const viewer = await createAccount({ role: 'crm_viewer', email: 'delta-viewer@example.com', username: 'delta.viewer' });
    assert.equal((await request('POST', `/api/admin/crm-users/${viewer.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const session = await login(viewer.email, viewer.password);
    const changes = await request(
      `GET`,
      `/api/crm/activity?page=1&limit=20&action=consultancy.updated&entityId=${consultancyId}`,
      { jar: session.jar }
    );
    assert.equal(changes.data.data.total, 1);
    const updated = changes.data.data.items[0];
    assert.equal(updated.source, 'business');
    assert.equal(updated.category, 'business');
    assert.equal(updated.outcome, null);
    assert.equal(updated.requestId, null);
    assert.equal(updated.consultancyId, consultancyId);
    const nameChange = updated.changes.find((change) => change.field === 'name');
    assert.equal(nameChange.before, 'Delta House');
    assert.equal(nameChange.after, 'Delta Updated');
    assert.equal(nameChange.beforeMissing, false);
    assert.equal(nameChange.afterMissing, false);

    const secret = await CrmAuditLog.create({
      actorAdminId: superAdmin._id,
      action: 'consultancy.updated',
      entityType: 'consultancy',
      entityId: consultancyId,
      reason: 'secret-marker',
      ip: '203.0.113.9',
      userAgent: 'SecretAgent/1',
      before: { name: 'Delta Updated', password: 'hunter2', resetToken: 'reset-plain', notes: null },
      after: { name: 'Delta Updated', passwordHash: 'hashed-secret', cookie: 'gx_crm_session', notes: null },
    });
    const absent = await CrmAuditLog.create({
      actorAdminId: superAdmin._id,
      action: 'consultancy.updated',
      entityType: 'consultancy',
      entityId: consultancyId,
      reason: 'absent-marker',
      before: { name: 'Delta Updated' },
      after: { name: 'Delta Updated', notes: null },
    });
    const ghost = await CrmAuditLog.create({
      actorAdminId: superAdmin._id,
      action: 'student.updated',
      entityType: 'crmStudent',
      entityId: new mongoose.Types.ObjectId(),
      before: { fullName: 'Unscoped Ghost' },
      after: { fullName: 'Unscoped Ghost' },
    });
    const permission = await CrmAuditLog.create({
      actorAdminId: superAdmin._id,
      action: 'crm_permission.updated',
      entityType: 'admin',
      entityId: superAdmin._id,
      before: { consultancyCrm: false },
      after: { consultancyCrm: true },
    });
    const ambiguous = await CrmAuthAuditLog.create({
      actorAdminId: superAdmin._id,
      targetUserId: viewer.data.data.user.id,
      action: 'crm_assignment.revoked',
      before: { consultancyId: String(new mongoose.Types.ObjectId()), status: 'active' },
      after: { consultancyId, status: 'revoked' },
    });

    const secretRead = await request('GET', `/api/crm/activity/business/${secret._id}`, { jar: session.jar });
    assert.equal(secretRead.status, 200);
    const secretBody = JSON.stringify(secretRead.data);
    assert.equal(secretBody.includes('hunter2'), false);
    assert.equal(secretBody.includes('reset-plain'), false);
    assert.equal(secretBody.includes('hashed-secret'), false);
    assert.equal(secretBody.includes('gx_crm_session'), false);
    assert.equal(secretBody.includes('203.0.113.9'), false);
    assert.equal(secretBody.includes('SecretAgent'), false);
    assert.equal(secretRead.data.data.event.before.notes, null);
    assert.equal(secretRead.data.data.event.before.password, undefined);
    const notesChange = (await request('GET', `/api/crm/activity/business/${absent._id}`, { jar: session.jar })).data.data.event.changes
      .find((change) => change.field === 'notes');
    assert.equal(notesChange.before, null);
    assert.equal(notesChange.beforeMissing, true);
    assert.equal(notesChange.after, null);
    assert.equal(notesChange.afterMissing, false);

    const hiddenGhost = await request('GET', `/api/crm/activity/business/${ghost._id}`, { jar: session.jar });
    assert.equal(hiddenGhost.status, 404);
    assert.equal(hiddenGhost.data.code, 'not_found');
    const hiddenPermission = await request('GET', `/api/crm/activity/business/${permission._id}`, { jar: session.jar });
    assert.equal(hiddenPermission.status, 404);
    const hiddenAssignment = await request('GET', `/api/crm/activity/security/${ambiguous._id}`, { jar: session.jar });
    assert.equal(hiddenAssignment.status, 404);
    const viewerFeed = await collectActivity({ jar: session.jar });
    assert.equal(JSON.stringify(viewerFeed.items).includes('Unscoped Ghost'), false);
    assert.equal(viewerFeed.items.some((item) => item.id === String(permission._id)), false);
    assert.equal(viewerFeed.items.some((item) => item.id === String(ambiguous._id)), false);

    const adminGhost = await request('GET', `/api/admin/crm/activity/business/${ghost._id}`, { token: superToken });
    assert.equal(adminGhost.status, 200);
    assert.equal(adminGhost.data.data.event.consultancyId, null);
    const adminPermission = await request('GET', `/api/admin/crm/activity/business/${permission._id}`, { token: superToken });
    assert.equal(adminPermission.data.data.event.category, 'permission');
    const adminAssignment = await request('GET', `/api/admin/crm/activity/security/${ambiguous._id}`, { token: superToken });
    assert.equal(adminAssignment.status, 200);
    assert.equal(adminAssignment.data.data.event.consultancyId, null);
    assert.equal(adminAssignment.data.data.event.category, 'assignment');
  });

  test('keeps consultancy activity inside the caller assignment and preserves admin access', async () => {
    const alpha = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Alpha Activity' },
    });
    const beta = await request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name: 'Beta Activity' },
    });
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;
    await request('POST', `/api/admin/crm/consultancies/${alphaId}/contacts`, {
      token: superToken,
      body: { name: 'Alpha Desk', phone: nextPhone() },
    });
    await request('POST', `/api/admin/crm/consultancies/${betaId}/contacts`, {
      token: superToken,
      body: { name: 'Beta Desk', phone: nextPhone() },
    });
    const visible = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Visible Activity Student', phone: nextPhone(), consultancyId: alphaId },
    });
    const hidden = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Hidden Activity Student', phone: nextPhone(), consultancyId: betaId },
    });
    const viewer = await createAccount({ role: 'crm_viewer', email: 'activity-a@example.com', username: 'activity.a' });
    const other = await createAccount({ role: 'crm_manager', email: 'activity-b@example.com', username: 'activity.b' });
    const administrator = await createAccount({
      role: 'crm_administrator',
      email: 'activity-admin@example.com',
      username: 'activity.admin',
    });
    const blocked = await createAccount({
      role: 'crm_viewer',
      email: 'activity-blocked@example.com',
      username: 'activity.blocked',
      permissions: ['crm.students.read'],
    });
    assert.equal(viewer.status, 201);
    assert.equal(blocked.status, 201);
    const assignViewer = await request('POST', `/api/admin/crm-users/${viewer.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: alphaId },
    });
    const assignOther = await request('POST', `/api/admin/crm-users/${other.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: betaId },
    });
    const assignAdmin = await request('POST', `/api/admin/crm-users/${administrator.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: alphaId },
    });
    assert.equal(assignViewer.status, 201);
    assert.equal(assignOther.status, 201);
    assert.equal(assignAdmin.status, 201);
    const sessionA = await login(viewer.email, viewer.password);
    const sessionB = await login(other.email, other.password);
    const sessionAdmin = await login(administrator.email, administrator.password);
    const sessionBlocked = await login(blocked.email, blocked.password);
    const failed = await request('POST', '/api/crm-auth/login', {
      body: { identifier: viewer.email, password: 'wrong-password' },
    });
    assert.equal(failed.status, 401);

    const feedA = await collectActivity({ jar: sessionA.jar });
    const serializedA = JSON.stringify(feedA.items);
    assert.equal(serializedA.includes('Beta Activity'), false);
    assert.equal(serializedA.includes('Hidden Activity Student'), false);
    assert.equal(serializedA.includes('Beta Desk'), false);
    assert.equal(feedA.items.some((item) => item.action === 'crm_user.login_succeeded'), false);
    assert.equal(feedA.items.some((item) => item.action === 'crm_user.login_failed'), false);
    assert.ok(feedA.items.some((item) => item.action === 'consultancy.created' && item.consultancyId === alphaId));
    assert.ok(feedA.items.some((item) => item.action === 'student.created' && item.consultancyId === null));
    assert.equal(feedA.items.length, feedA.total);
    const narrow = await request('GET', '/api/crm/activity?page=1&limit=1', { jar: sessionA.jar });
    assert.equal(narrow.data.data.items.length, 1);
    assert.equal(narrow.data.data.total, feedA.total);
    const foreignConsultancy = await request('GET', `/api/crm/activity?page=1&limit=10&consultancyId=${betaId}`, {
      jar: sessionA.jar,
    });
    assert.equal(foreignConsultancy.status, 404);
    assert.equal(foreignConsultancy.data.code, 'not_found');
    assert.equal(foreignConsultancy.data.data, null);
    const foreignActor = await request(
      'GET',
      `/api/crm/activity?page=1&limit=10&actorId=${other.data.data.user.id}`,
      { jar: sessionA.jar }
    );
    assert.equal(foreignActor.data.data.total, 0);
    const foreignEntity = await request(
      'GET',
      `/api/crm/activity?page=1&limit=10&entityId=${hidden.data.data.student.id}`,
      { jar: sessionA.jar }
    );
    assert.equal(foreignEntity.data.data.total, 0);
    const foreignSearch = await request('GET', '/api/crm/activity?page=1&limit=10&q=Hidden', { jar: sessionA.jar });
    assert.equal(foreignSearch.data.data.total, 0);

    const superFeed = await collectActivity({ token: superToken });
    const betaEvent = superFeed.items.find((item) => item.entityId === hidden.data.data.student.id);
    const denied = await request('GET', `/api/crm/activity/business/${betaEvent.id}`, { jar: sessionA.jar });
    assert.equal(denied.status, 404);
    assert.equal(denied.data.code, 'not_found');
    const missing = await request('GET', `/api/crm/activity/business/${new mongoose.Types.ObjectId()}`, { jar: sessionA.jar });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'not_found');

    const feedAdmin = await collectActivity({ jar: sessionAdmin.jar });
    assert.ok(feedAdmin.items.some((item) => item.action === 'crm_user.login_succeeded' && item.category === 'authentication'));
    assert.equal(feedAdmin.items.some((item) => item.consultancyId === betaId), false);
    assert.equal(JSON.stringify(feedAdmin.items).includes('Hidden Activity Student'), false);
    const staffFeed = await collectActivity({ token: staffToken });
    assert.equal(staffFeed.items.some((item) => item.action === 'crm_user.login_succeeded'), false);
    assert.equal(staffFeed.items.some((item) => item.action === 'crm_user.login_failed'), false);
    assert.ok(staffFeed.items.some((item) => item.consultancyId === betaId));
    const accessFeed = await collectActivity({ token: accessToken });
    assert.ok(accessFeed.items.some((item) => item.action === 'crm_user.login_failed' && item.actorId === null));
    assert.equal(accessFeed.items.find((item) => item.action === 'crm_user.login_failed').outcome, null);
    const actorFiltered = await request(
      'GET',
      `/api/admin/crm/activity?page=1&limit=20&actorId=${viewer.data.data.user.id}`,
      { token: accessToken }
    );
    assert.equal(actorFiltered.data.data.items.some((item) => item.action === 'crm_user.login_failed'), false);

    const businessCount = await CrmAuditLog.countDocuments({});
    const securityCount = await CrmAuthAuditLog.countDocuments({});
    assert.equal(superFeed.total, businessCount + securityCount);
    assert.equal(new Set(superFeed.items.map((item) => `${item.source}:${item.id}`)).size, superFeed.items.length);
    assert.ok(staffFeed.total < superFeed.total);
    assert.ok(feedA.total < superFeed.total);

    const corrected = await request('POST', `/api/admin/crm/referrals/${visible.data.data.referral.id}/source-correction`, {
      token: superToken,
      body: { consultancyId: betaId, reason: 'Move this referral to beta activity.' },
    });
    assert.equal(corrected.status, 200);
    const afterMove = await collectActivity({ jar: sessionA.jar });
    assert.equal(JSON.stringify(afterMove.items).includes('Visible Activity Student'), false);
    const movedEvent = await request(
      'GET',
      `/api/admin/crm/activity?page=1&limit=10&entityId=${visible.data.data.referral.id}`,
      { token: superToken }
    );
    assert.ok(movedEvent.data.data.total >= 1);
    const stillHidden = await request('GET', `/api/crm/activity/business/${movedEvent.data.data.items[0].id}`, {
      jar: sessionA.jar,
    });
    assert.equal(stillHidden.status, 404);
    const seenByBeta = await request('GET', `/api/crm/activity/business/${movedEvent.data.data.items[0].id}`, {
      jar: sessionB.jar,
    });
    assert.equal(seenByBeta.status, 200);

    const legacy = await request('GET', '/api/crm/audits?page=1&limit=10', { jar: sessionB.jar });
    assert.equal(legacy.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(legacy.data.data.items[0], 'source'), false);
    const blockedRead = await request('GET', '/api/crm/activity?page=1&limit=10', { jar: sessionBlocked.jar });
    assert.equal(blockedRead.status, 403);
    assert.equal(blockedRead.data.code, 'permission_denied');
    assert.equal(sessionB.status, 200);
  });
});
