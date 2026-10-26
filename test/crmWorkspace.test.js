'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-workspace-test-secret';
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
const { adminCrmUserRoutes } = require('../routes/crmUserAdminRoutes');
const { CRM_SECTION_KEY } = require('../constants/crm');
const { CRM_ACCESS_SECTION, permissionForCrmRequest } = require('../constants/crmUsers');
const { resetLoginLimiterForTests } = require('../services/crm/crmLoginLimiter');
const { resetAuthAuditWriterForTests } = require('../services/crm/crmAuthAudit');
const { setTransactionsEnabledForTests } = require('../utils/crmMutation');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const Admin = require('../models/Admin');
const CrmUser = require('../models/CrmUser');
const CrmSession = require('../models/CrmSession');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyContact = require('../models/CrmConsultancyContact');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmConsultancyRemark = require('../models/CrmConsultancyRemark');
const CrmConsultancyFollowUp = require('../models/CrmConsultancyFollowUp');
const CrmStudent = require('../models/CrmStudent');
const CrmReferral = require('../models/CrmReferral');
const CrmAuditLog = require('../models/CrmAuditLog');
const CrmAuthAuditLog = require('../models/CrmAuthAuditLog');

let mongo;
let server;
let baseUrl;
let superToken;
let staffToken;
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

