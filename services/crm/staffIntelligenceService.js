'use strict';

const mongoose = require('mongoose');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmConsultancyFollowUp = require('../../models/CrmConsultancyFollowUp');
const CrmStudent = require('../../models/CrmStudent');
const CrmUser = require('../../models/CrmUser');
const Admin = require('../../models/Admin');
const { ADMISSION_STATUSES, OPEN_FOLLOW_UP_STATUSES } = require('../../constants/crm');
const { CrmError } = require('../../utils/crmError');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { calendarDayKey, previousBounds, resolveAnalyticsRange, shiftDateKey } = require('../../utils/crmRange');
const { businessAuditScope } = require('./auditService');
const { reportingConsultancyIds, reportingScopeBasis } = require('./crmAccess');

let SOURCE_CAP = 5000;

function setSourceCapForTests(value) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRM intelligence source-cap test controls are refused in production.');
  }
  SOURCE_CAP = Number.isFinite(value) && value > 0 ? Math.floor(value) : 5000;
}
const BUCKETS = Object.freeze(['overdue', 'due_today', 'upcoming', 'unscheduled', 'completed', 'cancelled']);
const EVENTS = Object.freeze(['admission', 'assignment', 'follow_up', 'exception']);
const FOLLOW_UP_KEYS = Object.freeze(['page', 'limit', 'from', 'to', 'timeZone', 'consultancyId', 'userId', 'bucket']);
const DAY_KEYS = Object.freeze(['page', 'limit', 'date', 'timeZone', 'consultancyId', 'userId', 'actorId', 'event']);
const WORKLOAD_KEYS = Object.freeze(['page', 'limit', 'from', 'to', 'timeZone', 'consultancyId', 'userId']);

const COVERAGE = Object.freeze([
  'Overdue, due today, and upcoming use the follow-up row scheduledAt. A row with no scheduledAt is not overdue.',
  'An open follow-up has status Meeting Scheduled or Follow-up Required, no completedAt, and no cancelledAt.',
  'Past overdue and outstanding counts are reconstructed from surviving rows. They are not an end-of-day snapshot.',
  'A consultancy filter and student admission rows use the current referral link, not the consultancy on the day of the change.',
  'Assigned workload counts a shared follow-up once for every current assignee. It is not split and not given to the earliest assignee.',
  'Work performed uses the person stored on the event. It is not inferred from assignment, presence, or session length.',
  'Day-end userId limits consultancies assigned to that CRM user at the reporting day end. actorId limits rows to the recorded event actor.',
  'Exception rows carry exceptionReason and severity from stored facts only. They are not a productivity score.',
  'Completion rate is completed rows divided by follow-ups scheduled in the window. Cancelled rows are excluded. No scheduled rows means no rate.',
  'Recorded admission events are not an admission outcome or a conversion rate.',
  'An omitted timezone is UTC. Asia/Kolkata is used only when the caller sends it.',
]);

const METRICS = Object.freeze([
  {
    id: 'overdue-now',
    formula: 'Open follow-up rows whose scheduledAt is before the report time.',
    scope: 'Totals and record lists are organization-wide when the caller has crm.roles.manage. Otherwise both stay inside the caller\'s assigned consultancies.',
    denominator: 'Not a rate.',
    window: 'Current. The report time is the server time of the request.',
    limitations: 'A missing scheduledAt is unscheduled, not overdue. nextFollowUpAt on the consultancy is not used.',
  },
  {
    id: 'due-today',
    formula: 'Open follow-up rows whose scheduledAt is still inside today and not before the report time.',
    scope: 'Same as overdue now.',
    denominator: 'Not a rate.',
    window: 'The caller timezone\'s current calendar day. Omitted timezone means UTC.',
    limitations: 'A row already past its scheduled time is overdue, not due today.',
  },
  {
    id: 'upcoming',
    formula: 'Open follow-up rows whose scheduledAt is after the end of today.',
    scope: 'Same as overdue now.',
    denominator: 'Not a rate.',
    window: 'After the caller timezone\'s current calendar day.',
    limitations: 'No scheduledAt means the row is not upcoming.',
  },
  {
    id: 'completion-rate',
    formula: 'Follow-ups scheduled in the window that now have completedAt, divided by follow-ups scheduled in the window.',
    scope: 'Same assignment rule. A shared consultancy cohort is repeated for every current assignee.',
    denominator: 'Follow-ups with scheduledAt inside the window and no cancelledAt. Zero scheduled rows produce no rate.',
    window: 'The selected from and to dates in the caller timezone.',
    limitations: 'This is not a staff ranking and does not credit the earliest assignee.',
  },
  {
    id: 'outstanding-day',
    formula: 'Follow-up rows created before the day ended, in an open status (Meeting Scheduled or Follow-up Required), and not completed or cancelled by that time. Overdue compares the schedule as of the day end with the day end.',
    scope: 'Same as overdue now. A user filter uses assignment rows open at the day end.',
    denominator: 'Not a rate.',
    window: 'The selected reporting day, through 23:59:59.999 in the caller timezone.',
    limitations: 'Approximate. No end-of-day snapshot is stored. Status uses the current value. The schedule at day end is rebuilt from follow-up update audits; rows rescheduled before those audits existed are counted as schedule unknown. A missing row is not reconstructed.',
  },
  {
    id: 'assigned-workload',
    formula: 'Active assignment rows for each CRM user. Open and overdue follow-ups on those consultancies are counted for every current assignee.',
    scope: 'Every CRM user for crm.roles.manage. Other callers see users on their assigned consultancies.',
    denominator: 'Completion rate uses the scheduled-follow-up cohort above.',
    window: 'Assignments are current. Follow-up completion and admission events use the selected range.',
    limitations: 'Not work performed. Presence, sign-in, and session length are excluded. Staff are not ranked by volume.',
  },
  {
    id: 'admissions-recorded',
    formula: 'student.created audits plus student.updated audits whose recorded admission status changed.',
    scope: 'Attributed to actorCrmUserId. Platform-admin actors stay outside the CRM staff rows.',
    denominator: 'Not a rate. No cohort outcome is calculated.',
    window: 'The selected range.',
    limitations: 'A student with no audit is omitted. This is not a conversion rate.',
  },
]);

