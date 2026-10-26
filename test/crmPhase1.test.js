'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-phase1-admin-test-secret';
process.env.COUNSELLOR_JWT_SECRET = 'crm-phase1-counsellor-test-secret';
process.env.BDA_JWT_SECRET = 'crm-phase1-bda-test-secret';

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
const { CRM_SECTION_KEY } = require('../constants/crm');
const crmRoutes = require('../routes/crmRoutes');
const studentRoutes = require('../routes/studentRoutes');
const { syncCrmIndexes, ensureCrmIndexes, assertSafeIndexTarget } = require('../scripts/syncCrmIndexes');
const { normalizeIndianMobile } = require('../utils/crmPhone');
const { CrmError } = require('../utils/crmError');
const { setAuditWriterForTests, resetAuditWriterForTests } = require('../services/crm/auditService');
const { setTransactionsEnabledForTests } = require('../utils/crmMutation');
const { updateAdmin, createAdmin, deleteAdmin } = require('../controllers/adminUserController');
const Admin = require('../models/Admin');
const Counsellor = require('../models/Counsellor');
const Student = require('../models/Student');
const CrmStudent = require('../models/CrmStudent');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyContact = require('../models/CrmConsultancyContact');
const CrmReferral = require('../models/CrmReferral');
const CrmAuditLog = require('../models/CrmAuditLog');

let mongo;
let server;
let baseUrl;
let staffToken;
let managerToken;
let superToken;
let outsiderToken;
let counsellorToken;
let bdaToken;
let superAdmin;