describe('CRM consultancy workspace persistence', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_workspace_test' });
    await syncCrmIndexes();
    const app = express();
    app.use(express.json());
    app.use('/api/crm-auth', crmAuthRoutes);
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
    const staff = await Admin.create({
      username: 'workspace-staff',
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
      CrmConsultancyRemark.deleteMany({}),
      CrmConsultancyFollowUp.deleteMany({}),
      CrmStudent.deleteMany({}),
      CrmReferral.deleteMany({}),
      CrmAuditLog.deleteMany({}),
      CrmAuthAuditLog.deleteMany({}),
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
        role: overrides.role || 'crm_manager',
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

  async function createConsultancy(name, extra = {}) {
    return request('POST', '/api/admin/crm/consultancies', {
      token: superToken,
      body: { name, status: 'active', ...extra },
    });
  }

  test('workspace routes keep the existing permission names', () => {
    const id = '507f1f77bcf86cd799439011';
    assert.equal(permissionForCrmRequest('GET', `/api/crm/consultancies/${id}/remarks`), 'crm.consultancies.read');
    assert.equal(permissionForCrmRequest('POST', `/api/crm/consultancies/${id}/remarks`), 'crm.consultancies.update');
    assert.equal(permissionForCrmRequest('PATCH', `/api/crm/consultancies/${id}/remarks/${id}`), 'crm.consultancies.update');
    assert.equal(permissionForCrmRequest('POST', `/api/crm/consultancies/${id}/follow-ups`), 'crm.consultancies.update');
    assert.equal(permissionForCrmRequest('POST', `/api/crm/consultancies/${id}/follow-ups/${id}/cancel`), 'crm.consultancies.update');
    assert.equal(permissionForCrmRequest('POST', `/api/crm/consultancies/${id}/owner`), 'crm.roles.manage');
    assert.equal(permissionForCrmRequest('DELETE', `/api/crm/consultancies/${id}/remarks/${id}`), null);
  });

  test('remarks, follow-ups, calling status, and pipeline persist for an assigned manager', async () => {
    const created = await createConsultancy('North Star', { followUpStatus: 'Fresh Lead', callingStatus: '' });
    assert.equal(created.status, 201);
    const consultancyId = created.data.data.consultancy.id;
    assert.equal(created.data.data.consultancy.followUpStatus, 'Fresh Lead');
    assert.equal(created.data.data.consultancy.pipelineStage, 'fresh');
    assert.equal(created.data.data.consultancy.ownerName, '');
    const manager = await createAccount({ role: 'crm_manager', email: 'manager@example.com', username: 'manager.one', fullName: 'Asha Rao' });
    const other = await createAccount({ role: 'crm_manager', email: 'other@example.com', username: 'manager.two', fullName: 'Other Desk' });
    const viewer = await createAccount({ role: 'crm_viewer', email: 'viewer@example.com', username: 'viewer.one' });
    assert.equal((await request('POST', `/api/admin/crm-users/${manager.data.data.user.id}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const session = await login(manager.email, manager.password);
    const outsider = await login(other.email, other.password);
    const reader = await login(viewer.email, viewer.password);
    const hidden = await createConsultancy('Hidden House');
    const hiddenId = hidden.data.data.consultancy.id;

    const denied = await request('POST', `/api/crm/consultancies/${consultancyId}/remarks`, {
      jar: reader.jar,
      csrf: reader.csrf,
      body: { text: 'Viewer note' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'permission_denied');
    const foreign = await request('POST', `/api/crm/consultancies/${hiddenId}/remarks`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: 'Should not land' },
    });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.data.code, 'not_found');
    assert.equal(await CrmConsultancyRemark.countDocuments({ consultancyId: hiddenId }), 0);

    const empty = await request('POST', `/api/crm/consultancies/${consultancyId}/remarks`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: '   ' },
    });
    assert.equal(empty.status, 400);
    const remark = await request('POST', `/api/crm/consultancies/${consultancyId}/remarks`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: 'Called the desk' },
    });
    assert.equal(remark.status, 201);
    assert.equal(remark.data.data.remark.authorName, 'Asha Rao');
    assert.equal(remark.data.data.remark.authorId, manager.data.data.user.id);
    const outsiderEdit = await request('PATCH', `/api/crm/consultancies/${consultancyId}/remarks/${remark.data.data.remark.id}`, {
      jar: outsider.jar,
      csrf: outsider.csrf,
      body: { text: 'Changed by someone else' },
    });
    assert.equal(outsiderEdit.status, 404);
    const forbiddenEdit = await request('PATCH', `/api/admin/crm/consultancies/${consultancyId}/remarks/${remark.data.data.remark.id}`, {
      token: superToken,
      body: { text: 'Admin is not the author' },
    });
    assert.equal(forbiddenEdit.status, 403);
    assert.equal(forbiddenEdit.data.code, 'remark_forbidden');
    const edited = await request('PATCH', `/api/crm/consultancies/${consultancyId}/remarks/${remark.data.data.remark.id}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { text: 'Called and left a message' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.data.remark.previousText, 'Called the desk');
    assert.equal(edited.data.data.remark.history.length, 1);
    const removed = await request('DELETE', `/api/crm/consultancies/${consultancyId}/remarks/${remark.data.data.remark.id}`, {
      jar: session.jar,
      csrf: session.csrf,
    });
    assert.equal(removed.status, 404);

    const past = await request('POST', `/api/crm/consultancies/${consultancyId}/follow-ups`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { followUpStatus: 'Meeting Scheduled', scheduledAt: '2020-01-01T00:00:00.000Z' },
    });
    assert.equal(past.status, 400);
    const missingDate = await request('POST', `/api/crm/consultancies/${consultancyId}/follow-ups`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { followUpStatus: 'Follow-up Required', nextAction: 'Call again' },
    });
    assert.equal(missingDate.status, 400);
    const badCalling = await request('POST', `/api/crm/consultancies/${consultancyId}/follow-ups`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { callingStatus: 'Not a status' },
    });
    assert.equal(badCalling.status, 400);
    const scheduled = await request('POST', `/api/crm/consultancies/${consultancyId}/follow-ups`, {
      jar: session.jar,
      csrf: session.csrf,
      body: {
        followUpStatus: 'Meeting Scheduled',
        callingStatus: 'Connected',
        scheduledAt: '2099-01-01T00:00:00.000Z',
        notes: 'Booked a meeting',
      },
    });
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.data.data.consultancy.followUpStatus, 'Meeting Scheduled');
    assert.equal(scheduled.data.data.consultancy.callingStatus, 'Connected');
    assert.equal(scheduled.data.data.consultancy.pipelineStage, 'contacted');
    assert.equal(scheduled.data.data.consultancy.ownerName, 'Asha Rao');
    assert.ok(scheduled.data.data.consultancy.lastContactAt);
    assert.equal(new Date(scheduled.data.data.consultancy.nextFollowUpAt).toISOString(), '2099-01-01T00:00:00.000Z');
    assert.equal(scheduled.data.data.followUp.type, 'call');
    const followUpId = scheduled.data.data.followUp.id;

    const moved = await request('PATCH', `/api/crm/consultancies/${consultancyId}/follow-ups/${followUpId}`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { scheduledAt: '2099-02-01T00:00:00.000Z', notes: 'Moved the meeting' },
    });
    assert.equal(moved.status, 200);
    assert.equal(new Date(moved.data.data.consultancy.nextFollowUpAt).toISOString(), '2099-02-01T00:00:00.000Z');
    const completed = await request('POST', `/api/crm/consultancies/${consultancyId}/follow-ups/${followUpId}/complete`, {
      jar: session.jar,
      csrf: session.csrf,
      body: {},
    });
    assert.equal(completed.status, 200);
    assert.ok(completed.data.data.followUp.completedAt);
    assert.equal(completed.data.data.consultancy.nextFollowUpAt, null);
    const cancelledAfter = await request('POST', `/api/crm/consultancies/${consultancyId}/follow-ups/${followUpId}/cancel`, {
      jar: session.jar,
      csrf: session.csrf,
      body: {},
    });
    assert.equal(cancelledAfter.status, 200);
    assert.ok(cancelledAfter.data.data.followUp.cancelledAt);

    const mismatch = await request('PATCH', `/api/admin/crm/consultancies/${consultancyId}`, {
      token: superToken,
      body: { followUpStatus: 'Fresh Lead', pipelineStage: 'onboarded' },
    });
    assert.equal(mismatch.status, 400);
    const coarse = await request('PATCH', `/api/admin/crm/consultancies/${consultancyId}`, {
      token: staffToken,
      body: { pipelineStage: 'meeting_done' },
    });
    assert.equal(coarse.status, 200);
    assert.equal(coarse.data.data.consultancy.pipelineStage, 'meeting_done');
    assert.equal(coarse.data.data.consultancy.followUpStatus, 'Meeting Completed');
    assert.equal(coarse.data.data.consultancy.status, 'active');

    const reloaded = await request('GET', `/api/crm/consultancies/${consultancyId}`, { jar: session.jar });
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.data.data.consultancy.followUpStatus, 'Meeting Completed');
    assert.equal(reloaded.data.data.consultancy.callingStatus, 'Connected');
    assert.equal(reloaded.data.data.consultancy.latestRemark.text, 'Booked a meeting');
    const remarks = await request('GET', `/api/crm/consultancies/${consultancyId}/remarks?page=1&limit=20`, { jar: session.jar });
    assert.equal(remarks.data.data.total, 2);
    const editedRow = remarks.data.data.items.find((row) => row.id === remark.data.data.remark.id);
    assert.equal(editedRow.text, 'Called and left a message');
    assert.equal(editedRow.previousText, 'Called the desk');
    const followUps = await request('GET', `/api/crm/consultancies/${consultancyId}/follow-ups?page=1&limit=20`, { jar: session.jar });
    assert.equal(followUps.data.data.total, 1);
    assert.ok(followUps.data.data.items[0].cancelledAt);
    const hiddenRemarks = await request('GET', `/api/crm/consultancies/${hiddenId}/remarks?page=1&limit=20`, { jar: session.jar });
    assert.equal(hiddenRemarks.status, 404);

    const audits = await request('GET', `/api/crm/audits?page=1&limit=50`, { jar: session.jar });
    const actions = audits.data.data.items.map((row) => row.action);
    assert.ok(actions.includes('consultancy.remark_added'));
    assert.ok(actions.includes('consultancy.remark_edited'));
    assert.ok(actions.includes('consultancy.follow_up'));
    assert.ok(actions.includes('consultancy.follow_up_completed'));
    assert.ok(actions.includes('consultancy.follow_up_cancelled'));
    assert.equal(JSON.stringify(audits.data).includes('Hidden House'), false);

    const duplicate = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Meera Iyer', phone: nextPhone(), consultancyId },
    });
    assert.equal(duplicate.status, 201);
    const again = await request('POST', '/api/admin/crm/students', {
      token: superToken,
      body: { fullName: 'Other', phone: duplicate.data.data.student.phone, consultancyId },
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'duplicate_student');
    const referralId = (await CrmReferral.findOne({ crmStudentId: duplicate.data.data.student.id }))._id;
    const immutable = await request('PATCH', `/api/admin/crm/referrals/${referralId}`, {
      token: superToken,
      body: { consultancyId: hiddenId },
    });
    assert.equal(immutable.status, 403);
    assert.equal(immutable.data.code, 'referral_source_immutable');
    const analytics = await request('GET', '/api/crm/analytics?period=all&timeZone=UTC', { jar: session.jar });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.data.data.referralsInPeriod, 1);
  });

  test('reassignment uses assignment history and does not invent a second owner', async () => {
    const created = await createConsultancy('Owner House');
    const consultancyId = created.data.data.consultancy.id;
    assert.equal(created.data.data.consultancy.createdByName, 'Super');
    const first = await createAccount({ role: 'crm_administrator', email: 'owner@example.com', username: 'owner.one', fullName: 'First Owner' });
    const second = await createAccount({ role: 'crm_manager', email: 'next@example.com', username: 'owner.two', fullName: 'Next Owner' });
    const third = await createAccount({ role: 'crm_manager', email: 'third@example.com', username: 'owner.three', fullName: 'Third Owner' });
    const firstId = first.data.data.user.id;
    const secondId = second.data.data.user.id;
    const thirdId = third.data.data.user.id;
    assert.equal((await request('POST', `/api/admin/crm-users/${firstId}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const session = await login(first.email, first.password);
    const staffDenied = await request('POST', `/api/admin/crm/consultancies/${consultancyId}/owner`, {
      token: staffToken,
      body: { ownerId: secondId },
    });
    assert.equal(staffDenied.status, 403);
    assert.equal(staffDenied.data.code, 'permission_denied');
    const same = await request('POST', `/api/crm/consultancies/${consultancyId}/owner`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { ownerId: firstId },
    });
    assert.equal(same.status, 200);
    assert.match(same.data.message, /already has that owner/);
    const moved = await request('POST', `/api/crm/consultancies/${consultancyId}/owner`, {
      jar: session.jar,
      csrf: session.csrf,
      body: { ownerId: secondId },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.data.consultancy.ownerId, secondId);
    assert.equal(moved.data.data.consultancy.ownerName, 'Next Owner');
    assert.equal(moved.data.data.consultancy.createdByName, 'Super');
    const rows = await CrmConsultancyAssignment.find({ consultancyId }).sort({ createdAt: 1 }).lean();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].revokedAt);
    assert.equal(String(rows[1].crmUserId), secondId);
    assert.equal(rows[1].revokedAt, null);
    assert.equal((await request('POST', `/api/admin/crm-users/${thirdId}/assignments`, {
      token: superToken,
      body: { consultancyId },
    })).status, 201);
    const ambiguous = await request('POST', `/api/admin/crm/consultancies/${consultancyId}/owner`, {
      token: superToken,
      body: { ownerId: firstId },
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.data.code, 'assignment_ambiguous');
    assert.equal(await CrmConsultancyAssignment.countDocuments({ consultancyId, revokedAt: null }), 2);
    const lost = await request('GET', `/api/crm/consultancies/${consultancyId}`, { jar: session.jar });
    assert.equal(lost.status, 404);
  });
});
