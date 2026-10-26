'use strict';

const mongoose = require('mongoose');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmStudent = require('../../models/CrmStudent');
const CrmUser = require('../../models/CrmUser');
const Admin = require('../../models/Admin');
const { ADMISSION_STATUSES } = require('../../constants/crm');
const { CrmError } = require('../../utils/crmError');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { resolveAnalyticsRange } = require('../../utils/crmRange');
const { businessAuditScope } = require('./auditService');
const { assignedConsultancyIds } = require('./crmAccess');

const SOURCE_CAP = 5000;
const ADMISSION_ACTIONS = Object.freeze(['student.created', 'student.updated']);
const ASSIGNMENT_ACTIONS = Object.freeze(['crm_assignment.created', 'crm_assignment.revoked']);
const QUERY_KEYS = Object.freeze([
  'page',
  'limit',
  'from',
  'to',
  'timeZone',
  'consultancyId',
  'actorId',
  'studentId',
  'userId',
  'kind',
  'fromStatus',
  'toStatus',
  'assignment',
]);

const COVERAGE = Object.freeze([
  'Admission rows come from student.created and from student.updated audits whose recorded status changed.',
  'A student with no admission audit is omitted. Missing history is not filled in.',
  'A consultancy filter uses the student\'s current referral link. It is not the consultancy at the time of the change.',
  'Assignment intervals come from assignment rows, including revoked rows. They are not a second copy of the security audit.',
  'Daily counts are recorded audit rows grouped by the supplied timezone. They are not working time, productivity, or a conversion rate.',
  'An omitted timezone is UTC. Asia/Kolkata is used only when the caller sends it.',
]);

function moduleAggregates(actor) {
  return Boolean(
    actor
    && actor.actorType === 'crm-user'
    && Array.isArray(actor.permissions)
    && actor.permissions.includes('crm.roles.manage')
  );
}

function assertKeys(query) {
  Object.keys(query || {}).forEach((key) => {
    if (!QUERY_KEYS.includes(key)) {
      throw new CrmError(400, `${key} is not a supported history filter.`, 'unsupported_filter');
    }
  });
}

function parseRange(query) {
  const from = query.from == null ? '' : String(query.from).trim();
  const to = query.to == null ? '' : String(query.to).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new CrmError(400, 'from and to must be YYYY-MM-DD dates.', 'invalid_query');
  }
  return resolveAnalyticsRange({
    period: 'custom',
    from,
    to,
    timeZone: query.timeZone,
  });
}

function optionalId(query, key, label) {
  if (query[key] == null || query[key] === '') return null;
  return parseObjectId(String(query[key]), label);
}

function recordedStatus(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'admissionStatus')) return undefined;
  const value = snapshot.admissionStatus;
  if (value == null || value === '') return 'Not started';
  return ADMISSION_STATUSES.includes(value) ? value : undefined;
}

function actorOf(row) {
  if (row.actorCrmUserId) return { type: 'crm-user', id: String(row.actorCrmUserId) };
  if (row.actorAdminId) return { type: 'admin', id: String(row.actorAdminId) };
  return null;
}

function storedActor(crmUserId, adminId) {
  if (crmUserId) return { type: 'crm-user', id: String(crmUserId) };
  if (adminId) return { type: 'admin', id: String(adminId) };
  return null;
}

async function namesFor(actors) {
  const userIds = [];
  const adminIds = [];
  actors.forEach((actor) => {
    if (!actor) return;
    if (actor.type === 'crm-user') userIds.push(actor.id);
    if (actor.type === 'admin') adminIds.push(actor.id);
  });
  const [users, admins] = await Promise.all([
    userIds.length ? CrmUser.find({ _id: { $in: userIds } }).select('fullName').lean() : [],
    adminIds.length ? Admin.find({ _id: { $in: adminIds } }).select('name').lean() : [],
  ]);
  const names = new Map();
  users.forEach((row) => names.set(`crm-user:${row._id}`, row.fullName || ''));
  admins.forEach((row) => names.set(`admin:${row._id}`, row.name || ''));
  return names;
}

function named(actor, names) {
  if (!actor) return null;
  return { ...actor, name: names.get(`${actor.type}:${actor.id}`) || '' };
}

async function resolveListScope(actor, consultancyId) {
  const assigned = await assignedConsultancyIds(actor);
  if (!consultancyId) {
    return { consultancyIds: assigned, constrained: false };
  }
  const selected = String(consultancyId);
  if (assigned != null && !assigned.some((id) => String(id) === selected)) {
    throw new CrmError(404, 'Consultancy not found.', 'not_found');
  }
  return {
    consultancyIds: [new mongoose.Types.ObjectId(selected)],
    constrained: true,
  };
}

function aggregateIds(actor, listIds) {
  if (listIds == null || moduleAggregates(actor)) return null;
  return listIds;
}

function pageSlice(items, page, limit) {
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
}

