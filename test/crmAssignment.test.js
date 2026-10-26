'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-assignment-test-secret';
process.env.CRM_BCRYPT_ROUNDS = '4';
process.env.CRM_LOGIN_MAX_IP = '80';

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
const { CRM_ACCESS_SECTION } = require('../constants/crmUsers');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { resetAuthAuditWriterForTests, setAuthAuditWriterForTests } = require('../services/crm/crmAuthAudit');
const { setTransactionsEnabledForTests } = require('../utils/crmMutation');
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
let superToken;
let staffToken;
let phoneSerial = 8100000000;

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

describe('CRM consultancy assignment isolation', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_assignment_test' });
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
      username: 'assign-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const staff = await Admin.create({
      username: 'assign-staff',
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
    resetAuthAuditWriterForTests();
    setTransactionsEnabledForTests(true);
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
        password: overrides.password || 'Password123',
        role: overrides.role || 'crm_viewer',
        status: overrides.status,
      },
    });
    return { ...result, email, password: overrides.password || 'Password123' };
  }

  async function login(email, password) {
    const jar = {};
    const result = await request('POST', '/api/crm-auth/login', {
      jar,
      body: { identifier: email, password },
    });
    return { ...result, jar, csrf: result.data.data && result.data.data.csrfToken };
  }

  async function createConsultancy(name, status = 'active') {
    return request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name, status },
    });
  }

  async function createStudent(name, consultancyId) {
    return request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: name, phone: nextPhone(), consultancyId },
    });
  }

  async function assign(userId, consultancyId) {
    return request('POST', `/api/admin/crm-users/${userId}/assignments`, {
      token: superToken,
      body: { consultancyId },
    });
  }

  test('assigned users see only their consultancy data', async () => {
    const alpha = await createConsultancy('Alpha House');
    const beta = await createConsultancy('Beta House');
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
    const visible = await createStudent('Visible Student', alphaId);
    const second = await createStudent('Second Visible', alphaId);
    const hidden = await createStudent('Hidden Zebra Student', betaId);
    const userA = await createAccount({ role: 'crm_manager', email: 'a@example.com', username: 'user.a' });
    const userB = await createAccount({ role: 'crm_manager', email: 'b@example.com', username: 'user.b' });
    assert.equal((await assign(userA.data.data.user.id, alphaId)).status, 201);
    assert.equal((await assign(userB.data.data.user.id, betaId)).status, 201);
    const sessionA = await login(userA.email, userA.password);
    const sessionB = await login(userB.email, userB.password);

    const listA = await request('GET', '/api/crm/consultancies?page=1&limit=20', { jar: sessionA.jar });
    assert.equal(listA.status, 200);
    assert.equal(listA.data.data.total, 1);
    assert.equal(listA.data.data.items[0].id, alphaId);
    assert.equal(listA.data.data.items[0].studentCount, 2);
    const own = await request('GET', `/api/crm/consultancies/${alphaId}`, { jar: sessionA.jar });
    assert.equal(own.status, 200);
    const foreign = await request('GET', `/api/crm/consultancies/${betaId}`, { jar: sessionA.jar });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.data.code, 'not_found');
    const contacts = await request('GET', `/api/crm/consultancies/${alphaId}/contacts?page=1&limit=10`, { jar: sessionA.jar });
    assert.equal(contacts.data.data.total, 1);
    const hiddenContacts = await request('GET', `/api/crm/consultancies/${betaId}/contacts?page=1&limit=10`, { jar: sessionA.jar });
    assert.equal(hiddenContacts.status, 404);

    const students = await request('GET', '/api/crm/students?page=1&limit=1', { jar: sessionA.jar });
    assert.equal(students.data.data.total, 2);
    assert.equal(students.data.data.items.length, 1);
    assert.equal(students.data.data.items.some((row) => row.fullName === 'Hidden Zebra Student'), false);
    const search = await request('GET', '/api/crm/students?page=1&limit=20&q=Zebra', { jar: sessionA.jar });
    assert.equal(search.data.data.total, 0);
    const hiddenStudent = await request('GET', `/api/crm/students/${hidden.data.data.student.id}`, { jar: sessionA.jar });
    assert.equal(hiddenStudent.status, 404);
    const seenStudent = await request('GET', `/api/crm/students/${visible.data.data.student.id}`, { jar: sessionA.jar });
    assert.equal(seenStudent.status, 200);
    const hiddenReferral = await request('GET', `/api/crm/students/${hidden.data.data.student.id}/referral`, { jar: sessionA.jar });
    assert.equal(hiddenReferral.status, 404);
    const referrals = await request('GET', '/api/crm/referrals?page=1&limit=20', { jar: sessionA.jar });
    assert.equal(referrals.data.data.total, 2);
    assert.equal(referrals.data.data.items.every((row) => row.consultancyId === alphaId), true);
    const otherPage = await request('GET', `/api/crm/referrals?page=1&limit=20&consultancyId=${betaId}`, { jar: sessionA.jar });
    assert.equal(otherPage.data.data.total, 0);

    const analytics = await request('GET', '/api/crm/analytics?period=all&timeZone=UTC', { jar: sessionA.jar });
    assert.equal(analytics.data.data.referralsInPeriod, 2);
    assert.equal(analytics.data.data.activeConsultancies, 1);
    assert.equal(analytics.data.data.ranking.every((row) => row.id === alphaId), true);
    const calendar = await request('GET', '/api/crm/calendar?month=2026-10&timeZone=UTC&page=1&limit=20', { jar: sessionA.jar });
    assert.equal(calendar.data.data.total, 2);
    const audits = await request('GET', '/api/crm/audits?page=1&limit=50', { jar: sessionA.jar });
    assert.equal(JSON.stringify(audits.data).includes('Beta House'), false);
    assert.equal(JSON.stringify(audits.data).includes('Hidden Zebra Student'), false);

    const adminList = await request('GET', '/api/admin/crm/consultancies?page=1&limit=20', { token: superToken });
    assert.equal(adminList.data.data.total, 2);
    const staffList = await request('GET', '/api/admin/crm/students?page=1&limit=20', { token: staffToken });
    assert.equal(staffList.data.data.total, 3);
    const betaSession = await request('GET', `/api/crm/students/${hidden.data.data.student.id}`, { jar: sessionB.jar });
    assert.equal(betaSession.status, 200);
    assert.equal(second.status, 201);
  });

  test('unassigned users cannot change another consultancy and cannot manage assignments', async () => {
    const alpha = await createConsultancy('Mutable House');
    const beta = await createConsultancy('Locked House');
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;
    const hidden = await createStudent('Locked Student', betaId);
    const manager = await createAccount({ role: 'crm_manager', email: 'manager-scope@example.com' });
    const viewer = await createAccount({ role: 'crm_viewer', email: 'viewer-scope@example.com' });
    const adminUser = await createAccount({ role: 'crm_administrator', email: 'crm-admin-scope@example.com' });
    await assign(manager.data.data.user.id, alphaId);
    const session = await login(manager.email, manager.password);
    const viewerSession = await login(viewer.email, viewer.password);
    const adminSession = await login(adminUser.email, adminUser.password);

    const renamed = await request('PATCH', `/api/crm/consultancies/${betaId}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { name: 'Stolen House' },
    });
    assert.equal(renamed.status, 404);
    assert.equal((await CrmConsultancy.findById(betaId).lean()).name, 'Locked House');
    const contact = await request('POST', `/api/crm/consultancies/${betaId}/contacts`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { name: 'Intruder', phone: nextPhone() },
    });
    assert.equal(contact.status, 404);
    assert.equal(await CrmConsultancyContact.countDocuments({ consultancyId: betaId }), 0);
    const edited = await request('PATCH', `/api/crm/students/${hidden.data.data.student.id}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Rewritten Student' },
    });
    assert.equal(edited.status, 404);
    assert.equal((await CrmStudent.findById(hidden.data.data.student.id).lean()).fullName, 'Locked Student');
    const moved = await request('POST', `/api/crm/referrals/${hidden.data.data.referral.id}/source-correction`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { consultancyId: alphaId, reason: 'This correction is outside the assignment.' },
    });
    assert.equal(moved.status, 404);
    assert.equal(String((await CrmReferral.findById(hidden.data.data.referral.id).lean()).consultancyId), betaId);
    const phoneClash = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Copy Cat', phone: hidden.data.data.student.phone, consultancyId: alphaId },
    });
    assert.equal(phoneClash.status, 409);
    assert.equal(phoneClash.data.code, 'duplicate_student');
    assert.equal(JSON.stringify(phoneClash.data).includes('Locked Student'), false);
    assert.equal(JSON.stringify(phoneClash.data).includes(hidden.data.data.student.id), false);

    const own = await createStudent('Visible Student', alphaId);
    await CrmStudent.updateOne({ _id: hidden.data.data.student.id }, {
      $set: { email: 'locked@example.com', city: 'Locked City', notes: 'Locked private notes' },
    });
    const hiddenPhone = hidden.data.data.student.phone;
    const ownPhone = own.data.data.student.phone;
    const phoneUpdate = await request('PATCH', `/api/crm/students/${own.data.data.student.id}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { phone: hiddenPhone },
    });
    assert.equal(phoneUpdate.status, 409);
    assert.equal(phoneUpdate.data.code, 'duplicate_student');
    const leaked = JSON.stringify(phoneUpdate.data);
    assert.equal(leaked.includes('Locked Student'), false);
    assert.equal(leaked.includes(hidden.data.data.student.id), false);
    assert.equal(leaked.includes(hiddenPhone), false);
    assert.equal(leaked.includes('locked@example.com'), false);
    assert.equal(leaked.includes('Locked City'), false);
    assert.equal(leaked.includes('Locked private notes'), false);
    assert.equal((await CrmStudent.findById(own.data.data.student.id).lean()).phone, ownPhone);
    assert.equal((await CrmStudent.findById(hidden.data.data.student.id).lean()).phone, hiddenPhone);

    await CrmStudent.updateOne({ _id: hidden.data.data.student.id }, { $set: { deletedAt: new Date() } });
    const deletedUpdate = await request('PATCH', `/api/crm/students/${own.data.data.student.id}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { phone: hiddenPhone },
    });
    assert.equal(deletedUpdate.status, 409);
    assert.equal(deletedUpdate.data.code, 'duplicate_student');
    assert.equal(JSON.stringify(deletedUpdate.data).includes(hidden.data.data.student.id), false);
    assert.equal((await CrmStudent.findById(own.data.data.student.id).lean()).phone, ownPhone);

    const neighbour = await createStudent('Neighbour Student', alphaId);
    const visibleClash = await request('PATCH', `/api/crm/students/${own.data.data.student.id}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { phone: neighbour.data.data.student.phone },
    });
    assert.equal(visibleClash.status, 409);
    assert.equal(visibleClash.data.code, 'duplicate_student');
    assert.equal(visibleClash.data.data.student.fullName, 'Neighbour Student');
    assert.equal(visibleClash.data.data.student.id, neighbour.data.data.student.id);
    assert.equal((await CrmStudent.findById(own.data.data.student.id).lean()).phone, ownPhone);
    assert.equal((await CrmStudent.findById(neighbour.data.data.student.id).lean()).phone, neighbour.data.data.student.phone);

    const viewerAssign = await request('POST', `/api/crm/users/${viewer.data.data.user.id}/assignments`, {
      jar: viewerSession.jar,
      csrf: viewerSession.csrf,
      body: { consultancyId: betaId },
    });
    assert.equal(viewerAssign.status, 403);
    const managerAssign = await request('POST', `/api/crm/users/${manager.data.data.user.id}/assignments`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { consultancyId: betaId },
    });
    assert.equal(managerAssign.status, 403);
    const sneaky = await request('PATCH', `/api/crm/users/${manager.data.data.user.id}`, {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { consultancyId: betaId },
    });
    assert.equal(sneaky.status, 400);
    assert.equal(sneaky.data.code, 'invalid_body');
    assert.equal(await CrmConsultancyAssignment.countDocuments({ consultancyId: betaId, revokedAt: null }), 0);
    const staffAssign = await request('POST', `/api/admin/crm-users/${manager.data.data.user.id}/assignments`, {
      token: staffToken,
      body: { consultancyId: betaId },
    });
    assert.equal(staffAssign.status, 403);
    assert.equal(staffAssign.data.code, 'section_forbidden');

    const granted = await request('POST', `/api/crm/users/${viewer.data.data.user.id}/assignments`, {
      jar: adminSession.jar,
      csrf: adminSession.csrf,
      body: { consultancyId: alphaId },
    });
    assert.equal(granted.status, 201);
    const duplicate = await request('POST', `/api/admin/crm-users/${viewer.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId: alphaId },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_assignment');
    assert.equal(await CrmConsultancyAssignment.countDocuments({ crmUserId: viewer.data.data.user.id, revokedAt: null }), 1);
    const inactive = await createAccount({ role: 'crm_viewer', email: 'inactive-assign@example.com', status: 'inactive' });
    const blocked = await assign(inactive.data.data.user.id, alphaId);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'assignee_not_eligible');
    const assignees = await request('GET', `/api/admin/crm-users/by-consultancy/${alphaId}?page=1&limit=20`, { token: superToken });
    assert.equal(assignees.status, 200);
    assert.equal(assignees.data.data.total, 2);
    const managerAssignees = await request('GET', `/api/crm/users/by-consultancy/${alphaId}?page=1&limit=20`, {
      jar: session.jar,
      csrf: session.csrf,
    });
    assert.equal(managerAssignees.status, 403);
  });

  test('revocation and deactivation remove access on the next request', async () => {
    const house = await createConsultancy('Revocable House');
    const houseId = house.data.data.consultancy.id;
    const student = await createStudent('Revocable Student', houseId);
    const account = await createAccount({ role: 'crm_manager', email: 'revoke-me@example.com' });
    const created = await assign(account.data.data.user.id, houseId);
    assert.equal(created.data.data.assignment.crmUserId, account.data.data.user.id);
    const audit = await CrmAuthAuditLog.findOne({ action: 'crm_assignment.created', targetUserId: account.data.data.user.id }).lean();
    assert.ok(audit);
    assert.equal(audit.after.consultancyId, houseId);
    assert.equal(JSON.stringify(audit).toLowerCase().includes('password'), false);
    const session = await login(account.email, account.password);
    assert.equal((await request('GET', `/api/crm/students/${student.data.data.student.id}`, { jar: session.jar })).status, 200);

    const revoked = await request('DELETE', `/api/admin/crm-users/${account.data.data.user.id}/assignments/${houseId}`, {
      token: superToken,
    });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.data.data.assignment.revokedAt);
    assert.equal(await CrmConsultancyAssignment.countDocuments({ crmUserId: account.data.data.user.id, revokedAt: null }), 0);
    assert.equal(await CrmAuthAuditLog.countDocuments({ action: 'crm_assignment.revoked', targetUserId: account.data.data.user.id }), 1);
    const afterRevoke = await request('GET', `/api/crm/consultancies/${houseId}`, { jar: session.jar });
    assert.equal(afterRevoke.status, 404);
    const afterStudent = await request('GET', `/api/crm/students/${student.data.data.student.id}`, { jar: session.jar });
    assert.equal(afterStudent.status, 404);

    await assign(account.data.data.user.id, houseId);
    const deactivated = await request('POST', `/api/admin/crm-users/${account.data.data.user.id}/deactivate`, {
      token: superToken,
      body: { reason: 'Access must stop with the account.' },
    });
    assert.equal(deactivated.status, 200);
    const afterAccount = await request('GET', '/api/crm-auth/me', { jar: session.jar });
    assert.equal(afterAccount.status, 401);
    assert.equal(afterAccount.data.code, 'session_revoked');
  });

  test('access follows the current referral consultancy, not the original source', async () => {
    const alpha = await createConsultancy('Original House');
    const beta = await createConsultancy('Current House');
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;
    const student = await createStudent('Moving Student', alphaId);
    const userA = await createAccount({ role: 'crm_manager', email: 'origin@example.com' });
    const userB = await createAccount({ role: 'crm_manager', email: 'current@example.com' });
    await assign(userA.data.data.user.id, alphaId);
    await assign(userB.data.data.user.id, betaId);
    const sessionA = await login(userA.email, userA.password);
    const deniedTarget = await request('POST', `/api/crm/referrals/${student.data.data.referral.id}/source-correction`, {
      jar: sessionA.jar,
      csrf: sessionA.csrf,
      body: { consultancyId: betaId, reason: 'The assigned user cannot reach the other house.' },
    });
    assert.equal(deniedTarget.status, 404);
    const corrected = await request('POST', `/api/admin/crm/referrals/${student.data.data.referral.id}/source-correction`, {
      token: superToken,
      body: { consultancyId: betaId, reason: 'The live source is now the other house.' },
    });
    assert.equal(corrected.status, 200);
    const stored = await CrmReferral.findById(student.data.data.referral.id).lean();
    assert.equal(String(stored.originalConsultancyId), alphaId);
    assert.equal(String(stored.consultancyId), betaId);
    const sessionB = await login(userB.email, userB.password);
    assert.equal((await request('GET', `/api/crm/students/${student.data.data.student.id}`, { jar: sessionA.jar })).status, 404);
    assert.equal((await request('GET', `/api/crm/students/${student.data.data.student.id}`, { jar: sessionB.jar })).status, 200);
    const oldList = await request('GET', '/api/crm/referrals?page=1&limit=20', { jar: sessionA.jar });
    assert.equal(oldList.data.data.total, 0);
  });

  test('assignment writes roll back when the audit or transaction cannot commit', async () => {
    const house = await createConsultancy('Audited House');
    const houseId = house.data.data.consultancy.id;
    const account = await createAccount({ role: 'crm_viewer', email: 'audit-assign@example.com' });
    setAuthAuditWriterForTests(async () => {
      throw new Error('forced auth audit failure');
    });
    try {
      const failed = await assign(account.data.data.user.id, houseId);
      assert.equal(failed.status, 500);
      assert.equal(failed.data.success, false);
    } finally {
      resetAuthAuditWriterForTests();
    }
    assert.equal(await CrmConsultancyAssignment.countDocuments({ crmUserId: account.data.data.user.id }), 0);
    assert.equal(await CrmAuthAuditLog.countDocuments({ action: 'crm_assignment.created' }), 0);

    setTransactionsEnabledForTests(false);
    try {
      const blocked = await assign(account.data.data.user.id, houseId);
      assert.equal(blocked.status, 503);
      assert.equal(blocked.data.code, 'transaction_required');
    } finally {
      setTransactionsEnabledForTests(true);
    }
    assert.equal(await CrmConsultancyAssignment.countDocuments({ crmUserId: account.data.data.user.id }), 0);

    const creator = await createAccount({ role: 'crm_manager', email: 'creator@example.com' });
    const creatorSession = await login(creator.email, creator.password);
    const other = await createAccount({ role: 'crm_manager', email: 'other-creator@example.com' });
    const otherSession = await login(other.email, other.password);
    const created = await request('POST', '/api/crm/consultancies', {
      jar: creatorSession.jar,
      csrf: creatorSession.csrf,
      body: { name: 'Creator House' },
    });
    assert.equal(created.status, 201);
    const createdId = created.data.data.consultancy.id;
    assert.equal((await request('GET', `/api/crm/consultancies/${createdId}`, { jar: creatorSession.jar })).status, 200);
    assert.equal((await request('GET', `/api/crm/consultancies/${createdId}`, { jar: otherSession.jar })).status, 404);
    assert.equal(await CrmConsultancyAssignment.countDocuments({ consultancyId: createdId, crmUserId: creator.data.data.user.id, revokedAt: null }), 1);
    const assignmentAudit = await CrmAuthAuditLog.findOne({ action: 'crm_assignment.created', targetUserId: creator.data.data.user.id }).lean();
    assert.equal(assignmentAudit.after.consultancyId, createdId);

    const inactiveHouse = await createConsultancy('Quiet House', 'inactive');
    await assign(creator.data.data.user.id, inactiveHouse.data.data.consultancy.id);
    assert.equal((await request('GET', `/api/crm/consultancies/${inactiveHouse.data.data.consultancy.id}`, { jar: creatorSession.jar })).status, 200);
    const hiddenInactive = await request('POST', '/api/crm/students', {
      jar: otherSession.jar,
      csrf: otherSession.csrf,
      body: { fullName: 'Should Miss', phone: nextPhone(), consultancyId: inactiveHouse.data.data.consultancy.id },
    });
    assert.equal(hiddenInactive.status, 404);
    assert.equal(hiddenInactive.data.code, 'not_found');
  });

  test('a CRM user must create a student through an assigned consultancy', async () => {
    const house = await createConsultancy('Assigned House');
    const other = await createConsultancy('Someone Elses House');
    const houseId = house.data.data.consultancy.id;
    const manager = await createAccount({ role: 'crm_manager', email: 'create-scope@example.com' });
    await assign(manager.data.data.user.id, houseId);
    const session = await login(manager.email, manager.password);
    const before = await CrmStudent.countDocuments();

    const missing = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'No House', phone: nextPhone() },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, 'consultancy_required');

    const invalid = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Bad Id', phone: nextPhone(), consultancyId: 'not-an-id' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, 'invalid_id');

    const unassigned = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Wrong House', phone: nextPhone(), consultancyId: other.data.data.consultancy.id },
    });
    assert.equal(unassigned.status, 404);
    assert.equal(unassigned.data.code, 'not_found');
    assert.equal(await CrmStudent.countDocuments(), before);

    const quiet = await createConsultancy('Quiet Assigned House', 'inactive');
    assert.equal((await assign(manager.data.data.user.id, quiet.data.data.consultancy.id)).status, 201);
    const inactiveCreate = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Inactive House Student', phone: nextPhone(), consultancyId: quiet.data.data.consultancy.id },
    });
    assert.equal(inactiveCreate.status, 409);
    assert.equal(inactiveCreate.data.code, 'consultancy_not_eligible');
    assert.equal(await CrmStudent.countDocuments(), before);
    assert.equal(await CrmReferral.countDocuments({ consultancyId: quiet.data.data.consultancy.id }), 0);

    const created = await request('POST', '/api/crm/students', {
      jar: session.jar,
      csrf: session.csrf,
      body: { fullName: 'Placed Student', phone: nextPhone(), consultancyId: houseId },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.data.referral.consultancyId, houseId);
    const seen = await request('GET', `/api/crm/students/${created.data.data.student.id}`, { jar: session.jar });
    assert.equal(seen.status, 200);
    assert.equal(seen.data.data.student.fullName, 'Placed Student');

    const adminCreated = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Admin Only Student', phone: nextPhone() },
    });
    assert.equal(adminCreated.status, 201);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: adminCreated.data.data.student.id }), 0);
  });

  test('revoking a pair clears every active row when the unique index is absent', async () => {
    const house = await createConsultancy('Duplicate Seat');
    const houseId = house.data.data.consultancy.id;
    const account = await createAccount({ role: 'crm_manager', email: 'double-seat@example.com' });
    const userId = account.data.data.user.id;
    const other = await createConsultancy('Untouched Seat');
    const otherId = other.data.data.consultancy.id;
    const neighbour = await createAccount({ role: 'crm_manager', email: 'other-seat@example.com' });
    assert.equal((await assign(userId, houseId)).status, 201);
    assert.equal((await assign(neighbour.data.data.user.id, otherId)).status, 201);
    await CrmConsultancyAssignment.collection.dropIndex('consultancyId_1_crmUserId_1');
    try {
      const again = await assign(userId, houseId);
      assert.equal(again.status, 201);
      const activePair = { crmUserId: userId, consultancyId: houseId, revokedAt: null };
      assert.equal(await CrmConsultancyAssignment.countDocuments(activePair), 2);
      const session = await login(account.email, account.password);
      const revokeOnce = () => request('DELETE', `/api/admin/crm-users/${userId}/assignments/${houseId}`, {
        token: superToken,
      });
      const [left, right] = await Promise.all([revokeOnce(), revokeOnce()]);
      assert.ok([left.status, right.status].every((status) => status === 200 || status === 404));
      assert.ok([left, right].some((result) => result.status === 200));
      assert.equal(await CrmConsultancyAssignment.countDocuments(activePair), 0);
      assert.equal(await CrmConsultancyAssignment.countDocuments({
        crmUserId: neighbour.data.data.user.id,
        consultancyId: otherId,
        revokedAt: null,
      }), 1);
      const audits = await CrmAuthAuditLog.find({ action: 'crm_assignment.revoked', targetUserId: userId }).lean();
      assert.equal(audits.length, [left, right].filter((result) => result.status === 200).length);
      assert.ok(audits.length >= 1);
      assert.ok(audits.every((audit) => audit.after.revokedCount >= 1 && audit.after.status === 'revoked'));
      assert.equal(await CrmConsultancyAssignment.countDocuments({
        crmUserId: userId,
        consultancyId: houseId,
        revokedAt: { $ne: null },
      }), 2);
      assert.equal((await request('GET', `/api/crm/consultancies/${houseId}`, { jar: session.jar })).status, 404);
      const repeated = await revokeOnce();
      assert.equal(repeated.status, 404);
      assert.equal(repeated.data.code, 'not_found');
      assert.equal(await CrmConsultancyAssignment.countDocuments(activePair), 0);

      assert.equal((await assign(userId, houseId)).status, 201);
      assert.equal((await request('GET', `/api/crm/consultancies/${houseId}`, { jar: session.jar })).status, 200);
      assert.equal((await assign(userId, houseId)).status, 201);
      const beforeRollback = await CrmAuthAuditLog.countDocuments({ action: 'crm_assignment.revoked', targetUserId: userId });
      setAuthAuditWriterForTests(async () => {
        throw new Error('forced auth audit failure');
      });
      try {
        const rolled = await revokeOnce();
        assert.equal(rolled.status, 500);
      } finally {
        resetAuthAuditWriterForTests();
      }
      assert.equal(await CrmConsultancyAssignment.countDocuments(activePair), 2);
      assert.equal(await CrmAuthAuditLog.countDocuments({ action: 'crm_assignment.revoked', targetUserId: userId }), beforeRollback);
      assert.equal((await request('GET', `/api/crm/consultancies/${houseId}`, { jar: session.jar })).status, 200);
    } finally {
      resetAuthAuditWriterForTests();
      await CrmConsultancyAssignment.updateMany(
        { crmUserId: userId, consultancyId: houseId, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      );
      await CrmConsultancyAssignment.collection.createIndex(
        { consultancyId: 1, crmUserId: 1 },
        { name: 'consultancyId_1_crmUserId_1', unique: true, partialFilterExpression: { revokedAt: null } }
      );
    }
  });

  test('concurrent student creates do not reveal the out-of-scope phone winner', async () => {
    const alpha = await createConsultancy('Phone Race Alpha');
    const beta = await createConsultancy('Phone Race Beta');
    const alphaId = alpha.data.data.consultancy.id;
    const betaId = beta.data.data.consultancy.id;
    const userA = await createAccount({ role: 'crm_manager', email: 'phone-race-a@example.com' });
    const userB = await createAccount({ role: 'crm_manager', email: 'phone-race-b@example.com' });
    await assign(userA.data.data.user.id, alphaId);
    await assign(userB.data.data.user.id, betaId);
    const sessionA = await login(userA.email, userA.password);
    const sessionB = await login(userB.email, userB.password);
    const phone = nextPhone();
    const [left, right] = await Promise.all([
      request('POST', '/api/crm/students', {
        jar: sessionA.jar,
        csrf: sessionA.csrf,
        body: { fullName: 'Alpha Racer', phone, consultancyId: alphaId },
      }),
      request('POST', '/api/crm/students', {
        jar: sessionB.jar,
        csrf: sessionB.csrf,
        body: { fullName: 'Beta Racer', phone, consultancyId: betaId },
      }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [201, 409]);
    const won = [left, right].find((result) => result.status === 201);
    const lost = [left, right].find((result) => result.status === 409);
    assert.equal(lost.data.code, 'duplicate_student');
    assert.equal(lost.data.data, null);
    const hidden = JSON.stringify(lost.data);
    assert.equal(hidden.includes(won.data.data.student.fullName), false);
    assert.equal(hidden.includes(won.data.data.student.id), false);
    assert.equal(hidden.includes(phone), false);
    assert.equal(await CrmStudent.countDocuments({ phone }), 1);

    const own = await request('POST', '/api/crm/students', {
      jar: sessionA.jar,
      csrf: sessionA.csrf,
      body: { fullName: 'Alpha Second', phone: nextPhone(), consultancyId: alphaId },
    });
    assert.equal(own.status, 201);
    const collidingPhone = nextPhone();
    const [patched, created] = await Promise.all([
      request('PATCH', `/api/crm/students/${own.data.data.student.id}`, {
        jar: sessionA.jar,
        csrf: sessionA.csrf,
        body: { phone: collidingPhone },
      }),
      request('POST', '/api/crm/students', {
        jar: sessionB.jar,
        csrf: sessionB.csrf,
        body: { fullName: 'Beta Collision', phone: collidingPhone, consultancyId: betaId },
      }),
    ]);
    const responses = [patched, created];
    assert.equal(responses.filter((result) => result.status === 409).length >= 1, true);
    assert.equal(await CrmStudent.countDocuments({ phone: collidingPhone }), 1);
    const storedOwn = await CrmStudent.findById(own.data.data.student.id).lean();
    for (const result of responses.filter((item) => item.status === 409)) {
      const body = JSON.stringify(result.data);
      assert.equal(result.data.code, 'duplicate_student');
      assert.equal(result.data.data, null);
      assert.equal(body.includes('Beta Collision'), false);
      assert.equal(body.includes('Alpha Second'), false);
      assert.equal(body.includes(collidingPhone), false);
      assert.equal(body.includes(String(storedOwn._id)), false);
    }
    assert.equal(storedOwn.phone === own.data.data.student.phone || storedOwn.phone === collidingPhone, true);
  });

  test('the public demo store is not used as production authorization', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/crm/crmAssignmentService.js'), 'utf8');
    const access = fs.readFileSync(path.join(__dirname, '../services/crm/crmAccess.js'), 'utf8');
    assert.equal(source.includes('ownerId'), false);
    assert.equal(source.includes('guidexpert_crm_demo_v1'), false);
    assert.equal(access.includes('ownerId'), false);
    assert.equal(access.includes('guidexpert_crm_demo_v1'), false);
  });
});