function moduleAggregates(actor) {
  return Boolean(
    actor
    && actor.actorType === 'crm-user'
    && Array.isArray(actor.permissions)
    && actor.permissions.includes('crm.roles.manage')
  );
}

function assertKeys(query, allowed, label) {
  Object.keys(query || {}).forEach((key) => {
    if (!allowed.includes(key)) {
      throw new CrmError(400, `${key} is not a supported ${label} filter.`, 'unsupported_filter');
    }
  });
}

function parseRange(query) {
  const from = query.from == null ? '' : String(query.from).trim();
  const to = query.to == null ? '' : String(query.to).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new CrmError(400, 'from and to must be YYYY-MM-DD dates.', 'invalid_query');
  }
  return resolveAnalyticsRange({ period: 'custom', from, to, timeZone: query.timeZone });
}

function parseDay(query) {
  const date = query.date == null ? '' : String(query.date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CrmError(400, 'date must be a YYYY-MM-DD reporting day.', 'invalid_query');
  }
  return resolveAnalyticsRange({ period: 'custom', from: date, to: date, timeZone: query.timeZone });
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

function statusChanged(row) {
  if (row.action === 'student.created') return { kind: 'initial', next: recordedStatus(row.after) };
  if (row.action !== 'student.updated') return null;
  const previous = recordedStatus(row.before);
  const next = recordedStatus(row.after);
  if (previous === undefined || next === undefined || previous === next) return null;
  return { kind: 'transition', previous, next };
}

function isOpen(row) {
  return Boolean(
    row.scheduledAt
    && !row.completedAt
    && !row.cancelledAt
    && OPEN_FOLLOW_UP_STATUSES.includes(row.status)
  );
}

function isUnscheduledOpen(row) {
  return Boolean(
    !row.scheduledAt
    && !row.completedAt
    && !row.cancelledAt
    && OPEN_FOLLOW_UP_STATUSES.includes(row.status)
  );
}

function bucketOf(row, now, todayEnd) {
  if (isUnscheduledOpen(row)) return 'unscheduled';
  if (!isOpen(row)) return null;
  const when = new Date(row.scheduledAt).getTime();
  if (when < now.getTime()) return 'overdue';
  if (when <= todayEnd.getTime()) return 'due_today';
  return 'upcoming';
}

// A follow-up's status is fixed when the row is recorded. Only the open statuses
// are commitments; every other status is a recorded outcome and is never outstanding.
function wasOutstanding(row, dayEnd) {
  if (!OPEN_FOLLOW_UP_STATUSES.includes(row.status)) return false;
  if (!row.createdAt || new Date(row.createdAt).getTime() > dayEnd.getTime()) return false;
  if (row.completedAt && new Date(row.completedAt).getTime() <= dayEnd.getTime()) return false;
  if (row.cancelledAt && new Date(row.cancelledAt).getTime() <= dayEnd.getTime()) return false;
  return true;
}

function hasKey(value, key) {
  return Boolean(value) && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function asDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// The scheduled time a row had at dayEnd. Later edits only change the stored row,
// so recorded follow_up_updated audits are used to recover the earlier value.
// Legacy audits stored only the value after the edit, so some rows stay unknown.
function scheduledAtAsOf(row, dayEnd, updates) {
  const list = (updates && updates.get(String(row._id))) || [];
  const cutoff = dayEnd.getTime();
  const earlier = list.filter((audit) => new Date(audit.createdAt).getTime() <= cutoff);
  const later = list.filter((audit) => new Date(audit.createdAt).getTime() > cutoff);
  if (!later.length) return { value: asDate(row.scheduledAt), known: true, rescheduledLater: false };
  const lastEarlier = earlier[earlier.length - 1];
  if (lastEarlier && hasKey(lastEarlier.after, 'scheduledAt')) {
    return { value: asDate(lastEarlier.after.scheduledAt), known: true, rescheduledLater: true };
  }
  if (hasKey(later[0].before, 'scheduledAt')) {
    return { value: asDate(later[0].before.scheduledAt), known: true, rescheduledLater: true };
  }
  return { value: asDate(row.scheduledAt), known: false, rescheduledLater: true };
}

function wasOverdue(row, dayEnd, updates) {
  if (!wasOutstanding(row, dayEnd)) return false;
  const scheduled = scheduledAtAsOf(row, dayEnd, updates).value;
  if (!scheduled) return false;
  return scheduled.getTime() <= dayEnd.getTime();
}

async function loadScheduleUpdates(rows) {
  const open = rows.filter((row) => OPEN_FOLLOW_UP_STATUSES.includes(row.status));
  if (!open.length) return new Map();
  const consultancyIds = [...new Set(open.map((row) => String(row.consultancyId)))];
  const audits = await CrmAuditLog.find({
    entityType: 'consultancy',
    entityId: { $in: consultancyIds },
    action: 'consultancy.follow_up_updated',
    'after.followUpId': { $in: open.map((row) => String(row._id)) },
  }).sort({ createdAt: 1, _id: 1 }).select('createdAt before after').lean();
  const updates = new Map();
  audits.forEach((audit) => {
    const key = String(audit.after.followUpId);
    if (!updates.has(key)) updates.set(key, []);
    updates.get(key).push(audit);
  });
  return updates;
}

function inWindow(value, start, end) {
  if (!value) return false;
  const when = new Date(value).getTime();
  return when >= start.getTime() && when <= end.getTime();
}

function completionCohort(rows, start, end) {
  const cohort = rows.filter((row) => row.scheduledAt && !row.cancelledAt && inWindow(row.scheduledAt, start, end));
  if (!cohort.length) return { denominator: 0, numerator: 0, rate: null };
  const numerator = cohort.filter((row) => row.completedAt).length;
  return { denominator: cohort.length, numerator, rate: numerator / cohort.length };
}

function pageSlice(items, page, limit) {
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
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
  const assigned = await reportingConsultancyIds(actor);
  if (!consultancyId) return { consultancyIds: assigned, constrained: false };
  const selected = String(consultancyId);
  if (assigned != null && !assigned.some((id) => String(id) === selected)) {
    throw new CrmError(404, 'Consultancy not found.', 'not_found');
  }
  return {
    consultancyIds: [new mongoose.Types.ObjectId(selected)],
    constrained: true,
  };
}

// Organization-wide readers still get module totals when unfiltered.
// A consultancyId filter must constrain totals and lists the same way.
function aggregateIds(actor, listIds, constrained = false) {
  if (constrained) return listIds;
  if (listIds == null || moduleAggregates(actor)) return null;
  return listIds;
}

async function activeAssignedIds(userId) {
  return CrmConsultancyAssignment.find({ crmUserId: userId, revokedAt: null }).distinct('consultancyId');
}

function intersectIds(scopeIds, selectedIds) {
  if (scopeIds == null) return selectedIds;
  const allowed = new Set(selectedIds.map((id) => String(id)));
  return scopeIds.filter((id) => allowed.has(String(id)));
}

function consultancyFilter(ids) {
  if (ids == null) return {};
  return { consultancyId: { $in: ids } };
}

async function loadFollowUps(ids) {
  const rows = await CrmConsultancyFollowUp.find(consultancyFilter(ids))
    .sort({ createdAt: -1, _id: -1 })
    .limit(SOURCE_CAP + 1)
    .lean();
  return { rows: rows.slice(0, SOURCE_CAP), truncated: rows.length > SOURCE_CAP };
}

async function consultancyNames(ids) {
  if (!ids.length) return new Map();
  const rows = await CrmConsultancy.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(rows.map((row) => [String(row._id), row.name || '']));
}

function countBuckets(rows, now, todayEnd) {
  const counts = { overdue: 0, dueToday: 0, upcoming: 0, unscheduled: 0 };
  rows.forEach((row) => {
    const bucket = bucketOf(row, now, todayEnd);
    if (bucket === 'overdue') counts.overdue += 1;
    if (bucket === 'due_today') counts.dueToday += 1;
    if (bucket === 'upcoming') counts.upcoming += 1;
    if (bucket === 'unscheduled') counts.unscheduled += 1;
  });
  return counts;
}

function completionTrend(rows, range) {
  const counts = new Map();
  rows.forEach((row) => {
    if (!inWindow(row.completedAt, range.start, range.end)) return;
    const day = calendarDayKey(row.completedAt, range.timeZone);
    counts.set(day, (counts.get(day) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([day, count]) => ({ day, count, exact: true }));
}

function approximateOverdueTrend(rows, range, updates) {
  if (!rows.length) return [];
  const points = [];
  let cursor = range.from;
  while (cursor && cursor <= range.to) {
    const day = resolveAnalyticsRange({ period: 'custom', from: cursor, to: cursor, timeZone: range.timeZone });
    const count = rows.filter((row) => wasOverdue(row, day.end, updates)).length;
    if (count > 0) points.push({ day: cursor, count, exact: false });
    const next = shiftDateKey(cursor, 1);
    if (next === cursor) break;
    cursor = next;
  }
  return points;
}

function basePayload(listScope, aggregateScope, range, actor) {
  const recordScope = listScope.consultancyIds == null ? 'module' : 'assigned';
  return {
    generatedAt: new Date(),
    scope: recordScope,
    recordScope: listScope.constrained ? 'consultancy' : recordScope,
    aggregateScope,
    scopeBasis: reportingScopeBasis(actor),
    timeZone: range.timeZone,
    timeZoneConfirmed: false,
    excluded: ['presence', 'working time', 'productivity', 'staff ranking', 'conversion'],
    limitations: COVERAGE,
    metrics: METRICS,
  };
}

async function listFollowUpIntelligence(actor, query, now = new Date()) {
  assertKeys(query, FOLLOW_UP_KEYS, 'follow-up');
  const { page, limit } = parsePageLimit(query);
  const range = parseRange(query);
  const bucket = query.bucket == null || query.bucket === '' ? '' : String(query.bucket);
  if (bucket && !BUCKETS.includes(bucket)) {
    throw new CrmError(400, 'bucket must be overdue, due_today, upcoming, unscheduled, completed, or cancelled.', 'invalid_query');
  }
  const userId = optionalId(query, 'userId', 'User id');
  const consultancyId = optionalId(query, 'consultancyId', 'Consultancy id');
  const listScope = await resolveListScope(actor, consultancyId);
  const wideIds = aggregateIds(actor, listScope.consultancyIds, listScope.constrained);
  const userAssignments = userId ? await activeAssignedIds(userId) : null;
  const totalIds = userAssignments ? intersectIds(wideIds, userAssignments) : wideIds;
  const itemIds = userAssignments ? intersectIds(listScope.consultancyIds, userAssignments) : listScope.consultancyIds;
  const today = resolveAnalyticsRange({
    period: 'custom',
    from: calendarDayKey(now, range.timeZone),
    to: calendarDayKey(now, range.timeZone),
    timeZone: range.timeZone,
  });
  const [totals, listed] = await Promise.all([loadFollowUps(totalIds), loadFollowUps(itemIds)]);
  const current = countBuckets(totals.rows, now, today.end);
  const completedInRange = totals.rows.filter((row) => inWindow(row.completedAt, range.start, range.end)).length;
  const cancelledInRange = totals.rows.filter((row) => inWindow(row.cancelledAt, range.start, range.end)).length;
  const completion = completionCohort(totals.rows, range.start, range.end);
  const previousWindow = previousBounds(range);
  const previous = previousWindow ? completionCohort(totals.rows, previousWindow.start, previousWindow.end) : null;
  const previousCompletions = previousWindow
    ? totals.rows.filter((row) => inWindow(row.completedAt, previousWindow.start, previousWindow.end)).length
    : null;
  const wanted = listed.rows.filter((row) => {
    if (!bucket) return bucketOf(row, now, today.end) === 'overdue' || bucketOf(row, now, today.end) === 'due_today' || bucketOf(row, now, today.end) === 'upcoming';
    if (bucket === 'completed') return inWindow(row.completedAt, range.start, range.end);
    if (bucket === 'cancelled') return inWindow(row.cancelledAt, range.start, range.end);
    return bucketOf(row, now, today.end) === bucket;
  });
  wanted.sort((left, right) => new Date(right.scheduledAt || right.createdAt) - new Date(left.scheduledAt || left.createdAt));
  const pageItems = pageSlice(wanted, page, limit);
  const names = await consultancyNames(pageItems.map((row) => row.consultancyId));
  const actorNames = await namesFor(pageItems.flatMap((row) => [
    storedActor(row.createdByCrmUserId, row.createdByAdminId),
    storedActor(row.completedByCrmUserId, row.completedByAdminId),
  ]));
  const aggregateScope = listScope.constrained ? 'consultancy' : (wideIds == null ? 'module' : 'assigned');
  return {
    ...basePayload(listScope, aggregateScope, range, actor),
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    comparison: previousWindow ? {
      start: previousWindow.start,
      end: previousWindow.end,
      alignedToCalendar: false,
      completions: previousCompletions,
      completion: previous,
    } : null,
    current: {
      ...current,
      completedInRange,
      cancelledInRange,
      completion,
    },
    completionTrend: completionTrend(totals.rows, range),
    overdueApproximation: approximateOverdueTrend(totals.rows, range, await loadScheduleUpdates(totals.rows)),
    truncated: totals.truncated || listed.truncated,
    page,
    limit,
    total: wanted.length,
    items: pageItems.map((row) => ({
      id: String(row._id),
      source: 'crmConsultancyFollowUps',
      consultancyId: String(row.consultancyId),
      consultancyName: names.get(String(row.consultancyId)) || '',
      status: row.status,
      bucket: bucketOf(row, now, today.end),
      scheduledAt: row.scheduledAt || null,
      completedAt: row.completedAt || null,
      cancelledAt: row.cancelledAt || null,
      createdAt: row.createdAt,
      createdBy: named(storedActor(row.createdByCrmUserId, row.createdByAdminId), actorNames),
      completedBy: named(storedActor(row.completedByCrmUserId, row.completedByAdminId), actorNames),
    })),
  };
}

async function assignmentIdsAt(userId, dayEnd, scopeIds) {
  const filter = {
    crmUserId: userId,
    createdAt: { $lte: dayEnd },
    $or: [{ revokedAt: null }, { revokedAt: { $gt: dayEnd } }],
  };
  if (scopeIds) filter.consultancyId = { $in: scopeIds };
  return CrmConsultancyAssignment.find(filter).distinct('consultancyId');
}

async function loadAudits(ids, range) {
  const scope = await businessAuditScope(ids);
  const rows = await CrmAuditLog.find({
    ...scope,
    createdAt: { $gte: range.start, $lte: range.end },
    action: { $in: ['student.created', 'student.updated'] },
  }).sort({ createdAt: -1, _id: -1 }).limit(SOURCE_CAP + 1).lean();
  return { rows: rows.slice(0, SOURCE_CAP), truncated: rows.length > SOURCE_CAP };
}

function admissionFacts(rows) {
  const facts = [];
  rows.forEach((row) => {
    const change = statusChanged(row);
    if (!change) return;
    facts.push({
      id: String(row._id),
      source: 'crmAuditLogs',
      kind: change.kind === 'initial' ? 'student.created' : 'admission.changed',
      at: row.createdAt,
      previousStatus: change.previous || null,
      nextStatus: change.next || null,
      studentId: String(row.entityId),
      actor: storedActor(row.actorCrmUserId, row.actorAdminId),
      exception: change.next === 'Not proceeding',
      exceptionReason: change.next === 'Not proceeding' ? 'not_proceeding' : null,
      severity: change.next === 'Not proceeding' ? 'high' : null,
    });
  });
  return facts;
}

function approximateEnd(rows) {
  const notes = {
    openStatuses: OPEN_FOLLOW_UP_STATUSES,
    rescheduledLater: rows.rescheduledLater || 0,
    scheduleUnknown: rows.scheduleUnknown || 0,
  };
  if (!rows.examined || rows.truncated) {
    return {
      outstanding: { count: null, exact: false, ...notes },
      overdue: { count: null, exact: false, ...notes },
    };
  }
  return {
    outstanding: { count: rows.outstanding, exact: false, ...notes },
    overdue: { count: rows.overdue, exact: false, ...notes },
  };
}

async function endState(ids, dayEnd) {
  const any = await CrmConsultancyFollowUp.countDocuments(consultancyFilter(ids));
  if (!any) return { examined: false, outstanding: null, overdue: null, rows: [] };
  const rows = await CrmConsultancyFollowUp.find({
    ...consultancyFilter(ids),
    status: { $in: OPEN_FOLLOW_UP_STATUSES },
    createdAt: { $lte: dayEnd },
    $and: [
      { $or: [{ completedAt: null }, { completedAt: { $gt: dayEnd } }] },
      { $or: [{ cancelledAt: null }, { cancelledAt: { $gt: dayEnd } }] },
    ],
  }).sort({ createdAt: 1, _id: 1 }).limit(SOURCE_CAP + 1).lean();
  const kept = rows.slice(0, SOURCE_CAP).filter((row) => wasOutstanding(row, dayEnd));
  const updates = await loadScheduleUpdates(kept);
  const schedules = new Map(kept.map((row) => [String(row._id), scheduledAtAsOf(row, dayEnd, updates)]));
  return {
    examined: true,
    truncated: rows.length > SOURCE_CAP,
    outstanding: kept.length,
    overdue: kept.filter((row) => wasOverdue(row, dayEnd, updates)).length,
    rescheduledLater: [...schedules.values()].filter((item) => item.rescheduledLater).length,
    scheduleUnknown: [...schedules.values()].filter((item) => !item.known).length,
    rows: kept,
    updates,
    schedules,
  };
}

async function listDayEndReport(actor, query) {
  assertKeys(query, DAY_KEYS, 'day-end');
  const { page, limit } = parsePageLimit(query);
  const range = parseDay(query);
  const event = query.event == null || query.event === '' ? '' : String(query.event);
  if (event && !EVENTS.includes(event)) {
    throw new CrmError(400, 'event must be admission, assignment, follow_up, or exception.', 'invalid_query');
  }
  const userId = optionalId(query, 'userId', 'User id');
  const actorId = optionalId(query, 'actorId', 'Actor id');
  const consultancyId = optionalId(query, 'consultancyId', 'Consultancy id');
  const listScope = await resolveListScope(actor, consultancyId);
  const wideIds = aggregateIds(actor, listScope.consultancyIds, listScope.constrained);
  const totalIds = userId ? await assignmentIdsAt(userId, range.end, wideIds) : wideIds;
  const itemIds = userId ? await assignmentIdsAt(userId, range.end, listScope.consultancyIds) : listScope.consultancyIds;
  const [totalAudits, listAudits, totalFollowUps, listFollowUpsRaw, totalEnd, listEnd, opened, revoked, listOpened, listRevoked] = await Promise.all([
    loadAudits(totalIds, range),
    loadAudits(itemIds, range),
    CrmConsultancyFollowUp.find({ ...consultancyFilter(totalIds), createdAt: { $gte: range.start, $lte: range.end } }).limit(SOURCE_CAP + 1).lean(),
    CrmConsultancyFollowUp.find({ ...consultancyFilter(itemIds), createdAt: { $gte: range.start, $lte: range.end } }).limit(SOURCE_CAP + 1).lean(),
    endState(totalIds, range.end),
    endState(itemIds, range.end),
    CrmConsultancyAssignment.find({ ...consultancyFilter(totalIds), createdAt: { $gte: range.start, $lte: range.end } }).lean(),
    CrmConsultancyAssignment.find({ ...consultancyFilter(totalIds), revokedAt: { $gte: range.start, $lte: range.end } }).lean(),
    CrmConsultancyAssignment.find({ ...consultancyFilter(itemIds), createdAt: { $gte: range.start, $lte: range.end } }).lean(),
    CrmConsultancyAssignment.find({ ...consultancyFilter(itemIds), revokedAt: { $gte: range.start, $lte: range.end } }).lean(),
  ]);
  const listFollowUps = listFollowUpsRaw.slice(0, SOURCE_CAP);
  const due = await CrmConsultancyFollowUp.find({
    ...consultancyFilter(totalIds),
    scheduledAt: { $gte: range.start, $lte: range.end },
  }).lean();
  const completed = await CrmConsultancyFollowUp.find({
    ...consultancyFilter(totalIds),
    completedAt: { $gte: range.start, $lte: range.end },
  }).lean();
  const cancelled = await CrmConsultancyFollowUp.find({
    ...consultancyFilter(totalIds),
    cancelledAt: { $gte: range.start, $lte: range.end },
  }).lean();
  const admissions = admissionFacts(totalAudits.rows);
  const summary = {
    // Truncated audit scans must not present understated admission KPIs as complete counts.
    studentsCreated: totalAudits.truncated
      ? null
      : admissions.filter((row) => row.kind === 'student.created').length,
    admissionChanges: totalAudits.truncated
      ? null
      : admissions.filter((row) => row.kind === 'admission.changed').length,
    assignmentsOpened: opened.length,
    assignmentsRevoked: revoked.length,
    followUpsCreated: totalFollowUps.length > SOURCE_CAP ? null : totalFollowUps.length,
    followUpsDue: due.length,
    followUpsCompleted: completed.length,
    followUpsCancelled: cancelled.length,
    ...approximateEnd(totalEnd),
  };
  const listAdmissions = admissionFacts(listAudits.rows);
  const items = [];
  listAdmissions.forEach((row) => items.push(row));
  listOpened.forEach((row) => items.push({
    id: String(row._id),
    source: 'crmConsultancyAssignments',
    kind: 'assignment.opened',
    at: row.createdAt,
    consultancyId: String(row.consultancyId),
    userId: String(row.crmUserId),
    actor: storedActor(row.createdByCrmUserId, row.createdByAdminId),
  }));
  listRevoked.forEach((row) => items.push({
    id: `${row._id}:revoked`,
    source: 'crmConsultancyAssignments',
    kind: 'assignment.revoked',
    at: row.revokedAt,
    consultancyId: String(row.consultancyId),
    userId: String(row.crmUserId),
    actor: storedActor(row.revokedByCrmUserId, row.revokedByAdminId),
    exception: true,
    exceptionReason: 'assignment_revoked',
    severity: 'medium',
  }));
  listFollowUps.forEach((row) => items.push({
    id: String(row._id),
    source: 'crmConsultancyFollowUps',
    kind: 'follow_up.created',
    at: row.createdAt,
    consultancyId: String(row.consultancyId),
    status: row.status || null,
    outcome: row.outcome || '',
    nextAction: row.nextAction || '',
    actor: storedActor(row.createdByCrmUserId, row.createdByAdminId),
  }));
  (listEnd.rows || []).forEach((row) => {
    const schedule = listEnd.schedules.get(String(row._id));
    items.push({
      id: `${row._id}:outstanding`,
      source: 'crmConsultancyFollowUps',
      kind: wasOverdue(row, range.end, listEnd.updates) ? 'follow_up.overdue_approximate' : 'follow_up.outstanding_approximate',
      at: (schedule && schedule.value) || row.createdAt,
      consultancyId: String(row.consultancyId),
      status: row.status,
      outcome: row.outcome || '',
      nextAction: row.nextAction || '',
      exact: false,
      scheduleKnown: schedule ? schedule.known : true,
      rescheduledLater: schedule ? schedule.rescheduledLater : false,
      actor: storedActor(row.createdByCrmUserId, row.createdByAdminId),
    });
  });
  completed.filter((row) => !itemIds || itemIds.some((id) => String(id) === String(row.consultancyId))).forEach((row) => {
    const late = Boolean(row.scheduledAt && new Date(row.completedAt).getTime() > new Date(row.scheduledAt).getTime());
    items.push({
      id: `${row._id}:completed`,
      source: 'crmConsultancyFollowUps',
      kind: 'follow_up.completed',
      at: row.completedAt,
      consultancyId: String(row.consultancyId),
      status: row.status || null,
      outcome: row.outcome || '',
      nextAction: row.nextAction || '',
      actor: storedActor(row.completedByCrmUserId, row.completedByAdminId),
      exception: late,
      exceptionReason: late ? 'completed_after_schedule' : null,
      severity: late ? 'medium' : null,
    });
  });
  cancelled.filter((row) => !itemIds || itemIds.some((id) => String(id) === String(row.consultancyId))).forEach((row) => {
    items.push({
      id: `${row._id}:cancelled`,
      source: 'crmConsultancyFollowUps',
      kind: 'follow_up.cancelled',
      at: row.cancelledAt,
      consultancyId: String(row.consultancyId),
      status: row.status || null,
      outcome: row.outcome || '',
      nextAction: row.nextAction || '',
      actor: storedActor(row.cancelledByCrmUserId, row.cancelledByAdminId),
      exception: true,
      exceptionReason: 'follow_up_cancelled',
      severity: 'medium',
    });
  });
  const filtered = items.filter((row) => {
    if (actorId && (!row.actor || String(row.actor.id) !== String(actorId))) return false;
    if (!event) return true;
    if (event === 'admission') return row.kind === 'student.created' || row.kind === 'admission.changed';
    if (event === 'assignment') return row.kind.startsWith('assignment.');
    if (event === 'follow_up') return row.kind.startsWith('follow_up.');
    return row.exception === true || (row.kind === 'admission.changed' && row.nextStatus === 'Not proceeding');
  });
  filtered.sort((left, right) => new Date(right.at) - new Date(left.at) || String(left.id).localeCompare(String(right.id)));
  const pageItems = pageSlice(filtered, page, limit);
  const names = await consultancyNames(pageItems.map((row) => row.consultancyId).filter(Boolean));
  const studentIds = pageItems.map((row) => row.studentId).filter(Boolean);
  const students = studentIds.length
    ? await CrmStudent.find({ _id: { $in: studentIds } }).select('fullName').lean()
    : [];
  const studentNames = new Map(students.map((row) => [String(row._id), row.fullName || '']));
  const actorNames = await namesFor(pageItems.map((row) => row.actor));
  const aggregateScope = listScope.constrained ? 'consultancy' : (wideIds == null ? 'module' : 'assigned');
  return {
    ...basePayload(listScope, aggregateScope, range, actor),
    date: range.from,
    exactSnapshot: false,
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    summary,
    truncated: Boolean(
      totalAudits.truncated
      || listAudits.truncated
      || totalEnd.truncated
      || totalFollowUps.length > SOURCE_CAP
      || listFollowUpsRaw.length > SOURCE_CAP
    ),
    filters: {
      userIdMeaning: 'Consultancies assigned to this CRM user at the reporting day end. Not the actor who recorded each event.',
      actorIdMeaning: 'Recorded actor on the event. Independent of assignment scope.',
    },
    page,
    limit,
    total: filtered.length,
    items: pageItems.map((row) => ({
      ...row,
      consultancyName: row.consultancyId ? (names.get(String(row.consultancyId)) || '') : '',
      studentName: row.studentId ? (studentNames.get(row.studentId) || '') : '',
      actor: named(row.actor, actorNames),
    })),
  };
}

async function listWorkload(actor, query, now = new Date()) {
  assertKeys(query, WORKLOAD_KEYS, 'workload');
  const { page, limit } = parsePageLimit(query);
  const range = parseRange(query);
  const userId = optionalId(query, 'userId', 'User id');
  const consultancyId = optionalId(query, 'consultancyId', 'Consultancy id');
  const listScope = await resolveListScope(actor, consultancyId);
  const wideIds = aggregateIds(actor, listScope.consultancyIds, listScope.constrained);
  const scopeIds = wideIds == null ? null : wideIds;
  const assignmentFilter = { revokedAt: null, ...consultancyFilter(scopeIds) };
  if (userId) assignmentFilter.crmUserId = userId;
  const assignments = await CrmConsultancyAssignment.find(assignmentFilter).select('crmUserId consultancyId').lean();
  const byUser = new Map();
  assignments.forEach((row) => {
    const key = String(row.crmUserId);
    if (!byUser.has(key)) byUser.set(key, new Set());
    byUser.get(key).add(String(row.consultancyId));
  });
  const { rows: followUps, truncated } = await loadFollowUps(scopeIds);
  const today = resolveAnalyticsRange({
    period: 'custom',
    from: calendarDayKey(now, range.timeZone),
    to: calendarDayKey(now, range.timeZone),
    timeZone: range.timeZone,
  });
  const audits = await loadAudits(scopeIds, range);
  const admissionByActor = new Map();
  admissionFacts(audits.rows).forEach((row) => {
    if (!row.actor || row.actor.type !== 'crm-user') return;
    admissionByActor.set(row.actor.id, (admissionByActor.get(row.actor.id) || 0) + 1);
    if (!byUser.has(row.actor.id)) byUser.set(row.actor.id, new Set());
  });
  const users = byUser.size
    ? await CrmUser.find({ _id: { $in: [...byUser.keys()] } }).select('fullName').lean()
    : [];
  const userNames = new Map(users.map((row) => [String(row._id), row.fullName || '']));
  const staff = [...byUser.entries()].map(([id, consultancies]) => {
    const owned = followUps.filter((row) => consultancies.has(String(row.consultancyId)));
    const completion = completionCohort(owned, range.start, range.end);
    return {
      userId: id,
      name: userNames.get(id) || '',
      assignedConsultancies: consultancies.size,
      openFollowUps: owned.filter((row) => isOpen(row)).length,
      overdueFollowUps: owned.filter((row) => bucketOf(row, now, today.end) === 'overdue').length,
      admissionsRecorded: admissionByActor.get(id) || 0,
      followUpsCompleted: owned.filter((row) => row.completedByCrmUserId && String(row.completedByCrmUserId) === id && inWindow(row.completedAt, range.start, range.end)).length,
      completion,
    };
  });
  staff.sort((left, right) => left.name.localeCompare(right.name) || left.userId.localeCompare(right.userId));
  const pageItems = pageSlice(staff, page, limit);
  const aggregateScope = listScope.constrained ? 'consultancy' : (wideIds == null ? 'module' : 'assigned');
  return {
    ...basePayload(listScope, aggregateScope, range, actor),
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    ranked: false,
    truncated: truncated || audits.truncated,
    page,
    limit,
    total: staff.length,
    items: pageItems,
  };
}

module.exports = {
  listFollowUpIntelligence,
  listDayEndReport,
  listWorkload,
  bucketOf,
  wasOverdue,
  completionCohort,
  setSourceCapForTests,
};