async function listAdmissionHistory(actor, query) {
  assertKeys(query);
  const { page, limit } = parsePageLimit(query);
  const range = parseRange(query);
  const kind = query.kind == null || query.kind === '' ? '' : String(query.kind);
  if (kind && kind !== 'initial' && kind !== 'transition') {
    throw new CrmError(400, 'kind must be initial or transition.', 'invalid_query');
  }
  const fromStatus = query.fromStatus == null || query.fromStatus === '' ? '' : String(query.fromStatus);
  const toStatus = query.toStatus == null || query.toStatus === '' ? '' : String(query.toStatus);
  [fromStatus, toStatus].forEach((status) => {
    if (status && !ADMISSION_STATUSES.includes(status)) {
      throw new CrmError(400, 'status must be a recorded admission status.', 'invalid_query');
    }
  });
  const consultancyId = optionalId(query, 'consultancyId', 'Consultancy id');
  const actorId = optionalId(query, 'actorId', 'Actor id');
  const studentId = optionalId(query, 'studentId', 'Student id');
  const scope = await resolveListScope(actor, consultancyId);
  const filter = {
    $and: [
      await businessAuditScope(scope.consultancyIds),
      { action: { $in: ADMISSION_ACTIONS }, entityType: 'crmStudent' },
      { createdAt: { $gte: range.start, $lte: range.end } },
    ],
  };
  if (actorId) filter.$and.push({ $or: [{ actorCrmUserId: actorId }, { actorAdminId: actorId }] });
  if (studentId) filter.$and.push({ entityId: studentId });
  const rows = await CrmAuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(SOURCE_CAP + 1).lean();
  const truncated = rows.length > SOURCE_CAP;
  const seen = new Set();
  let unclassified = 0;
  const derived = [];
  rows.slice(0, SOURCE_CAP).forEach((row) => {
    const id = String(row._id);
    if (seen.has(id)) return;
    seen.add(id);
    const nextStatus = recordedStatus(row.after);
    if (row.action === 'student.created') {
      if (!nextStatus) {
        unclassified += 1;
        return;
      }
      derived.push({
        id,
        kind: 'initial',
        previousStatus: null,
        nextStatus,
        at: row.createdAt,
        studentId: String(row.entityId),
        actor: actorOf(row),
      });
      return;
    }
    const previousStatus = recordedStatus(row.before);
    if (!previousStatus || !nextStatus) {
      unclassified += 1;
      return;
    }
    if (previousStatus === nextStatus) return;
    derived.push({
      id,
      kind: 'transition',
      previousStatus,
      nextStatus,
      at: row.createdAt,
      studentId: String(row.entityId),
      actor: actorOf(row),
    });
  });
  const filtered = derived.filter((row) => {
    if (kind && row.kind !== kind) return false;
    if (fromStatus && row.previousStatus !== fromStatus) return false;
    if (toStatus && row.nextStatus !== toStatus) return false;
    return true;
  });
  const pageItems = pageSlice(filtered, page, limit);
  const students = pageItems.length
    ? await CrmStudent.find({ _id: { $in: pageItems.map((row) => row.studentId) } }).select('fullName').lean()
    : [];
  const studentNames = new Map(students.map((row) => [String(row._id), row.fullName || '']));
  const actorNames = await namesFor(pageItems.map((row) => row.actor));
  return {
    generatedAt: new Date(),
    scope: scope.consultancyIds == null ? 'module' : 'assigned',
    consultancyLink: 'current_referral',
    timeZone: range.timeZone,
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    truncated,
    unclassified,
    limitations: COVERAGE,
    page,
    limit,
    total: filtered.length,
    items: pageItems.map((row) => ({
      ...row,
      studentName: studentNames.has(row.studentId) ? studentNames.get(row.studentId) : null,
      actor: named(row.actor, actorNames),
    })),
  };
}

