'use strict';

process.env.NODE_ENV = 'test';
process.env.ADMIN_JWT_SECRET = 'crm-day-end-test-secret';
process.env.CRM_BCRYPT_ROUNDS = '4';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const crmRoutes = require('../routes/crmRoutes');
const { CRM_SECTION_KEY, OPEN_FOLLOW_UP_STATUSES, CONSULTANCY_FOLLOW_UP_STATUSES } = require('../constants/crm');
const { resetAuditWriterForTests } = require('../services/crm/auditService');
const { syncCrmIndexes } = require('../scripts/syncCrmIndexes');
const intelligence = require('../services/crm/staffIntelligenceService');
const { CRM_PERMISSIONS } = require('../constants/crmUsers');
const Admin = require('../models/Admin');
const CrmConsultancy = require('../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const CrmConsultancyFollowUp = require('../models/CrmConsultancyFollowUp');
const CrmConsultancyRemark = require('../models/CrmConsultancyRemark');
const CrmAuditLog = require('../models/CrmAuditLog');
const CrmUser = require('../models/CrmUser');

let mongo;
let server;
let baseUrl;
let superAdmin;
let superToken;
let platformActor;
let consultancyId;

async function request(method, urlPath, body) {
  const headers = { Authorization: `Bearer ${superToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function row(fields) {
  const doc = {
    consultancyId: new mongoose.Types.ObjectId(consultancyId),
    contactId: null,
    type: 'follow_up',
    scheduledAt: null,
    completedAt: null,
    cancelledAt: null,
    outcome: '',
    nextAction: '',
    reason: '',
    notes: '',
    actorName: 'Day End Super',
    createdByAdminId: superAdmin._id,
    createdByCrmUserId: null,
    createdAt: new Date('2026-03-01T06:00:00.000Z'),
    updatedAt: new Date('2026-03-01T06:00:00.000Z'),
    ...fields,
  };
  const inserted = await CrmConsultancyFollowUp.collection.insertOne(doc);
  return String(inserted.insertedId);
}

async function rescheduleAudit(followUpId, createdAt, before, after) {
  const doc = {
    actorAdminId: superAdmin._id,
    actorCrmUserId: null,
    action: 'consultancy.follow_up_updated',
    entityType: 'consultancy',
    entityId: new mongoose.Types.ObjectId(consultancyId),
    reason: '',
    before: before ? { followUpId, ...before } : null,
    after: { followUpId, status: 'Follow-up Required', ...after },
    createdAt,
    updatedAt: createdAt,
  };
  await CrmAuditLog.collection.insertOne(doc);
}

function dayEnd(date, timeZone = 'UTC', extra = {}) {
  return intelligence.listDayEndReport(platformActor, { date, timeZone, page: 1, limit: 100, ...extra });
}

describe('CRM day-end correctness', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_day_end_test' });
    await syncCrmIndexes();
    const app = express();
    app.use(express.json());
    app.use('/api/admin/crm', requireAdmin, requireAdminSection(CRM_SECTION_KEY, 'Consultancy CRM access is required.'), crmRoutes);
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    superAdmin = await Admin.create({
      username: 'day-end-super',
      password: 'secret12',
      name: 'Day End Super',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    superToken = jwt.sign({ adminId: superAdmin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
    platformActor = { _id: superAdmin._id, actorType: 'admin', isSuperAdmin: true, sectionAccess: [] };
  });

  after(async () => {
    resetAuditWriterForTests();
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    resetAuditWriterForTests();
    await Promise.all([
      CrmConsultancy.deleteMany({}),
      CrmConsultancyAssignment.deleteMany({}),
      CrmConsultancyFollowUp.deleteMany({}),
      CrmConsultancyRemark.deleteMany({}),
      CrmAuditLog.deleteMany({}),
      CrmUser.deleteMany({}),
    ]);
    const created = await request('POST', '/api/admin/crm/consultancies', { name: 'Day End Consultancy' });
    assert.equal(created.status, 201);
    consultancyId = created.data.data.consultancy.id;
  });

  test('a report with no follow-up rows has no reconstructed count, and an empty day is a real zero', async () => {
    await CrmConsultancyFollowUp.deleteMany({});
    const empty = await dayEnd('2026-03-10');
    assert.equal(empty.exactSnapshot, false);
    assert.equal(empty.summary.outstanding.count, null);
    assert.equal(empty.summary.overdue.count, null);
    assert.equal(empty.total, 0);
    await row({ status: 'Follow-up Required', scheduledAt: new Date('2026-03-05T09:00:00.000Z') });
    const before = await dayEnd('2020-01-01');
    assert.equal(before.summary.outstanding.count, 0);
    assert.equal(before.summary.overdue.count, 0);
    assert.equal(before.summary.outstanding.exact, false);
  });

  test('only open statuses count as outstanding, and completion or cancellation closes them at their own time', async () => {
    assert.deepEqual(OPEN_FOLLOW_UP_STATUSES, ['Meeting Scheduled', 'Follow-up Required']);
    const past = new Date('2026-03-05T09:00:00.000Z');
    await row({ status: 'Meeting Scheduled', scheduledAt: past });
    await row({ status: 'Follow-up Required', scheduledAt: new Date('2026-03-12T09:00:00.000Z') });
    await row({ status: 'Follow-up Required', scheduledAt: null });
    const closed = CONSULTANCY_FOLLOW_UP_STATUSES.filter((status) => !OPEN_FOLLOW_UP_STATUSES.includes(status));
    for (const status of closed) {
      await row({ status, scheduledAt: status === 'Interested' ? past : null });
    }
    await row({ status: 'Follow-up Required', scheduledAt: past, completedAt: new Date('2026-03-09T10:00:00.000Z') });
    await row({ status: 'Follow-up Required', scheduledAt: past, completedAt: new Date('2026-03-11T10:00:00.000Z') });
    await row({ status: 'Meeting Scheduled', scheduledAt: past, cancelledAt: new Date('2026-03-10T12:00:00.000Z') });
    await row({ status: 'Meeting Scheduled', scheduledAt: past, cancelledAt: new Date('2026-03-12T12:00:00.000Z') });
    await row({ status: 'Follow-up Required', scheduledAt: past, createdAt: new Date('2026-03-11T00:00:00.000Z') });

    const report = await dayEnd('2026-03-10');
    assert.equal(report.summary.outstanding.count, 5);
    assert.equal(report.summary.overdue.count, 3);
    assert.equal(report.summary.outstanding.exact, false);
    const outstanding = report.items.filter((item) => item.kind.endsWith('_approximate'));
    assert.equal(outstanding.length, 5);
    assert.ok(outstanding.every((item) => OPEN_FOLLOW_UP_STATUSES.includes(item.status)));
    assert.ok(outstanding.every((item) => item.exact === false));

    const later = await dayEnd('2026-03-12');
    assert.equal(later.summary.outstanding.count, 4);
  });

  test('rescheduled rows use the recorded schedule at the day end, and legacy edits stay unknown', async () => {
    const recovered = await row({ status: 'Follow-up Required', scheduledAt: new Date('2026-03-20T09:00:00.000Z') });
    await rescheduleAudit(
      recovered,
      new Date('2026-03-11T09:00:00.000Z'),
      { scheduledAt: '2026-03-05T09:00:00.000Z' },
      { scheduledAt: '2026-03-20T09:00:00.000Z' }
    );
    const legacy = await row({ status: 'Follow-up Required', scheduledAt: new Date('2026-03-20T09:00:00.000Z') });
    await rescheduleAudit(legacy, new Date('2026-03-11T09:00:00.000Z'), null, { scheduledAt: '2026-03-20T09:00:00.000Z' });
    const chained = await row({ status: 'Follow-up Required', scheduledAt: new Date('2026-03-25T09:00:00.000Z') });
    await rescheduleAudit(chained, new Date('2026-03-08T09:00:00.000Z'), null, { scheduledAt: '2026-03-09T09:00:00.000Z' });
    await rescheduleAudit(chained, new Date('2026-03-11T09:00:00.000Z'), null, { scheduledAt: '2026-03-25T09:00:00.000Z' });

    const report = await dayEnd('2026-03-10');
    assert.equal(report.summary.outstanding.count, 3);
    assert.equal(report.summary.overdue.count, 2);
    assert.equal(report.summary.overdue.rescheduledLater, 3);
    assert.equal(report.summary.overdue.scheduleUnknown, 1);
    const legacyItem = report.items.find((item) => item.id === `${legacy}:outstanding`);
    assert.equal(legacyItem.scheduleKnown, false);
    assert.equal(legacyItem.kind, 'follow_up.outstanding_approximate');
    const recoveredItem = report.items.find((item) => item.id === `${recovered}:outstanding`);
    assert.equal(recoveredItem.kind, 'follow_up.overdue_approximate');
    assert.equal(new Date(recoveredItem.at).toISOString(), '2026-03-05T09:00:00.000Z');
  });

  test('the reporting day boundary follows the supplied timezone, including a daylight-saving day', async () => {
    await row({ status: 'Follow-up Required', scheduledAt: new Date('2026-03-09T03:30:00.000Z') });
    const newYork = await dayEnd('2026-03-08', 'America/New_York');
    assert.equal(new Date(newYork.range.start).toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(new Date(newYork.range.end).toISOString(), '2026-03-09T03:59:59.999Z');
    assert.equal(newYork.summary.overdue.count, 1);
    const utc = await dayEnd('2026-03-08', 'UTC');
    assert.equal(utc.summary.overdue.count, 0);
    assert.equal(utc.summary.outstanding.count, 1);
    const kolkata = await dayEnd('2026-03-09', 'Asia/Kolkata');
    assert.equal(new Date(kolkata.range.end).toISOString(), '2026-03-09T18:29:59.999Z');
    assert.equal(kolkata.summary.overdue.count, 1);
  });

  test('follow-up audits record before and after values, retries do not duplicate them, and a completed row cannot be cancelled', async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
    const created = await request('POST', `/api/admin/crm/consultancies/${consultancyId}/follow-ups`, {
      followUpStatus: 'Follow-up Required',
      nextAction: 'Call the principal',
      scheduledAt: future,
    });
    assert.equal(created.status, 200);
    const followUpId = created.data.data.followUp.id;
    const base = `/api/admin/crm/consultancies/${consultancyId}/follow-ups/${followUpId}`;

    const moved = await request('PATCH', base, { scheduledAt: later });
    assert.equal(moved.status, 200);
    const repeat = await request('PATCH', base, { scheduledAt: later });
    assert.equal(repeat.status, 200);
    const updates = await CrmAuditLog.find({ action: 'consultancy.follow_up_updated', 'after.followUpId': followUpId }).lean();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].before.scheduledAt, new Date(future).toISOString());
    assert.equal(updates[0].after.scheduledAt, new Date(later).toISOString());
    assert.equal(updates[0].before.status, 'Follow-up Required');

    const first = await request('POST', `${base}/complete`);
    const second = await request('POST', `${base}/complete`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const completions = await CrmAuditLog.find({ action: 'consultancy.follow_up_completed', 'after.followUpId': followUpId }).lean();
    assert.equal(completions.length, 1);
    assert.equal(completions[0].before.completedAt, null);
    assert.ok(completions[0].after.completedAt);
    assert.equal(completions[0].after.scheduledAt, new Date(later).toISOString());

    const cancel = await request('POST', `${base}/cancel`);
    assert.equal(cancel.status, 409);
    assert.equal(cancel.data.code, 'invalid_transition');
    const stored = await CrmConsultancyFollowUp.findById(followUpId).lean();
    assert.equal(stored.cancelledAt, null);
    assert.equal(await CrmAuditLog.countDocuments({ action: 'consultancy.follow_up_cancelled' }), 0);

    const other = await request('POST', `/api/admin/crm/consultancies/${consultancyId}/follow-ups`, {
      followUpStatus: 'Follow-up Required',
      nextAction: 'Call again',
      scheduledAt: future,
    });
    const otherBase = `/api/admin/crm/consultancies/${consultancyId}/follow-ups/${other.data.data.followUp.id}`;
    assert.equal((await request('POST', `${otherBase}/cancel`)).status, 200);
    assert.equal((await request('POST', `${otherBase}/cancel`)).status, 200);
    const cancels = await CrmAuditLog.find({ action: 'consultancy.follow_up_cancelled' }).lean();
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].before.cancelledAt, null);
    assert.ok(cancels[0].after.cancelledAt);
  });

  test('a consultancy filter constrains day-end totals for organization-wide CRM readers', async () => {
    const other = await request('POST', '/api/admin/crm/consultancies', { name: 'Other Day End House' });
    assert.equal(other.status, 201);
    const otherId = other.data.data.consultancy.id;
    await row({
      status: 'Follow-up Required',
      scheduledAt: new Date('2026-03-05T09:00:00.000Z'),
      consultancyId: new mongoose.Types.ObjectId(consultancyId),
    });
    await row({
      status: 'Follow-up Required',
      scheduledAt: new Date('2026-03-05T09:00:00.000Z'),
      consultancyId: new mongoose.Types.ObjectId(otherId),
    });
    const orgReader = {
      _id: new mongoose.Types.ObjectId(),
      actorType: 'crm-user',
      permissions: [...CRM_PERMISSIONS],
    };
    const filtered = await intelligence.listDayEndReport(orgReader, {
      date: '2026-03-10',
      timeZone: 'UTC',
      page: 1,
      limit: 100,
      consultancyId,
    });
    assert.equal(filtered.recordScope, 'consultancy');
    assert.equal(filtered.aggregateScope, 'consultancy');
    assert.equal(filtered.summary.outstanding.count, 1);
    assert.equal(filtered.summary.overdue.count, 1);
    assert.equal(filtered.items.every((item) => item.consultancyId === consultancyId), true);
    const whole = await intelligence.listDayEndReport(orgReader, {
      date: '2026-03-10',
      timeZone: 'UTC',
      page: 1,
      limit: 100,
    });
    assert.equal(whole.summary.outstanding.count, 2);
  });

  test('userId uses assignment at day end, actorId uses the recorded actor, and exceptions carry reason codes', async () => {
    const assignee = await CrmUser.create({
      fullName: 'Assigned Staff',
      email: 'assigned-day-end@example.com',
      username: 'assigned.dayend',
      passwordHash: 'x',
      role: 'crm_manager',
      permissions: ['crm.audit.read'],
      status: 'active',
    });
    const actor = await CrmUser.create({
      fullName: 'Acting Staff',
      email: 'actor-day-end@example.com',
      username: 'actor.dayend',
      passwordHash: 'x',
      role: 'crm_manager',
      permissions: ['crm.audit.read'],
      status: 'active',
    });
    await CrmConsultancyAssignment.create({
      consultancyId,
      crmUserId: assignee._id,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      createdByCrmUserId: actor._id,
      revokedAt: null,
    });
    const followUpId = await row({
      status: 'Follow-up Required',
      scheduledAt: new Date('2026-03-05T09:00:00.000Z'),
      completedAt: new Date('2026-03-10T12:00:00.000Z'),
      completedByCrmUserId: actor._id,
      outcome: 'Reached the desk',
      nextAction: 'Send brochure',
      createdByCrmUserId: actor._id,
    });
    const byAssignee = await dayEnd('2026-03-10', 'UTC', { userId: String(assignee._id) });
    assert.equal(byAssignee.summary.followUpsCompleted, 1);
    assert.match(byAssignee.filters.userIdMeaning, /assigned to this CRM user at the reporting day end/i);
    const completed = byAssignee.items.find((item) => item.id === `${followUpId}:completed`);
    assert.ok(completed);
    assert.equal(completed.actor.id, String(actor._id));
    assert.equal(completed.outcome, 'Reached the desk');
    assert.equal(completed.nextAction, 'Send brochure');
    assert.equal(completed.exception, true);
    assert.equal(completed.exceptionReason, 'completed_after_schedule');
    assert.equal(completed.severity, 'medium');

    const byActor = await dayEnd('2026-03-10', 'UTC', { actorId: String(actor._id) });
    assert.equal(byActor.items.every((item) => item.actor && item.actor.id === String(actor._id)), true);
    assert.ok(byActor.items.some((item) => item.id === `${followUpId}:completed`));

    const stranger = await dayEnd('2026-03-10', 'UTC', { actorId: String(assignee._id) });
    assert.equal(stranger.items.some((item) => item.id === `${followUpId}:completed`), false);

    const cancelledId = await row({
      status: 'Meeting Scheduled',
      scheduledAt: new Date('2026-03-12T09:00:00.000Z'),
      cancelledAt: new Date('2026-03-10T15:00:00.000Z'),
      cancelledByCrmUserId: actor._id,
      createdByCrmUserId: actor._id,
    });
    const exceptions = await dayEnd('2026-03-10', 'UTC', { event: 'exception' });
    const cancelled = exceptions.items.find((item) => item.id === `${cancelledId}:cancelled`);
    assert.ok(cancelled);
    assert.equal(cancelled.exceptionReason, 'follow_up_cancelled');
    assert.equal(cancelled.severity, 'medium');
  });

  test('truncated admission scans null the KPIs, and outstanding caps use a stable order', async () => {
    intelligence.setSourceCapForTests(2);
    try {
      const day = new Date('2026-03-10T12:00:00.000Z');
      const entity = new mongoose.Types.ObjectId();
      await CrmAuditLog.collection.insertMany([
        {
          actorAdminId: superAdmin._id,
          action: 'student.created',
          entityType: 'crmStudent',
          entityId: entity,
          before: null,
          after: { admissionStatus: 'Not started', fullName: 'One' },
          createdAt: day,
          updatedAt: day,
        },
        {
          actorAdminId: superAdmin._id,
          action: 'student.created',
          entityType: 'crmStudent',
          entityId: new mongoose.Types.ObjectId(),
          before: null,
          after: { admissionStatus: 'Not started', fullName: 'Two' },
          createdAt: new Date(day.getTime() + 1000),
          updatedAt: new Date(day.getTime() + 1000),
        },
        {
          actorAdminId: superAdmin._id,
          action: 'student.updated',
          entityType: 'crmStudent',
          entityId: entity,
          before: { admissionStatus: 'Not started' },
          after: { admissionStatus: 'Contacted' },
          createdAt: new Date(day.getTime() + 2000),
          updatedAt: new Date(day.getTime() + 2000),
        },
      ]);
      const admissions = await dayEnd('2026-03-10');
      assert.equal(admissions.truncated, true);
      assert.equal(admissions.summary.studentsCreated, null);
      assert.equal(admissions.summary.admissionChanges, null);

      const first = new mongoose.Types.ObjectId();
      const second = new mongoose.Types.ObjectId();
      const third = new mongoose.Types.ObjectId();
      const past = new Date('2026-03-05T09:00:00.000Z');
      await CrmConsultancyFollowUp.collection.insertMany([
        {
          _id: third,
          consultancyId: new mongoose.Types.ObjectId(consultancyId),
          contactId: null,
          type: 'follow_up',
          status: 'Follow-up Required',
          scheduledAt: past,
          completedAt: null,
          cancelledAt: null,
          createdAt: new Date('2026-03-03T09:00:00.000Z'),
          updatedAt: new Date('2026-03-03T09:00:00.000Z'),
        },
        {
          _id: first,
          consultancyId: new mongoose.Types.ObjectId(consultancyId),
          contactId: null,
          type: 'follow_up',
          status: 'Follow-up Required',
          scheduledAt: past,
          completedAt: null,
          cancelledAt: null,
          createdAt: new Date('2026-03-01T09:00:00.000Z'),
          updatedAt: new Date('2026-03-01T09:00:00.000Z'),
        },
        {
          _id: second,
          consultancyId: new mongoose.Types.ObjectId(consultancyId),
          contactId: null,
          type: 'follow_up',
          status: 'Follow-up Required',
          scheduledAt: past,
          completedAt: null,
          cancelledAt: null,
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          updatedAt: new Date('2026-03-02T09:00:00.000Z'),
        },
      ]);
      const capped = await dayEnd('2026-03-10');
      assert.equal(capped.truncated, true);
      assert.equal(capped.summary.outstanding.count, null);
      const outstanding = capped.items
        .filter((item) => item.kind.endsWith('_approximate'))
        .map((item) => item.id.replace(/:outstanding$/, ''));
      assert.deepEqual(outstanding, [String(first), String(second)]);
    } finally {
      intelligence.setSourceCapForTests(5000);
    }
  });
});