function signAdmin(admin) {
  return jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function api(method, urlPath, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function createConsultancy(token, name) {
  return api('POST', '/api/admin/crm/consultancies', {
    token,
    body: { name, notes: '', status: 'active' },
  });
}

describe('consultancy CRM phase 1', { timeout: 180000 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_phase1_test' });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) {
      throw new Error('CRM tests require a replica set so referral and permission transactions can commit.');
    }
    await syncCrmIndexes();

    const app = express();
    app.use(express.json());
    app.use('/api/counsellor/students', studentRoutes);
    app.use(
      '/api/admin/crm',
      requireAdmin,
      requireAdminSection(CRM_SECTION_KEY, 'Consultancy CRM access is required.'),
      crmRoutes
    );
    app.use((req, res) => {
      res.status(404).json({ success: false, message: 'Not found' });
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const staff = await Admin.create({
      username: 'crm-staff',
      password: 'secret12',
      name: 'CRM Staff',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm'],
    });
    const manager = await Admin.create({
      username: 'crm-manager',
      password: 'secret12',
      name: 'CRM Manager',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm', 'consultancy-crm-manager'],
    });
    superAdmin = await Admin.create({
      username: 'crm-super',
      password: 'secret12',
      name: 'Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    const outsider = await Admin.create({
      username: 'crm-outsider',
      password: 'secret12',
      name: 'Outsider',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    staffToken = signAdmin(staff);
    managerToken = signAdmin(manager);
    superToken = signAdmin(superAdmin);
    outsiderToken = signAdmin(outsider);
    counsellorToken = jwt.sign(
      { counsellorId: new mongoose.Types.ObjectId().toString() },
      process.env.COUNSELLOR_JWT_SECRET,
      { expiresIn: '1h' }
    );
    bdaToken = jwt.sign(
      { bdaId: new mongoose.Types.ObjectId().toString(), role: 'BDA' },
      process.env.BDA_JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    resetAuditWriterForTests();
    setTransactionsEnabledForTests(true);
    await Promise.all([
      CrmStudent.deleteMany({}),
      CrmConsultancy.deleteMany({}),
      CrmConsultancyContact.deleteMany({}),
      CrmReferral.deleteMany({}),
      CrmAuditLog.deleteMany({}),
    ]);
  });

  test('section access, super admin, and other credentials', async () => {
    const ok = await api('GET', '/api/admin/crm/consultancies?page=1&limit=20', { token: staffToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.success, true);

    const denied = await api('GET', '/api/admin/crm/students?page=1&limit=20', { token: outsiderToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'section_forbidden');

    const missing = await api('GET', '/api/admin/crm/students?page=1&limit=20');
    assert.equal(missing.status, 401);

    const superOk = await api('GET', '/api/admin/crm/consultancies?page=1&limit=20', { token: superToken });
    assert.equal(superOk.status, 200);

    const counsellor = await api('GET', '/api/admin/crm/students?page=1&limit=20', { token: counsellorToken });
    assert.equal(counsellor.status, 401);
    const bda = await api('POST', '/api/admin/crm/students', {
      token: bdaToken,
      body: { fullName: 'Nope', phone: '9876543210' },
    });
    assert.equal(bda.status, 401);
  });

  test('phone formats collapse to one student and invalid numbers are rejected', async () => {
    assert.equal(normalizeIndianMobile('+91 98765 43210'), '9876543210');
    assert.equal(normalizeIndianMobile('919876543210'), '9876543210');
    assert.equal(normalizeIndianMobile('98765-43210'), '9876543210');

    const created = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Asha Rao', phone: '+91 98765 43210', city: 'Hyderabad' },
    });
    assert.equal(created.status, 201);
    const id = created.data.data.student.id;

    for (const phone of ['919876543210', '9876543210', '98765-43210']) {
      const again = await api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: 'Someone Else', phone, city: 'Pune' },
      });
      assert.equal(again.status, 409);
      assert.equal(again.data.code, 'duplicate_student');
      assert.equal(again.data.data.student.id, id);
      assert.equal(again.data.data.student.fullName, 'Asha Rao');
    }
    assert.equal(await CrmStudent.countDocuments({}), 1);
    const stored = await CrmStudent.findById(id).lean();
    assert.equal(stored.fullName, 'Asha Rao');
    assert.equal(stored.city, 'Hyderabad');

    for (const phone of ['09876543210', '+1 9876543210', '1234567890', '98765', 'not-a-phone', '']) {
      const bad = await api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: 'Bad Number', phone },
      });
      assert.equal(bad.status, 400, phone || 'empty');
      assert.equal(bad.data.code, 'invalid_phone');
    }
    assert.equal(await CrmStudent.countDocuments({}), 1);
  });

  test('concurrent student creates cannot duplicate a phone', async () => {
    const [first, second] = await Promise.all([
      api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: 'Concurrent One', phone: '+91 9123456789' },
      }),
      api('POST', '/api/admin/crm/students', {
        token: managerToken,
        body: { fullName: 'Concurrent Two', phone: '919123456789' },
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(await CrmStudent.countDocuments({}), 1);
    const conflict = first.status === 409 ? first : second;
    assert.equal(conflict.data.code, 'duplicate_student');
  });

  test('a deleted student phone is not reused or restored', async () => {
    const created = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Deleted Student', phone: '9988776655' },
    });
    assert.equal(created.status, 201);
    const id = created.data.data.student.id;
    await CrmStudent.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    const again = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'New Person', phone: '+91 9988776655' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'deleted_student_phone');
    assert.equal(again.data.data.studentId, id);
    assert.equal(again.data.data.student, undefined);
    const stored = await CrmStudent.findById(id).lean();
    assert.ok(stored.deletedAt);
    assert.equal(stored.fullName, 'Deleted Student');
    assert.equal(await CrmStudent.countDocuments({}), 1);
  });

  test('profile updates ignore protected fields', async () => {
    const created = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Meera Iyer', phone: '9012345678' },
    });
    const id = created.data.data.student.id;
    const createdBy = created.data.data.student.createdBy;
    const updated = await api('PATCH', `/api/admin/crm/students/${id}`, {
      token: staffToken,
      body: { fullName: 'Meera Nair', city: 'Chennai', createdBy: new mongoose.Types.ObjectId().toString(), deletedAt: new Date().toISOString() },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.data.student.fullName, 'Meera Nair');
    assert.equal(updated.data.data.student.createdBy, createdBy);
    assert.equal(updated.data.data.student.deletedAt, null);
  });

  test('first referral wins, including under concurrency', async () => {
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Referral Student', phone: '9345678901' },
    });
    const studentId = student.data.data.student.id;
    const firstConsultancy = await createConsultancy(staffToken, 'North Star Guidance');
    const secondConsultancy = await createConsultancy(staffToken, 'South Gate Advisors');
    assert.equal(firstConsultancy.status, 201);
    assert.equal(secondConsultancy.status, 201);
    const firstId = firstConsultancy.data.data.consultancy.id;
    const secondId = secondConsultancy.data.data.consultancy.id;

    const contact = await api('POST', `/api/admin/crm/consultancies/${firstId}/contacts`, {
      token: staffToken,
      body: { name: 'Anita', phone: '9000011111', role: 'Owner' },
    });
    assert.equal(contact.status, 201);

    const created = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: {
        crmStudentId: studentId,
        consultancyId: firstId,
        consultancyContactId: contact.data.data.contact.id,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.data.referral.consultancyId, firstId);
    assert.equal(created.data.data.referral.originalConsultancyId, firstId);

    const competing = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: { crmStudentId: studentId, consultancyId: secondId },
    });
    assert.equal(competing.status, 409);
    assert.equal(competing.data.code, 'referral_exists');
    assert.equal(competing.data.data.referral.consultancyId, firstId);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: studentId }), 1);

    const generic = await api('PATCH', `/api/admin/crm/referrals/${created.data.data.referral.id}`, {
      token: managerToken,
      body: { consultancyId: secondId },
    });
    assert.equal(generic.status, 403);
    assert.equal(generic.data.code, 'referral_source_immutable');
    const unchanged = await CrmReferral.findOne({ crmStudentId: studentId }).lean();
    assert.equal(String(unchanged.consultancyId), firstId);
  });

  test('concurrent referrals cannot create two attributions', async () => {
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Race Student', phone: '9456789012' },
    });
    const studentId = student.data.data.student.id;
    const a = await createConsultancy(staffToken, 'Alpha Partners');
    const b = await createConsultancy(staffToken, 'Beta Partners');
    const [first, second] = await Promise.all([
      api('POST', '/api/admin/crm/referrals', {
        token: staffToken,
        body: { crmStudentId: studentId, consultancyId: a.data.data.consultancy.id },
      }),
      api('POST', '/api/admin/crm/referrals', {
        token: managerToken,
        body: { crmStudentId: studentId, consultancyId: b.data.data.consultancy.id },
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: studentId }), 1);
  });

  test('only a manager or super admin can correct a referral source, with an audit trail', async () => {
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Correction Student', phone: '9567890123' },
    });
    const studentId = student.data.data.student.id;
    const original = await createConsultancy(staffToken, 'Original Agency');
    const corrected = await createConsultancy(staffToken, 'Correct Agency');
    const originalId = original.data.data.consultancy.id;
    const correctedId = corrected.data.data.consultancy.id;
    const referral = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: { crmStudentId: studentId, consultancyId: originalId },
    });
    const referralId = referral.data.data.referral.id;

    const staffAttempt = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: staffToken,
      body: { consultancyId: correctedId, reason: 'Recorded the wrong agency at intake.' },
    });
    assert.equal(staffAttempt.status, 403);
    assert.equal(String((await CrmReferral.findById(referralId)).consultancyId), originalId);

    const missingReason = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: managerToken,
      body: { consultancyId: correctedId, reason: 'short' },
    });
    assert.equal(missingReason.status, 400);
    assert.equal(String((await CrmReferral.findById(referralId)).consultancyId), originalId);

    const fixed = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: managerToken,
      body: { consultancyId: correctedId, reason: 'The intake form named the wrong consultancy.' },
    });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.data.data.referral.consultancyId, correctedId);
    assert.equal(fixed.data.data.referral.originalConsultancyId, originalId);
    const audit = await CrmAuditLog.findOne({ action: 'referral.source_corrected', entityId: referralId }).lean();
    assert.ok(audit);
    assert.equal(audit.before.consultancyId, originalId);
    assert.equal(audit.after.consultancyId, correctedId);
    assert.equal(audit.reason, 'The intake form named the wrong consultancy.');
    assert.equal(String(audit.actorAdminId), fixed.data.data.referral.sourceCorrectedBy);

    const superFix = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: superToken,
      body: { consultancyId: originalId, reason: 'Super admin restored the verified source.' },
    });
    assert.equal(superFix.status, 200);
    assert.equal(superFix.data.data.referral.consultancyId, originalId);
    assert.equal(superFix.data.data.referral.originalConsultancyId, originalId);
  });

  test('a failed correction does not keep a new source or a success audit', async () => {
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Audit Fail Student', phone: '9678901234' },
    });
    const original = await createConsultancy(staffToken, 'Keep This Agency');
    const other = await createConsultancy(staffToken, 'Do Not Apply Agency');
    const referral = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: {
        crmStudentId: student.data.data.student.id,
        consultancyId: original.data.data.consultancy.id,
      },
    });
    const referralId = referral.data.data.referral.id;
    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const failed = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: managerToken,
      body: {
        consultancyId: other.data.data.consultancy.id,
        reason: 'This correction must roll back with the audit.',
      },
    });
    assert.equal(failed.status, 500);
    const stored = await CrmReferral.findById(referralId).lean();
    assert.equal(String(stored.consultancyId), original.data.data.consultancy.id);
    assert.equal(
      await CrmAuditLog.countDocuments({ action: 'referral.source_corrected', entityId: referralId }),
      0
    );
    assert.equal(String(stored.originalConsultancyId), original.data.data.consultancy.id);
  });

  test('a correction fails closed when transactions are unavailable', async () => {
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Standalone Student', phone: '9789012345' },
    });
    const original = await createConsultancy(staffToken, 'Standalone Original');
    const other = await createConsultancy(staffToken, 'Standalone Other');
    const referral = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: {
        crmStudentId: student.data.data.student.id,
        consultancyId: original.data.data.consultancy.id,
      },
    });
    const referralId = referral.data.data.referral.id;
    setTransactionsEnabledForTests(false);
    const failed = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: managerToken,
      body: {
        consultancyId: other.data.data.consultancy.id,
        reason: 'Transactions are unavailable, so this correction must not be saved.',
      },
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.data.code, 'transaction_required');
    const stored = await CrmReferral.findById(referralId).lean();
    assert.equal(String(stored.consultancyId), original.data.data.consultancy.id);
    assert.equal(String(stored.originalConsultancyId), original.data.data.consultancy.id);
    assert.equal(stored.sourceCorrectedAt, null);
    assert.equal(
      await CrmAuditLog.countDocuments({ action: 'referral.source_corrected', entityId: referralId }),
      0
    );
  });

  test('concurrent corrections keep the stored source and its audit in agreement', async () => {
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Concurrent Correction', phone: '9890123456' },
    });
    const original = await createConsultancy(staffToken, 'Concurrent Original');
    const left = await createConsultancy(staffToken, 'Concurrent Left');
    const right = await createConsultancy(staffToken, 'Concurrent Right');
    const originalId = original.data.data.consultancy.id;
    const leftId = left.data.data.consultancy.id;
    const rightId = right.data.data.consultancy.id;
    const referral = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: { crmStudentId: student.data.data.student.id, consultancyId: originalId },
    });
    const referralId = referral.data.data.referral.id;
    const reason = 'Two managers submitted a source correction at the same time.';
    const [first, second] = await Promise.all([
      api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
        token: managerToken,
        body: { consultancyId: leftId, reason },
      }),
      api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
        token: superToken,
        body: { consultancyId: rightId, reason },
      }),
    ]);
    const results = [first, second];
    const successes = results.filter((result) => result.status === 200);
    const conflicts = results.filter((result) => result.status === 409);
    assert.equal(successes.length + conflicts.length, 2);
    assert.ok(successes.length >= 1);
    conflicts.forEach((result) => assert.equal(result.data.code, 'referral_conflict'));

    const stored = await CrmReferral.findById(referralId).lean();
    const audits = await CrmAuditLog.find({ action: 'referral.source_corrected', entityId: referralId }).lean();
    assert.equal(audits.length, successes.length);
    assert.equal(String(stored.originalConsultancyId), originalId);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: student.data.data.student.id }), 1);
    const matching = audits.filter((audit) => audit.after.consultancyId === String(stored.consultancyId));
    assert.equal(matching.length, 1);
    assert.equal(String(matching[0].actorAdminId), String(stored.sourceCorrectedBy));
    assert.equal(matching[0].reason, reason);
    assert.ok(matching[0].createdAt);
    successes.forEach((result) => {
      const appliedId = result.data.data.referral.consultancyId;
      assert.ok(audits.some((audit) => audit.after.consultancyId === appliedId));
    });
  });

  test('consultancies, contacts, search, and pagination', async () => {
    const created = await createConsultancy(staffToken, 'Horizon Consultants');
    assert.equal(created.status, 201);
    assert.equal(created.data.data.consultancy.pipelineStage, 'fresh');
    assert.equal(created.data.data.consultancy.followUpStatus, 'Fresh Lead');
    assert.equal(Object.hasOwn(created.data.data, 'pipeline'), false);
    const id = created.data.data.consultancy.id;
    const nameBefore = created.data.data.consultancy.name;
    const statusBefore = created.data.data.consultancy.status;
    const ignoredStage = await api('PATCH', `/api/admin/crm/consultancies/${id}`, {
      token: staffToken,
      body: { pipelineStage: 'hot' },
    });
    assert.equal(ignoredStage.status, 400);
    assert.equal(ignoredStage.data.code, 'invalid_body');
    const unchanged = await api('GET', `/api/admin/crm/consultancies/${id}`, { token: staffToken });
    assert.equal(unchanged.data.data.consultancy.name, nameBefore);
    assert.equal(unchanged.data.data.consultancy.status, statusBefore);
    assert.equal(unchanged.data.data.consultancy.pipelineStage, 'fresh');
    assert.equal(Object.hasOwn(unchanged.data.data, 'pipeline'), false);
    const stored = await CrmConsultancy.findById(id).lean();
    assert.equal(stored.name, nameBefore);
    assert.equal(stored.status, statusBefore);
    assert.equal(stored.pipelineStage, 'fresh');
    const duplicate = await createConsultancy(staffToken, '  horizon   consultants ');
    assert.equal(duplicate.status, 409);

    const secondContact = await api('POST', `/api/admin/crm/consultancies/${id}/contacts`, {
      token: staffToken,
      body: { name: 'Ravi', email: 'ravi@example.com', role: 'Counsellor' },
    });
    const third = await api('POST', `/api/admin/crm/consultancies/${id}/contacts`, {
      token: staffToken,
      body: { name: 'Leela', phone: '9898989898' },
    });
    assert.equal(secondContact.status, 201);
    assert.equal(third.status, 201);

    const otherForPhone = await createConsultancy(staffToken, 'Shared Number House');
    const sharedPhone = await api('POST', `/api/admin/crm/consultancies/${otherForPhone.data.data.consultancy.id}/contacts`, {
      token: staffToken,
      body: { name: 'Leela Elsewhere', phone: '9898989898' },
    });
    assert.equal(sharedPhone.status, 201);

    const other = await createConsultancy(staffToken, 'Other House');
    const cross = await api('PATCH', `/api/admin/crm/consultancies/${other.data.data.consultancy.id}/contacts/${secondContact.data.data.contact.id}`, {
      token: staffToken,
      body: { name: 'Stolen' },
    });
    assert.equal(cross.status, 404);
    const still = await CrmConsultancyContact.findById(secondContact.data.data.contact.id).lean();
    assert.equal(still.name, 'Ravi');

    const removed = await api('DELETE', `/api/admin/crm/consultancies/${id}/contacts/${third.data.data.contact.id}`, {
      token: staffToken,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.data.contact.status, 'inactive');
    assert.equal(await CrmConsultancyContact.countDocuments({ consultancyId: id }), 2);

    const missingPage = await api('GET', '/api/admin/crm/consultancies', { token: staffToken });
    assert.equal(missingPage.status, 400);
    const tooLarge = await api('GET', '/api/admin/crm/consultancies?page=1&limit=101', { token: staffToken });
    assert.equal(tooLarge.status, 400);

    const listed = await api('GET', '/api/admin/crm/consultancies?page=1&limit=1&status=active&q=horizon', {
      token: staffToken,
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.data.total, 1);
    assert.equal(listed.data.data.items.length, 1);
    assert.equal(listed.data.data.items[0].id, id);
    assert.equal(listed.data.data.items[0].pipelineStage, 'fresh');
    assert.equal(Object.hasOwn(listed.data.data, 'pipeline'), false);
    const stageQuery = await api('GET', '/api/admin/crm/consultancies?page=1&limit=20&pipelineStage=fresh&q=horizon', {
      token: staffToken,
    });
    assert.equal(stageQuery.status, 200);
    assert.equal(Object.hasOwn(stageQuery.data.data, 'pipeline'), false);
    assert.equal(stageQuery.data.data.items.some((row) => row.id === id), true);
    assert.equal(stageQuery.data.data.items.every((row) => row.pipelineStage === 'fresh'), true);
    const otherStage = await api('GET', '/api/admin/crm/consultancies?page=1&limit=20&pipelineStage=onboarded&q=horizon', {
      token: staffToken,
    });
    assert.equal(otherStage.status, 200);
    assert.equal(otherStage.data.data.total, 0);

    const literal = await api('GET', '/api/admin/crm/consultancies?page=1&limit=20&q=' + encodeURIComponent('.*'), {
      token: staffToken,
    });
    assert.equal(literal.status, 200);
    assert.equal(literal.data.data.total, 0);

    const profile = await api('GET', `/api/admin/crm/consultancies/${id}`, { token: staffToken });
    assert.equal(profile.status, 200);
    const referrals = await api('GET', `/api/admin/crm/referrals?page=1&limit=20&consultancyId=${id}`, {
      token: staffToken,
    });
    assert.equal(referrals.status, 200);

    const blockedDelete = await api('DELETE', `/api/admin/crm/consultancies/${id}`, { token: superToken });
    assert.equal(blockedDelete.status, 405);
    assert.equal(await CrmConsultancy.countDocuments({ _id: id }), 1);
  });

  test('indexes are unique and the sync script refuses remote targets', async () => {
    const studentIndexes = await CrmStudent.collection.indexes();
    assert.ok(studentIndexes.some((idx) => idx.unique && idx.key && idx.key.phone === 1));
    const referralIndexes = await CrmReferral.collection.indexes();
    assert.ok(referralIndexes.some((idx) => idx.unique && idx.key && idx.key.crmStudentId === 1));
    const consultancyIndexes = await CrmConsultancy.collection.indexes();
    assert.ok(consultancyIndexes.some((idx) => idx.unique && idx.key && idx.key.normalizedName === 1));

    assert.throws(
      () => assertSafeIndexTarget('mongodb+srv://example.mongodb.net/guidexpert', { NODE_ENV: 'production' }),
      /production/
    );
    assert.throws(
      () => assertSafeIndexTarget('mongodb://127.0.0.1:27017/guidexpert_crm_index_test', { NODE_ENV: 'production' }),
      /production/
    );
    assert.throws(
      () => assertSafeIndexTarget('mongodb+srv://cluster0.example.mongodb.net/guidexpert', {
        NODE_ENV: 'development',
        ALLOW_CRM_INDEX_SYNC: '1',
      }),
      /non-local/
    );
    assert.throws(
      () => assertSafeIndexTarget('mongodb://10.1.2.3:27017/guidexpert', {
        NODE_ENV: 'test',
        ALLOW_CRM_INDEX_SYNC: '1',
      }),
      /non-local/
    );
    assert.doesNotThrow(() =>
      assertSafeIndexTarget('mongodb://127.0.0.1:27017/guidexpert_crm_index_test', { NODE_ENV: 'development' })
    );
    assert.doesNotThrow(() =>
      assertSafeIndexTarget('mongodb://localhost:27017/guidexpert_crm_index_test', {
        NODE_ENV: 'development',
        ALLOW_CRM_INDEX_SYNC: '1',
      })
    );
    assert.doesNotThrow(() =>
      assertSafeIndexTarget('mongodb://[::1]:27017/guidexpert_crm_index_test', { NODE_ENV: 'test' })
    );

    const sentinel = 'crm_rollout_sentinel_1';
    await CrmReferral.collection.createIndex({ sourceCorrectionReason: 1 }, { name: sentinel });
    const created = await ensureCrmIndexes();
    const names = (await CrmReferral.collection.indexes()).map((index) => index.name);
    assert.ok(names.includes(sentinel));
    assert.ok(names.includes('referredAt_1'));
    assert.ok(names.includes('consultancyId_1_referredAt_-1'));
    assert.ok(names.includes('crmStudentId_1'));
    assert.equal(created.some((index) => index.name === sentinel), false);
    await CrmReferral.collection.dropIndex(sentinel);
  });

  test('CRM permission grant, revoke, audit failure, and unavailable transactions', async () => {
    const target = await Admin.create({
      username: 'crm-permission-target',
      password: 'secret12',
      name: 'Target',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    const req = {
      admin: superAdmin,
      params: { id: String(target._id) },
      body: { sectionAccess: ['leads', 'consultancy-crm', 'consultancy-crm-manager'] },
      ip: '127.0.0.1',
      get() {
        return 'crm-test';
      },
    };
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await updateAdmin(req, res);
    assert.equal(res.statusCode, 200);
    const audit = await CrmAuditLog.findOne({ action: 'crm_permission.updated', entityId: target._id }).lean();
    assert.ok(audit);
    assert.equal(audit.before.consultancyCrm, false);
    assert.equal(audit.after.consultancyCrmManager, true);

    const revokeRes = mockRes();
    await updateAdmin({ ...req, body: { sectionAccess: ['leads', 'consultancy-crm'] } }, revokeRes);
    assert.equal(revokeRes.statusCode, 200);
    const revoked = await Admin.findById(target._id).lean();
    assert.equal(revoked.sectionAccess.includes('consultancy-crm'), true);
    assert.equal(revoked.sectionAccess.includes('consultancy-crm-manager'), false);
    const revokeAudit = await CrmAuditLog.find({ action: 'crm_permission.updated', entityId: target._id })
      .sort({ createdAt: 1 })
      .lean();
    assert.equal(revokeAudit.length, 2);
    assert.equal(revokeAudit[1].before.consultancyCrmManager, true);
    assert.equal(revokeAudit[1].after.consultancyCrmManager, false);
    assert.equal(String(revokeAudit[1].actorAdminId), String(superAdmin._id));

    await updateAdmin(req, mockRes());
    const grantedAgain = await CrmAuditLog.countDocuments({ action: 'crm_permission.updated', entityId: target._id });
    assert.equal(grantedAgain, 3);

    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const revertReq = {
      ...req,
      body: { sectionAccess: ['leads'] },
    };
    const revertRes = mockRes();
    await updateAdmin(revertReq, revertRes);
    assert.equal(revertRes.statusCode, 500);
    assert.match(revertRes.body.message, /No permission was changed/);
    const reloaded = await Admin.findById(target._id).lean();
    assert.ok(reloaded.sectionAccess.includes('consultancy-crm-manager'));
    assert.equal(
      await CrmAuditLog.countDocuments({ action: 'crm_permission.updated', entityId: target._id }),
      grantedAgain
    );

    resetAuditWriterForTests();
    setTransactionsEnabledForTests(false);
    const blocked = mockRes();
    await updateAdmin(revertReq, blocked);
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.body.code, 'transaction_required');
    const stillGranted = await Admin.findById(target._id).lean();
    assert.ok(stillGranted.sectionAccess.includes('consultancy-crm-manager'));
    assert.equal(
      await CrmAuditLog.countDocuments({ action: 'crm_permission.updated', entityId: target._id }),
      grantedAgain
    );

    const renamed = mockRes();
    await updateAdmin({ ...req, body: { name: 'Renamed Target' } }, renamed);
    assert.equal(renamed.statusCode, 200);
    const renamedAdmin = await Admin.findById(target._id).lean();
    assert.equal(renamedAdmin.name, 'Renamed Target');
    assert.ok(renamedAdmin.sectionAccess.includes('consultancy-crm-manager'));

    setTransactionsEnabledForTests(true);
    const created = mockRes();
    await createAdmin({
      admin: superAdmin,
      body: {
        username: 'crm-created-manager',
        password: 'secret12',
        name: 'Created Manager',
        sectionAccess: ['leads', 'consultancy-crm', 'consultancy-crm-manager'],
      },
      ip: '127.0.0.1',
      get() { return 'crm-test'; },
    }, created);
    assert.equal(created.statusCode, 201);
    const createdAdmin = await Admin.findOne({ username: 'crm-created-manager' }).lean();
    assert.ok(createdAdmin.sectionAccess.includes('consultancy-crm-manager'));
    const createdAudit = await CrmAuditLog.findOne({ action: 'crm_permission.updated', entityId: createdAdmin._id }).lean();
    assert.equal(createdAudit.before.consultancyCrm, false);
    assert.equal(createdAudit.after.consultancyCrmManager, true);

    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const failedCreate = mockRes();
    await createAdmin({
      admin: superAdmin,
      body: {
        username: 'crm-create-audit-fail',
        password: 'secret12',
        sectionAccess: ['consultancy-crm'],
      },
      ip: '127.0.0.1',
      get() { return 'crm-test'; },
    }, failedCreate);
    assert.equal(failedCreate.statusCode, 500);
    assert.equal(await Admin.countDocuments({ username: 'crm-create-audit-fail' }), 0);

    resetAuditWriterForTests();
    setTransactionsEnabledForTests(false);
    const blockedCreate = mockRes();
    await createAdmin({
      admin: superAdmin,
      body: {
        username: 'crm-create-no-txn',
        password: 'secret12',
        sectionAccess: ['consultancy-crm-manager', 'leads'],
      },
      ip: '127.0.0.1',
      get() { return 'crm-test'; },
    }, blockedCreate);
    assert.equal(blockedCreate.statusCode, 503);
    assert.equal(blockedCreate.body.code, 'transaction_required');
    assert.equal(await Admin.countDocuments({ username: 'crm-create-no-txn' }), 0);

    const plainCreate = mockRes();
    await createAdmin({
      admin: superAdmin,
      body: {
        username: 'crm-create-leads-only',
        password: 'secret12',
        name: 'Leads Only',
        sectionAccess: ['leads'],
      },
      ip: '127.0.0.1',
      get() { return 'crm-test'; },
    }, plainCreate);
    assert.equal(plainCreate.statusCode, 201);
    const plainAdmin = await Admin.findOne({ username: 'crm-create-leads-only' }).lean();
    assert.deepEqual(plainAdmin.sectionAccess, ['leads']);
    assert.equal(await CrmAuditLog.countDocuments({ entityId: plainAdmin._id, action: 'crm_permission.updated' }), 0);

    await Admin.deleteMany({
      username: { $in: ['crm-permission-target', 'crm-created-manager', 'crm-create-leads-only'] },
    });
  });

  test('audited CRM writes fail closed when transactions are unavailable', async () => {
    setTransactionsEnabledForTests(false);
    const blockedStudent = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'No Transaction Student', phone: '9011111111' },
    });
    assert.equal(blockedStudent.status, 503);
    assert.equal(blockedStudent.data.code, 'transaction_required');
    assert.equal(await CrmStudent.countDocuments({ phone: '9011111111' }), 0);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'student.created' }), 0);

    const blockedConsultancy = await createConsultancy(staffToken, 'No Transaction House');
    assert.equal(blockedConsultancy.status, 503);
    assert.equal(blockedConsultancy.data.code, 'transaction_required');
    assert.equal(await CrmConsultancy.countDocuments({ name: 'No Transaction House' }), 0);

    setTransactionsEnabledForTests(true);
    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Kept Student', phone: '9011111112', city: 'Pune' },
    });
    const studentId = student.data.data.student.id;
    const consultancy = await createConsultancy(staffToken, 'Kept House');
    const consultancyId = consultancy.data.data.consultancy.id;
    const contact = await api('POST', `/api/admin/crm/consultancies/${consultancyId}/contacts`, {
      token: staffToken,
      body: { name: 'Kept Contact', phone: '9011111113' },
    });
    const contactId = contact.data.data.contact.id;
    assert.equal(contact.status, 201);

    setTransactionsEnabledForTests(false);
    const blockedUpdate = await api('PATCH', `/api/admin/crm/students/${studentId}`, {
      token: staffToken,
      body: { city: 'Delhi' },
    });
    assert.equal(blockedUpdate.status, 503);
    assert.equal((await CrmStudent.findById(studentId).lean()).city, 'Pune');
    assert.equal(await CrmAuditLog.countDocuments({ action: 'student.updated', entityId: studentId }), 0);

    const blockedConsultancyUpdate = await api('PATCH', `/api/admin/crm/consultancies/${consultancyId}`, {
      token: staffToken,
      body: { notes: 'must not save' },
    });
    assert.equal(blockedConsultancyUpdate.status, 503);
    assert.equal((await CrmConsultancy.findById(consultancyId).lean()).notes, '');

    const blockedContact = await api('PATCH', `/api/admin/crm/consultancies/${consultancyId}/contacts/${contactId}`, {
      token: staffToken,
      body: { name: 'Changed Contact' },
    });
    assert.equal(blockedContact.status, 503);
    assert.equal((await CrmConsultancyContact.findById(contactId).lean()).name, 'Kept Contact');

    const blockedDeactivate = await api('DELETE', `/api/admin/crm/consultancies/${consultancyId}/contacts/${contactId}`, {
      token: staffToken,
    });
    assert.equal(blockedDeactivate.status, 503);
    assert.equal((await CrmConsultancyContact.findById(contactId).lean()).status, 'active');

    const blockedReferral = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: { crmStudentId: studentId, consultancyId },
    });
    assert.equal(blockedReferral.status, 503);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: studentId }), 0);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'referral.created' }), 0);
  });

  test('a thrown audit failure does not keep a new student or referral', async () => {
    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const failedStudent = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Audit Rollback Student', phone: '9011111114' },
    });
    assert.equal(failedStudent.status, 500);
    assert.equal(await CrmStudent.countDocuments({ phone: '9011111114' }), 0);
    resetAuditWriterForTests();

    const student = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Referral Rollback Student', phone: '9011111115' },
    });
    const consultancy = await createConsultancy(staffToken, 'Referral Rollback House');
    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const failedReferral = await api('POST', '/api/admin/crm/referrals', {
      token: staffToken,
      body: {
        crmStudentId: student.data.data.student.id,
        consultancyId: consultancy.data.data.consultancy.id,
      },
    });
    assert.equal(failedReferral.status, 500);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: student.data.data.student.id }), 0);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'referral.created' }), 0);
  });

  test('concurrent consultancy and contact creates keep one row and a matching audit', async () => {
    const [first, second] = await Promise.all([
      createConsultancy(staffToken, 'Race House'),
      createConsultancy(managerToken, '  race   house '),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const winner = first.status === 201 ? first : second;
    const winnerId = winner.data.data.consultancy.id;
    assert.equal(await CrmConsultancy.countDocuments({ normalizedName: 'race house', deletedAt: null }), 1);
    const createdAudit = await CrmAuditLog.findOne({ action: 'consultancy.created', entityId: winnerId }).lean();
    assert.ok(createdAudit);
    assert.equal(createdAudit.after.name, winner.data.data.consultancy.name);

    const [contactA, contactB] = await Promise.all([
      api('POST', `/api/admin/crm/consultancies/${winnerId}/contacts`, {
        token: staffToken,
        body: { name: 'First Desk', phone: '9011111116' },
      }),
      api('POST', `/api/admin/crm/consultancies/${winnerId}/contacts`, {
        token: managerToken,
        body: { name: 'Second Desk', phone: '9011111116' },
      }),
    ]);
    assert.deepEqual([contactA.status, contactB.status].sort(), [201, 409]);
    const contactWinner = contactA.status === 201 ? contactA : contactB;
    assert.equal(contactB.status === 409 || contactA.status === 409, true);
    assert.equal((contactA.status === 409 ? contactA : contactB).data.code, 'duplicate_contact');
    assert.equal(await CrmConsultancyContact.countDocuments({ consultancyId: winnerId, phone: '9011111116', status: 'active' }), 1);
    const contactAudit = await CrmAuditLog.findOne({
      action: 'contact.created',
      entityId: contactWinner.data.data.contact.id,
    }).lean();
    assert.ok(contactAudit);
    assert.equal(contactAudit.after.name, contactWinner.data.data.contact.name);
  });

  test('concurrent student phone updates cannot assign one number twice', async () => {
    const left = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Left Student', phone: '9011111117' },
    });
    const right = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Right Student', phone: '9011111118' },
    });
    const leftId = left.data.data.student.id;
    const rightId = right.data.data.student.id;
    const [first, second] = await Promise.all([
      api('PATCH', `/api/admin/crm/students/${leftId}`, {
        token: staffToken,
        body: { phone: '9011111119' },
      }),
      api('PATCH', `/api/admin/crm/students/${rightId}`, {
        token: managerToken,
        body: { phone: '+91 90111 11119' },
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const phones = await CrmStudent.find({ _id: { $in: [leftId, rightId] } }).select('phone').lean();
    assert.equal(phones.filter((row) => row.phone === '9011111119').length, 1);
    const winnerId = first.status === 200 ? leftId : rightId;
    const audit = await CrmAuditLog.findOne({ action: 'student.updated', entityId: winnerId }).lean();
    assert.ok(audit);
    assert.equal(audit.after.phone, '9011111119');
  });

  test('deleting an admin with CRM access records a revocation or leaves the admin in place', async () => {
    const manager = await Admin.create({
      username: 'crm-delete-manager',
      password: 'secret12',
      name: 'Delete Manager',
      isSuperAdmin: false,
      sectionAccess: ['leads', 'consultancy-crm', 'consultancy-crm-manager'],
    });
    const leadsOnly = await Admin.create({
      username: 'crm-delete-leads',
      password: 'secret12',
      name: 'Delete Leads',
      isSuperAdmin: false,
      sectionAccess: ['leads'],
    });
    const reqBase = {
      admin: superAdmin,
      ip: '127.0.0.1',
      get() { return 'crm-test'; },
    };

    const selfDelete = mockRes();
    await deleteAdmin({ ...reqBase, params: { id: String(superAdmin._id) } }, selfDelete);
    assert.equal(selfDelete.statusCode, 403);
    assert.ok(await Admin.findById(superAdmin._id));

    const removed = mockRes();
    await deleteAdmin({ ...reqBase, params: { id: String(manager._id) } }, removed);
    assert.equal(removed.statusCode, 200);
    assert.equal(await Admin.countDocuments({ _id: manager._id }), 0);
    const audit = await CrmAuditLog.findOne({ action: 'crm_permission.revoked', entityId: manager._id }).lean();
    assert.ok(audit);
    assert.equal(audit.before.consultancyCrm, true);
    assert.equal(audit.before.consultancyCrmManager, true);
    assert.equal(audit.after.consultancyCrm, false);
    assert.equal(audit.after.consultancyCrmManager, false);
    assert.equal(String(audit.actorAdminId), String(superAdmin._id));
    assert.ok(audit.createdAt);

    const replacement = await Admin.create({
      username: 'crm-delete-manager-2',
      password: 'secret12',
      name: 'Delete Manager Two',
      isSuperAdmin: false,
      sectionAccess: ['consultancy-crm'],
    });
    setAuditWriterForTests(async () => {
      throw new Error('forced audit failure');
    });
    const failed = mockRes();
    await deleteAdmin({ ...reqBase, params: { id: String(replacement._id) } }, failed);
    assert.equal(failed.statusCode, 500);
    assert.match(failed.body.message, /not removed/);
    assert.ok(await Admin.findById(replacement._id));
    assert.equal(await CrmAuditLog.countDocuments({ action: 'crm_permission.revoked', entityId: replacement._id }), 0);

    resetAuditWriterForTests();
    setTransactionsEnabledForTests(false);
    const blocked = mockRes();
    await deleteAdmin({ ...reqBase, params: { id: String(replacement._id) } }, blocked);
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.body.code, 'transaction_required');
    assert.ok(await Admin.findById(replacement._id));

    const plain = mockRes();
    await deleteAdmin({ ...reqBase, params: { id: String(leadsOnly._id) } }, plain);
    assert.equal(plain.statusCode, 200);
    assert.equal(await Admin.countDocuments({ _id: leadsOnly._id }), 0);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'crm_permission.revoked', entityId: leadsOnly._id }), 0);

    await Admin.deleteMany({ username: { $in: ['crm-delete-manager', 'crm-delete-manager-2', 'crm-delete-leads'] } });
  });

  test('GET /api/counsellor/students still returns only that counsellor\'s students', async () => {
    const counsellor = await Counsellor.create({
      name: 'Roster Counsellor',
      email: 'roster-counsellor@example.com',
      password: 'secret12',
      phone: '9000000001',
    });
    const other = await Counsellor.create({
      name: 'Other Counsellor',
      email: 'other-roster-counsellor@example.com',
      password: 'secret12',
      phone: '9000000002',
    });
    await Student.create({
      counsellorId: counsellor._id,
      createdBy: counsellor._id,
      fullName: 'Owned Student',
      phone: '9876500001',
      course: 'B.Tech',
    });
    await Student.create({
      counsellorId: other._id,
      createdBy: other._id,
      fullName: 'Hidden Student',
      phone: '9876500002',
      course: 'MBA',
    });
    await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'CRM Only Student', phone: '9876500003' },
    });
    const token = jwt.sign(
      { counsellorId: counsellor._id.toString() },
      process.env.COUNSELLOR_JWT_SECRET,
      { expiresIn: '1h' }
    );
    const listed = await api('GET', '/api/counsellor/students?page=1&limit=20', { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.total, 1);
    assert.equal(listed.data.data.length, 1);
    assert.equal(listed.data.data[0].fullName, 'Owned Student');
    assert.equal(listed.data.data[0].course, 'B.Tech');

    const adminDenied = await api('GET', '/api/counsellor/students?page=1&limit=20', { token: superToken });
    assert.equal(adminDenied.status, 401);
    const missing = await api('GET', '/api/counsellor/students?page=1&limit=20');
    assert.equal(missing.status, 401);

    await Student.deleteMany({ phone: { $in: ['9876500001', '9876500002'] } });
    await Counsellor.deleteMany({ email: { $in: ['roster-counsellor@example.com', 'other-roster-counsellor@example.com'] } });
  });

  test('admission status is validated, filtered, and missing legacy values are not rewritten', async () => {
    const { ADMISSION_STATUSES } = require('../constants/crm');
    const phones = ['9000091001', '9000091002', '9000091003', '9000091004', '9000091005', '9000091006', '9000091007'];
    for (let index = 0; index < ADMISSION_STATUSES.length; index += 1) {
      const status = ADMISSION_STATUSES[index];
      const created = await api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: `Status ${status}`, phone: phones[index], admissionStatus: status },
      });
      assert.equal(created.status, 201, status);
      assert.equal(created.data.data.student.admissionStatus, status);
      assert.equal(created.data.data.referral, undefined);
      const stored = await CrmStudent.findById(created.data.data.student.id).lean();
      assert.equal(stored.admissionStatus, status);
      const listed = await api('GET', `/api/admin/crm/students?page=1&limit=20&admissionStatus=${encodeURIComponent(status)}`, {
        token: staffToken,
      });
      assert.equal(listed.status, 200);
      assert.ok(listed.data.data.items.some((item) => item.id === created.data.data.student.id));
    }

    for (const admissionStatus of ['Bogus', 'admitted', '']) {
      const rejected = await api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: 'Invalid Status', phone: '9000091010', admissionStatus },
      });
      assert.equal(rejected.status, 400, String(admissionStatus));
      assert.equal(rejected.data.code, 'invalid_body');
    }
    assert.equal(await CrmStudent.countDocuments({ phone: '9000091010' }), 0);

    const applied = await CrmStudent.findOne({ phone: phones[3] });
    const invalidUpdate = await api('PATCH', `/api/admin/crm/students/${applied._id}`, {
      token: staffToken,
      body: { admissionStatus: 'Maybe', city: 'Should Not Save' },
    });
    assert.equal(invalidUpdate.status, 400);
    assert.equal((await CrmStudent.findById(applied._id).lean()).city, '');
    assert.equal((await CrmStudent.findById(applied._id).lean()).admissionStatus, 'Applied');

    const missing = await CrmStudent.create({
      fullName: 'Legacy Missing',
      phone: '9000091011',
      createdBy: superAdmin._id,
      updatedBy: superAdmin._id,
    });
    const beforeMissing = await CrmStudent.findById(missing._id).lean();
    const readMissing = await api('GET', `/api/admin/crm/students/${missing._id}`, { token: staffToken });
    assert.equal(readMissing.status, 200);
    assert.equal(readMissing.data.data.student.admissionStatus, 'Not started');
    const afterMissing = await CrmStudent.findById(missing._id).lean();
    assert.equal(afterMissing.admissionStatus, beforeMissing.admissionStatus);
    assert.equal(new Date(afterMissing.updatedAt).getTime(), new Date(beforeMissing.updatedAt).getTime());

    const bogus = await CrmStudent.create({
      fullName: 'Legacy Bogus',
      phone: '9000091012',
      admissionStatus: 'Bogus',
      createdBy: superAdmin._id,
      updatedBy: superAdmin._id,
    });
    const readBogus = await api('GET', `/api/admin/crm/students/${bogus._id}`, { token: staffToken });
    assert.equal(readBogus.data.data.student.admissionStatus, 'Not started');
    assert.equal((await CrmStudent.findById(bogus._id).lean()).admissionStatus, 'Bogus');
    const cityOnly = await api('PATCH', `/api/admin/crm/students/${bogus._id}`, {
      token: staffToken,
      body: { city: 'Kochi' },
    });
    assert.equal(cityOnly.status, 200);
    assert.equal(cityOnly.data.data.student.admissionStatus, 'Not started');
    assert.equal(cityOnly.data.data.student.city, 'Kochi');
    assert.equal((await CrmStudent.findById(bogus._id).lean()).admissionStatus, 'Bogus');

    const notStarted = await api('GET', '/api/admin/crm/students?page=1&limit=20&admissionStatus=Not%20started', {
      token: staffToken,
    });
    const notStartedIds = notStarted.data.data.items.map((item) => item.id);
    assert.ok(notStartedIds.includes(String(missing._id)));
    assert.ok(notStartedIds.includes(String(bogus._id)));
    assert.ok(notStartedIds.includes((await CrmStudent.findOne({ phone: phones[0] }).lean())._id.toString()));
    assert.equal(notStartedIds.includes(String(applied._id)), false);

    const badFilter = await api('GET', '/api/admin/crm/students?page=1&limit=20&admissionStatus=Bogus', {
      token: staffToken,
    });
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.data.code, 'invalid_query');
    assert.equal((await CrmStudent.findById(bogus._id).lean()).admissionStatus, 'Bogus');
  });

  test('atomic student and referral creation rolls back every failed write', async () => {
    const house = await createConsultancy(staffToken, 'Atomic House');
    const other = await createConsultancy(staffToken, 'Atomic Other');
    const houseId = house.data.data.consultancy.id;
    const otherId = other.data.data.consultancy.id;
    assert.equal(house.data.data.consultancy.studentCount, 0);

    const created = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: {
        fullName: 'Atomic Student',
        phone: '+91 90000 90201',
        admissionStatus: 'Enrolled',
        consultancyId: houseId,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.message, 'Student and referral created.');
    assert.equal(created.data.data.student.phone, '9000090201');
    assert.equal(created.data.data.student.admissionStatus, 'Enrolled');
    assert.equal(created.data.data.referral.consultancyId, houseId);
    assert.equal(created.data.data.referral.originalConsultancyId, houseId);
    assert.equal(await CrmStudent.countDocuments({ phone: '9000090201' }), 1);
    assert.equal(await CrmReferral.countDocuments({ crmStudentId: created.data.data.student.id }), 1);
    const studentAudit = await CrmAuditLog.findOne({ action: 'student.created', entityId: created.data.data.student.id }).lean();
    const referralAudit = await CrmAuditLog.findOne({ action: 'referral.created', entityId: created.data.data.referral.id }).lean();
    assert.ok(studentAudit);
    assert.ok(referralAudit);
    assert.equal(referralAudit.after.originalConsultancyId, houseId);

    const duplicate = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Duplicate Atomic', phone: '9000090201', consultancyId: otherId },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'duplicate_student');
    assert.equal(await CrmStudent.countDocuments({ phone: '9000090201' }), 1);
    assert.equal(await CrmReferral.countDocuments({}), 1);
    assert.equal(String((await CrmReferral.findOne({}).lean()).consultancyId), houseId);

    async function assertNothingPersisted(phone) {
      assert.equal(await CrmStudent.countDocuments({ phone }), 0);
      assert.equal(await CrmReferral.countDocuments({}), 1);
      assert.equal(await CrmAuditLog.countDocuments({ action: 'student.created', 'after.phone': phone }), 0);
      assert.equal(await CrmAuditLog.countDocuments({ action: 'referral.created' }), 1);
    }

    const missingConsultancy = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: {
        fullName: 'Missing Consultancy',
        phone: '9000090202',
        consultancyId: new mongoose.Types.ObjectId().toString(),
      },
    });
    assert.equal(missingConsultancy.status, 404);
    assert.equal(missingConsultancy.data.code, 'not_found');
    await assertNothingPersisted('9000090202');

    const inactive = await api('POST', '/api/admin/crm/consultancies', {
      token: staffToken,
      body: { name: 'Inactive Atomic House', status: 'inactive' },
    });
    assert.equal(inactive.status, 201);
    const inactiveCreate = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: {
        fullName: 'Inactive Source',
        phone: '9000090203',
        consultancyId: inactive.data.data.consultancy.id,
      },
    });
    assert.equal(inactiveCreate.status, 409);
    assert.equal(inactiveCreate.data.code, 'consultancy_not_eligible');
    await assertNothingPersisted('9000090203');

    const referralWithoutConsultancy = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Date Only', phone: '9000090204', referredAt: new Date().toISOString() },
    });
    assert.equal(referralWithoutConsultancy.status, 400);
    assert.equal(referralWithoutConsultancy.data.code, 'consultancy_required');
    await assertNothingPersisted('9000090204');

    const originalStudentCreate = CrmStudent.create;
    CrmStudent.create = async () => {
      throw new Error('forced student write failure');
    };
    try {
      const failedStudent = await api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: 'Student Write Fail', phone: '9000090205', consultancyId: houseId },
      });
      assert.equal(failedStudent.status, 500);
    } finally {
      CrmStudent.create = originalStudentCreate;
    }
    await assertNothingPersisted('9000090205');

    const originalReferralCreate = CrmReferral.create;
    CrmReferral.create = async () => {
      throw new Error('forced referral write failure');
    };
    try {
      const failedReferral = await api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: 'Referral Write Fail', phone: '9000090206', consultancyId: houseId },
      });
      assert.equal(failedReferral.status, 500);
    } finally {
      CrmReferral.create = originalReferralCreate;
    }
    await assertNothingPersisted('9000090206');
    assert.equal(await CrmStudent.countDocuments({ phone: '9000090206' }), 0);
    assert.equal(await CrmReferral.countDocuments({}), 1);

    setAuditWriterForTests(async () => {
      throw new Error('forced student audit failure');
    });
    const failedStudentAudit = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Student Audit Fail', phone: '9000090207', consultancyId: houseId },
    });
    assert.equal(failedStudentAudit.status, 500);
    await assertNothingPersisted('9000090207');
    resetAuditWriterForTests();

    let auditCalls = 0;
    setAuditWriterForTests(async (doc, session) => {
      auditCalls += 1;
      if (auditCalls >= 2) throw new Error('forced referral audit failure');
      const inserted = await CrmAuditLog.create([doc], session ? { session } : undefined);
      return inserted[0];
    });
    const failedReferralAudit = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Referral Audit Fail', phone: '9000090208', consultancyId: houseId },
    });
    assert.equal(failedReferralAudit.status, 500);
    assert.ok(auditCalls >= 2);
    await assertNothingPersisted('9000090208');
    assert.equal(await CrmAuditLog.countDocuments({ action: 'referral.created', 'after.consultancyId': houseId, entityId: { $ne: created.data.data.referral.id } }), 0);
    assert.equal(await CrmStudent.countDocuments({ phone: '9000090208' }), 0);
    resetAuditWriterForTests();

    setTransactionsEnabledForTests(false);
    const unavailable = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'No Transaction Atomic', phone: '9000090209', consultancyId: houseId },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.data.code, 'transaction_required');
    await assertNothingPersisted('9000090209');
    setTransactionsEnabledForTests(true);

    const denied = await api('POST', '/api/admin/crm/students', {
      token: outsiderToken,
      body: { fullName: 'Outsider Atomic', phone: '9000090210', consultancyId: houseId },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'section_forbidden');
    await assertNothingPersisted('9000090210');
  });

  test('consultancy student counts follow the current referral source', async () => {
    const north = await createConsultancy(staffToken, 'Count North');
    const south = await createConsultancy(staffToken, 'Count South');
    const idle = await createConsultancy(staffToken, 'Count Idle');
    const northId = north.data.data.consultancy.id;
    const southId = south.data.data.consultancy.id;
    const idleId = idle.data.data.consultancy.id;

    const first = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Counted One', phone: '9000090301', consultancyId: northId, admissionStatus: 'Contacted' },
    });
    const second = await api('POST', '/api/admin/crm/students', {
      token: staffToken,
      body: { fullName: 'Counted Two', phone: '9000090302', consultancyId: northId },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const referralId = first.data.data.referral.id;
    assert.equal(first.data.data.referral.originalConsultancyId, northId);

    async function countOf(id) {
      const profile = await api('GET', `/api/admin/crm/consultancies/${id}`, { token: staffToken });
      assert.equal(profile.status, 200);
      return profile.data.data.consultancy.studentCount;
    }

    assert.equal(await countOf(northId), 2);
    assert.equal(await countOf(southId), 0);
    assert.equal(await countOf(idleId), 0);

    const staffCorrection = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: staffToken,
      body: { consultancyId: southId, reason: 'Staff must not be able to change this source.' },
    });
    assert.equal(staffCorrection.status, 403);
    assert.equal(String((await CrmReferral.findById(referralId).lean()).originalConsultancyId), northId);
    assert.equal(String((await CrmReferral.findById(referralId).lean()).consultancyId), northId);

    const corrected = await api('POST', `/api/admin/crm/referrals/${referralId}/source-correction`, {
      token: managerToken,
      body: { consultancyId: southId, reason: 'The current source was recorded against the wrong consultancy.' },
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.data.referral.consultancyId, southId);
    assert.equal(corrected.data.data.referral.originalConsultancyId, northId);
    assert.equal(String((await CrmReferral.findById(referralId).lean()).originalConsultancyId), northId);
    assert.equal(await countOf(northId), 1);
    assert.equal(await countOf(southId), 1);

    const deactivated = await api('PATCH', `/api/admin/crm/consultancies/${southId}`, {
      token: staffToken,
      body: { status: 'inactive' },
    });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.data.data.consultancy.status, 'inactive');
    assert.equal(deactivated.data.data.consultancy.studentCount, 1);
    assert.equal(await countOf(idleId), 0);

    const listed = await api('GET', '/api/admin/crm/consultancies?page=1&limit=100', { token: staffToken });
    assert.equal(listed.status, 200);
    const summed = listed.data.data.items.reduce((sum, item) => sum + item.studentCount, 0);
    assert.equal(summed, await CrmReferral.countDocuments({}));
    assert.equal(summed, 2);
    const page = await api('GET', '/api/admin/crm/consultancies?page=1&limit=1', { token: staffToken });
    assert.equal(page.data.data.total, 3);
    assert.equal(page.data.data.items.length, 1);
    assert.equal(typeof page.data.data.items[0].studentCount, 'number');
  });

  test('referral date ranges, analytics, and calendar use referredAt', async () => {
    const { getAnalytics } = require('../services/crm/analyticsService');
    const { zonedTimeToUtc } = require('../utils/crmRange');
    assert.equal(
      zonedTimeToUtc(2026, 4, 2, 0, 0, 0, 0, 'Asia/Kolkata').toISOString(),
      '2026-04-01T18:30:00.000Z'
    );
    const preset = await getAnalytics({ period: '7', timeZone: 'UTC' }, new Date('2026-04-10T15:00:00.000Z'));
    assert.equal(preset.range.from, '2026-04-04');
    assert.equal(preset.range.to, '2026-04-10');
    assert.equal(preset.volume.grain, 'day');
    assert.equal(preset.volume.points.length, 7);
    assert.equal(preset.basis, 'current_admission_status');
    const year = await getAnalytics({ period: 'year', timeZone: 'UTC' }, new Date('2026-04-10T15:00:00.000Z'));
    assert.equal(year.range.from, '2026-01-01');
    assert.equal(year.range.to, '2026-04-10');
    assert.equal(year.volume.grain, 'month');

    const north = await createConsultancy(staffToken, 'Range North');
    const south = await createConsultancy(staffToken, 'Range South');
    const northId = north.data.data.consultancy.id;
    const southId = south.data.data.consultancy.id;
    async function enroll(name, phone, referredAt, consultancyId, admissionStatus) {
      return api('POST', '/api/admin/crm/students', {
        token: staffToken,
        body: { fullName: name, phone, referredAt, consultancyId, admissionStatus },
      });
    }
    const atStart = await enroll('Range Start', '9000092001', '2026-04-02T00:00:00.000Z', northId, 'Enrolled');
    const atEnd = await enroll('Range End', '9000092002', '2026-04-02T23:59:59.999Z', northId, 'Not started');
    const before = await enroll('Range Before', '9000092003', '2026-04-01T23:59:59.999Z', northId, 'Applied');
    const after = await enroll('Range After', '9000092004', '2026-04-03T00:00:00.000Z', northId, 'Admitted');
    assert.equal(atStart.status, 201);
    assert.equal(atEnd.status, 201);
    assert.equal(before.status, 201);
    assert.equal(after.status, 201);

    const day = await api('GET', '/api/admin/crm/referrals?page=1&limit=20&from=2026-04-02&to=2026-04-02&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(day.status, 200);
    assert.equal(day.data.data.total, 2);
    assert.deepEqual(
      day.data.data.items.map((item) => item.id).sort(),
      [atStart.data.data.referral.id, atEnd.data.data.referral.id].sort()
    );
    const pageOne = await api('GET', '/api/admin/crm/referrals?page=1&limit=1&from=2026-04-02&to=2026-04-02&timeZone=UTC', {
      token: staffToken,
    });
    const pageTwo = await api('GET', '/api/admin/crm/referrals?page=2&limit=1&from=2026-04-02&to=2026-04-02&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(pageOne.data.data.total, 2);
    assert.equal(pageOne.data.data.items.length, 1);
    assert.notEqual(pageOne.data.data.items[0].id, pageTwo.data.data.items[0].id);
    const unfiltered = await api('GET', '/api/admin/crm/referrals?page=1&limit=20', { token: staffToken });
    assert.equal(unfiltered.data.data.total, 4);

    const reversed = await api('GET', '/api/admin/crm/referrals?page=1&limit=20&from=2026-04-10&to=2026-04-01&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.data.code, 'invalid_range');
    const impossible = await api('GET', '/api/admin/crm/referrals?page=1&limit=20&from=2026-02-31&to=2026-02-31&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(impossible.status, 400);
    assert.equal(impossible.data.code, 'invalid_date');
    const badZone = await api('GET', '/api/admin/crm/referrals?page=1&limit=20&from=2026-04-02&to=2026-04-02&timeZone=Not/AZone', {
      token: staffToken,
    });
    assert.equal(badZone.status, 400);
    assert.equal(badZone.data.code, 'invalid_timezone');

    const ist = await api('GET', '/api/admin/crm/referrals?page=1&limit=20&from=2026-04-02&to=2026-04-02&timeZone=Asia/Kolkata', {
      token: staffToken,
    });
    assert.equal(ist.status, 200);
    assert.deepEqual(
      ist.data.data.items.map((item) => item.id).sort(),
      [atStart.data.data.referral.id, before.data.data.referral.id].sort()
    );

    const empty = await api('GET', '/api/admin/crm/analytics?period=custom&from=2020-01-01&to=2020-01-02&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.data.data.referralsInPeriod, 0);
    assert.equal(empty.data.data.activeConsultancies, 2);
    assert.equal(empty.data.data.conversion.referralToApplication.label, 'No base');
    assert.equal(empty.data.data.conversion.referralToApplication.rate, null);
    assert.equal(empty.data.data.volume.points.length, 2);
    assert.equal(empty.data.data.volume.points.every((point) => point.count === 0), true);
    assert.equal(empty.data.data.ranking.length, 0);

    const metrics = await api('GET', '/api/admin/crm/analytics?period=custom&from=2026-04-02&to=2026-04-02&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(metrics.data.data.referralsInPeriod, 2);
    assert.equal(metrics.data.data.conversion.referralToApplication.label, '50%');
    assert.equal(metrics.data.data.conversion.referralToApplication.part, 1);
    assert.equal(metrics.data.data.conversion.applicationToAdmission.label, '100%');
    assert.equal(metrics.data.data.conversion.admissionToEnrollment.label, '100%');
    assert.equal(metrics.data.data.statusDistribution.find((row) => row.status === 'Enrolled').count, 1);
    assert.equal(metrics.data.data.statusDistribution.find((row) => row.status === 'Not started').count, 1);
    assert.equal(metrics.data.data.ranking[0].id, northId);
    assert.equal(metrics.data.data.ranking[0].enrolled, 1);

    const appliedOnly = await api('GET', '/api/admin/crm/analytics?period=custom&from=2026-04-01&to=2026-04-01&timeZone=UTC', {
      token: staffToken,
    });
    assert.equal(appliedOnly.data.data.conversion.referralToApplication.label, '100%');
    assert.equal(appliedOnly.data.data.conversion.applicationToAdmission.label, '0%');
    assert.equal(appliedOnly.data.data.conversion.applicationToAdmission.part, 0);
    assert.equal(appliedOnly.data.data.conversion.admissionToEnrollment.label, 'No base');

    const corrected = await api('POST', `/api/admin/crm/referrals/${atStart.data.data.referral.id}/source-correction`, {
      token: managerToken,
      body: { consultancyId: southId, reason: 'The current source should be South for this count.' },
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.data.referral.originalConsultancyId, northId);
    const counted = await api('GET', '/api/admin/crm/analytics?period=custom&from=2026-04-02&to=2026-04-02&timeZone=UTC', {
      token: staffToken,
    });
    const byConsultancy = new Map(counted.data.data.ranking.map((row) => [row.id, row]));
    assert.equal(byConsultancy.get(southId).referrals, 1);
    assert.equal(byConsultancy.get(southId).enrolled, 1);
    assert.equal(byConsultancy.get(northId).referrals, 1);
    assert.equal(byConsultancy.get(northId).enrolled, 0);

    const month = await api('GET', '/api/admin/crm/calendar?month=2026-04&timeZone=UTC&page=1&limit=20', {
      token: staffToken,
    });
    assert.equal(month.status, 200);
    assert.equal(month.data.data.days.length, 30);
    assert.equal(month.data.data.days.find((row) => row.key === '2026-04-01').count, 1);
    assert.equal(month.data.data.days.find((row) => row.key === '2026-04-02').count, 2);
    assert.equal(month.data.data.days.find((row) => row.key === '2026-04-03').count, 1);
    assert.equal(month.data.data.total, 4);
    const selected = await api('GET', '/api/admin/crm/calendar?day=2026-04-02&timeZone=UTC&page=1&limit=1', {
      token: staffToken,
    });
    assert.equal(selected.data.data.total, 2);
    assert.equal(selected.data.data.items.length, 1);
    assert.equal(selected.data.data.days[0].count, 2);
    const mixed = await api('GET', '/api/admin/crm/calendar?day=2026-04-02&month=2026-04&timeZone=UTC&page=1&limit=20', {
      token: staffToken,
    });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.data.code, 'invalid_query');
    const tooLong = await api('GET', '/api/admin/crm/calendar?from=2020-01-01&to=2021-02-01&timeZone=UTC&page=1&limit=20', {
      token: staffToken,
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.data.code, 'range_too_long');
    const denied = await api('GET', '/api/admin/crm/analytics?period=all&timeZone=UTC', { token: outsiderToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'section_forbidden');
    const unsigned = await api('GET', '/api/admin/crm/calendar?day=2026-04-02&timeZone=UTC&page=1&limit=20');
    assert.equal(unsigned.status, 401);
    const missingCustom = await api('GET', '/api/admin/crm/analytics?period=custom&timeZone=UTC', { token: staffToken });
    assert.equal(missingCustom.status, 400);
    assert.equal(missingCustom.data.code, 'invalid_date');
  });

  test('all-time volume keeps the latest 120 months and daylight-saving days stay inclusive', async () => {
    const { resolveAnalyticsRange, previousBounds, monthWindow } = require('../utils/crmRange');
    const { getAnalytics } = require('../services/crm/analyticsService');
    const spring = resolveAnalyticsRange({
      period: 'custom',
      from: '2026-03-08',
      to: '2026-03-08',
      timeZone: 'America/New_York',
    });
    assert.equal(spring.start.toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(spring.end.toISOString(), '2026-03-09T03:59:59.999Z');
    const previous = previousBounds(spring);
    assert.equal(previous.end.getTime() - previous.start.getTime(), spring.end.getTime() - spring.start.getTime());
    assert.equal(previous.end.toISOString(), '2026-03-08T04:59:59.999Z');
    const fall = resolveAnalyticsRange({
      period: 'custom',
      from: '2026-11-01',
      to: '2026-11-01',
      timeZone: 'America/New_York',
    });
    assert.equal(fall.start.toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(fall.end.toISOString(), '2026-11-02T04:59:59.999Z');

    const window = monthWindow('2000-01', '2012-06');
    assert.equal(window.truncated, true);
    assert.equal(window.months.length, 120);
    assert.equal(window.months[0], '2002-07');
    assert.equal(window.months[119], '2012-06');

    const consultancyId = new mongoose.Types.ObjectId();
    await CrmReferral.insertMany(Array.from({ length: 150 }, (_, offset) => ({
      crmStudentId: new mongoose.Types.ObjectId(),
      consultancyId,
      consultancyNameSnapshot: 'Span House',
      originalConsultancyId: consultancyId,
      originalConsultancyName: 'Span House',
      referredAt: new Date(Date.UTC(2000, offset, 15)),
      createdBy: superAdmin._id,
    })));
    const analytics = await getAnalytics({ period: 'all', timeZone: 'UTC' });
    assert.equal(analytics.volume.truncated, true);
    assert.equal(analytics.volume.points.length, 120);
    assert.equal(analytics.volume.points[0].key, '2002-07');
    assert.equal(analytics.volume.points[119].key, '2012-06');
    assert.equal(analytics.volume.points[119].count, 1);
    assert.equal(analytics.volume.points.some((point) => point.key === '2000-01'), false);
  });

  test('existing counsellor student model and route mount are unchanged', () => {
    assert.equal(Student.collection.collectionName, 'students');
    assert.equal(Student.schema.path('counsellorId').isRequired, true);
    assert.equal(CrmStudent.collection.collectionName, 'crmStudents');
    assert.notEqual(CrmStudent.modelName, Student.modelName);
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(serverSrc, /app\.use\('\/api\/counsellor\/students', studentRoutes\)/);
    assert.match(serverSrc, /app\.use\(\s*'\/api\/admin\/crm'/);
    assert.equal(typeof CrmError, 'function');
  });
});