async function listAssignmentHistory(actor, query) {
  assertKeys(query);
  const { page, limit, skip } = parsePageLimit(query);
  const range = parseRange(query);
  const assignment = query.assignment == null || query.assignment === '' ? '' : String(query.assignment);
  if (assignment && assignment !== 'active' && assignment !== 'revoked') {
    throw new CrmError(400, 'assignment must be active or revoked.', 'invalid_query');
  }
  const consultancyId = optionalId(query, 'consultancyId', 'Consultancy id');
  const userId = optionalId(query, 'userId', 'User id');
  const scope = await resolveListScope(actor, consultancyId);
  const filter = {
    createdAt: { $lte: range.end },
    $or: [{ revokedAt: null }, { revokedAt: { $gte: range.start } }],
  };
  if (scope.consultancyIds) filter.consultancyId = { $in: scope.consultancyIds };
  if (userId) filter.crmUserId = userId;
  if (assignment === 'active') filter.revokedAt = null;
  if (assignment === 'revoked') filter.revokedAt = { $ne: null, $gte: range.start };
  const [rows, total] = await Promise.all([
    CrmConsultancyAssignment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmConsultancyAssignment.countDocuments(filter),
  ]);
  const consultancyIds = [...new Set(rows.map((row) => String(row.consultancyId)))];
  const userIds = [...new Set(rows.map((row) => String(row.crmUserId)))];
  const [consultancies, users] = await Promise.all([
    consultancyIds.length ? CrmConsultancy.find({ _id: { $in: consultancyIds } }).select('name').lean() : [],
    userIds.length ? CrmUser.find({ _id: { $in: userIds } }).select('fullName').lean() : [],
  ]);
  const consultancyNames = new Map(consultancies.map((row) => [String(row._id), row.name || '']));
  const userNames = new Map(users.map((row) => [String(row._id), row.fullName || '']));
  const actors = [];
  rows.forEach((row) => {
    actors.push(storedActor(row.createdByCrmUserId, row.createdByAdminId));
    actors.push(storedActor(row.revokedByCrmUserId, row.revokedByAdminId));
  });
  const actorNames = await namesFor(actors);
  return {
    generatedAt: new Date(),
    scope: scope.consultancyIds == null ? 'module' : 'assigned',
    source: 'crmConsultancyAssignments',
    timeZone: range.timeZone,
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    limitations: COVERAGE,
    page,
    limit,
    total,
    items: rows.map((row) => {
      const openedBy = named(storedActor(row.createdByCrmUserId, row.createdByAdminId), actorNames);
      const revokedBy = row.revokedAt
        ? named(storedActor(row.revokedByCrmUserId, row.revokedByAdminId), actorNames)
        : null;
      return {
        id: String(row._id),
        consultancyId: String(row.consultancyId),
        consultancyName: consultancyNames.get(String(row.consultancyId)) || '',
        userId: String(row.crmUserId),
        userName: userNames.get(String(row.crmUserId)) || '',
        openedAt: row.createdAt,
        revokedAt: row.revokedAt || null,
        state: row.revokedAt ? 'revoked' : 'active',
        openedBy,
        revokedBy,
        events: [
          { action: 'assigned', at: row.createdAt, actor: openedBy },
          ...(row.revokedAt ? [{ action: 'revoked', at: row.revokedAt, actor: revokedBy }] : []),
        ],
      };
    }),
  };
}

async function grouped(model, match, timeZone) {
  return model.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone } },
          action: '$action',
          actorCrmUserId: '$actorCrmUserId',
          actorAdminId: '$actorAdminId',
        },
        count: { $sum: 1 },
      },
    },
  ]);
}

async function listDailyHistory(actor, query) {
  assertKeys(query);
  const { page, limit } = parsePageLimit(query);
  const range = parseRange(query);
  const consultancyId = optionalId(query, 'consultancyId', 'Consultancy id');
  const actorId = optionalId(query, 'actorId', 'Actor id');
  const listScope = await resolveListScope(actor, consultancyId);
  const ids = aggregateIds(actor, listScope.consultancyIds);
  const createdAt = { $gte: range.start, $lte: range.end };
  const actorClause = actorId ? { $or: [{ actorCrmUserId: actorId }, { actorAdminId: actorId }] } : null;
  const business = {
    $and: [
      await businessAuditScope(ids),
      { createdAt },
      ...(actorClause ? [actorClause] : []),
    ],
  };
  const security = { action: { $in: ASSIGNMENT_ACTIONS }, createdAt };
  if (ids) security['after.consultancyId'] = { $in: ids.map(String) };
  if (actorId) {
    security.$or = [{ actorCrmUserId: actorId }, { actorAdminId: actorId }];
  }
  const [businessRows, securityRows] = await Promise.all([
    grouped(CrmAuditLog, business, range.timeZone),
    grouped(CrmAuthAuditLog, security, range.timeZone),
  ]);
  const items = [
    ...businessRows.map((row) => ({ ...row, source: 'business' })),
    ...securityRows.map((row) => ({ ...row, source: 'security' })),
  ].map((row) => ({
    day: row._id.day,
    action: row._id.action,
    source: row.source,
    count: row.count,
    actor: row._id.actorCrmUserId
      ? { type: 'crm-user', id: String(row._id.actorCrmUserId) }
      : (row._id.actorAdminId ? { type: 'admin', id: String(row._id.actorAdminId) } : null),
  })).sort((left, right) => (
    right.day.localeCompare(left.day)
    || String(left.action).localeCompare(String(right.action))
    || String(left.source).localeCompare(String(right.source))
  ));
  const pageItems = pageSlice(items, page, limit);
  const actorNames = await namesFor(pageItems.map((row) => row.actor));
  const aggregateScope = listScope.constrained
    ? 'consultancy'
    : (ids == null ? 'module' : 'assigned');
  return {
    generatedAt: new Date(),
    scope: listScope.consultancyIds == null ? 'module' : 'assigned',
    aggregateScope,
    timeZone: range.timeZone,
    timeZoneConfirmed: false,
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    excluded: ['presence', 'working time', 'productivity', 'conversion', 'sign-in events'],
    limitations: COVERAGE,
    page,
    limit,
    total: items.length,
    items: pageItems.map((row) => ({ ...row, actor: named(row.actor, actorNames) })),
  };
}

module.exports = {
  listAdmissionHistory,
  listAssignmentHistory,
  listDailyHistory,
};
