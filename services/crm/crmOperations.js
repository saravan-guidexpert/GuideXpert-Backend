'use strict';

const mongoose = require('mongoose');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmReferral = require('../../models/CrmReferral');
const CrmStudent = require('../../models/CrmStudent');
const CrmUser = require('../../models/CrmUser');
const { ADMISSION_STATUSES, CONSULTANCY_STATUS } = require('../../constants/crm');
const { PRESENCE_ONLINE_MS } = require('../../constants/crmPresence');
const { CRM_ACCESS_SECTION } = require('../../constants/crmUsers');
const { CrmError } = require('../../utils/crmError');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { previousBounds, resolveAnalyticsRange } = require('../../utils/crmRange');
const { referralVolume, statusCounts } = require('./analyticsService');
const { activityScope, canViewAccountSecurity } = require('./activityService');
const { assignedConsultancyIds } = require('./crmAccess');

const OVERVIEW_KEYS = Object.freeze(['page', 'limit', 'status', 'assignment', 'consultancyId']);
const OPERATION_KEYS = Object.freeze(['page', 'limit', 'period', 'from', 'to', 'timeZone', 'consultancyId']);
const LIMITATIONS = Object.freeze([
  'Admission status is the current value on the student. Earlier statuses are not stored.',
  'Consultancy pipeline is stored on the consultancy, separate from record status and calling status. Operations totals do not include that stage.',
  'Referral and student links use the referral\'s current consultancy, not the original source.',
  'A student with no referral is omitted from assignment-scoped totals. Module admission rows include those students at their current status.',
  'A missing or unknown admission status is displayed as Not started and is not written back.',
]);

function assertKeys(query, allowed, label) {
  Object.keys(query || {}).forEach((key) => {
    if (!allowed.includes(key)) {
      throw new CrmError(400, `${key} is not a supported ${label} filter.`, 'unsupported_filter');
    }
  });
}

function canViewModuleAggregates(actor) {
  return Boolean(
    actor
    && actor.actorType === 'crm-user'
    && Array.isArray(actor.permissions)
    && actor.permissions.includes('crm.roles.manage')
  );
}

function canViewPresence(actor) {
  if (!actor) return false;
  if (actor.actorType === 'crm-user') {
    return Array.isArray(actor.permissions) && actor.permissions.includes('crm.roles.manage');
  }
  if (actor.actorType === 'admin') {
    if (actor.isSuperAdmin === true) return true;
    return Array.isArray(actor.sectionAccess) && actor.sectionAccess.includes(CRM_ACCESS_SECTION);
  }
  return false;
}

function displayedAdmission(value) {
  return ADMISSION_STATUSES.includes(value) ? value : 'Not started';
}

async function statusesWithoutReferral() {
  const rows = await CrmStudent.aggregate([
    { $match: { deletedAt: null } },
    {
      $lookup: {
        from: 'crmReferrals',
        localField: '_id',
        foreignField: 'crmStudentId',
        as: 'referral',
      },
    },
    { $match: { referral: { $size: 0 } } },
    { $group: { _id: '$admissionStatus', count: { $sum: 1 } } },
  ]);
  const counts = new Map();
  rows.forEach((row) => {
    const status = displayedAdmission(row._id);
    counts.set(status, (counts.get(status) || 0) + row.count);
  });
  return counts;
}

async function resolveScope(actor, consultancyId) {
  const assigned = await assignedConsultancyIds(actor);
  if (!consultancyId) return { ids: assigned, moduleWide: assigned == null, constrained: false };
  const parsed = parseObjectId(consultancyId, 'Consultancy id');
  if (assigned != null && !assigned.some((id) => String(id) === String(parsed))) {
    throw new CrmError(404, 'Consultancy not found.', 'not_found');
  }
  const consultancy = await CrmConsultancy.findOne({ _id: parsed, deletedAt: null }).select('_id').lean();
  if (!consultancy) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  return { ids: [parsed], moduleWide: false, constrained: true };
}

function referralMatch(ids, range) {
  const match = {};
  if (ids) match.consultancyId = { $in: ids };
  if (range && range.start && range.end) match.referredAt = { $gte: range.start, $lte: range.end };
  return match;
}

function emptyAdmission() {
  return ADMISSION_STATUSES.map((status) => ({ status, count: 0 }));
}

async function presenceTotals() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - PRESENCE_ONLINE_MS);
  const rows = await CrmUser.aggregate([
    { $match: { deletedAt: null } },
    {
      $lookup: {
        from: 'crmSessions',
        let: { uid: '$_id', version: '$sessionVersion' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$userId', '$$uid'] },
                  { $eq: [{ $ifNull: ['$revokedAt', null] }, null] },
                  { $gt: ['$expiresAt', now] },
                  { $eq: ['$sessionVersion', '$$version'] },
                ],
              },
            },
          },
          { $project: { lastSeenAt: 1 } },
        ],
        as: 'openSessions',
      },
    },
    {
      $project: {
        status: 1,
        openCount: { $size: '$openSessions' },
        recent: {
          $size: {
            $filter: {
              input: '$openSessions',
              as: 'session',
              cond: {
                $and: [
                  { $ne: ['$$session.lastSeenAt', null] },
                  { $gte: ['$$session.lastSeenAt', cutoff] },
                ],
              },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        online: {
          $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$recent', 0] }] }, 1, 0] },
        },
        idle: {
          $sum: {
            $cond: [{
              $and: [
                { $eq: ['$status', 'active'] },
                { $gt: ['$openCount', 0] },
                { $eq: ['$recent', 0] },
              ],
            }, 1, 0],
          },
        },
        offline: {
          $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $eq: ['$openCount', 0] }] }, 1, 0] },
        },
        inactive: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } },
        invited: { $sum: { $cond: [{ $eq: ['$status', 'invited'] }, 1, 0] } },
        activeAccounts: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      },
    },
  ]);
  const row = rows[0] || { online: 0, idle: 0, offline: 0, inactive: 0, invited: 0, activeAccounts: 0 };
  return {
    meaning: 'current account and session state, not events in the selected period and not working time',
    scope: 'all_crm_accounts',
    online: row.online,
    idle: row.idle,
    offline: row.offline,
    inactive: row.inactive,
    invited: row.invited,
    activeAccounts: row.activeAccounts,
    onlineThresholdMs: PRESENCE_ONLINE_MS,
    includesAddresses: false,
    states: {
      online: 'Active account with a valid session heartbeated within two minutes.',
      idle: 'Active account with a valid session and no heartbeat within two minutes. This is not working time.',
      offline: 'Active account with no valid session.',
      inactive: 'Account status inactive. Not combined with offline.',
      invited: 'Account status invited. Not combined with offline.',
    },
  };
}

async function securityCounts(actor, range, consultancyId) {
  const query = {};
  if (range && range.start && range.end) {
    query.from = range.start.toISOString();
    query.to = range.end.toISOString();
  }
  if (consultancyId) query.consultancyId = consultancyId;
  const filters = await activityScope(query, actor);
  const rows = await mongoose.connection.collection('crmAuthAuditLogs').aggregate([
    { $match: filters.security },
    { $group: { _id: '$action', count: { $sum: 1 } } },
  ]).toArray();
  const count = (action) => {
    const found = rows.find((row) => row._id === action);
    return found ? found.count : 0;
  };
  const accountEventsIncluded = canViewAccountSecurity(actor);
  return {
    meaning: 'recorded crmAuthAuditLogs rows visible to this caller',
    accountEventsIncluded,
    assignmentCreated: count('crm_assignment.created'),
    assignmentRevoked: count('crm_assignment.revoked'),
    signInFailed: accountEventsIncluded ? count('crm_user.login_failed') : null,
    signInInactive: accountEventsIncluded ? count('crm_user.login_inactive') : null,
    signInSucceeded: accountEventsIncluded ? count('crm_user.login_succeeded') : null,
    sessionRevocations: accountEventsIncluded
      ? count('crm_session.revoked') + count('crm_session.revoked_all')
      : null,
    total: rows.reduce((sum, row) => sum + row.count, 0),
  };
}

async function listConsultancyOverview(actor, query) {
  assertKeys(query, OVERVIEW_KEYS, 'overview');
  const { page, limit, skip } = parsePageLimit(query);
  let assignment = '';
  if (query.assignment != null && query.assignment !== '') {
    if (query.assignment !== 'assigned' && query.assignment !== 'unassigned') {
      throw new CrmError(400, 'assignment must be assigned or unassigned.', 'invalid_query');
    }
    assignment = query.assignment;
  }
  let status = '';
  if (query.status != null && query.status !== '') {
    if (!CONSULTANCY_STATUS.includes(query.status)) {
      throw new CrmError(400, 'status must be active or inactive.', 'invalid_query');
    }
    status = query.status;
  }
  const scope = await resolveScope(actor, query.consultancyId);
  const filter = { deletedAt: null };
  if (scope.ids) filter._id = { $in: scope.ids };
  if (status) filter.status = status;
  const activeAssignmentIds = await CrmConsultancyAssignment.find({ revokedAt: null }).distinct('consultancyId');
  if (assignment === 'assigned') {
    const allowed = new Set(activeAssignmentIds.map(String));
    const current = filter._id ? filter._id.$in : activeAssignmentIds;
    filter._id = { $in: current.filter((id) => allowed.has(String(id))) };
  }
  if (assignment === 'unassigned') {
    if (scope.constrained) {
      const selected = String(scope.ids[0]);
      const assigned = activeAssignmentIds.some((id) => String(id) === selected);
      filter._id = assigned ? { $in: [] } : { $in: scope.ids };
    } else if (scope.ids) {
      filter._id = { $in: [] };
    } else {
      filter._id = { $nin: activeAssignmentIds };
    }
  }
  const unassignedFilter = { deletedAt: null, _id: { $nin: activeAssignmentIds } };
  if (status) unassignedFilter.status = status;
  const [items, total, unassignedConsultancies] = await Promise.all([
    CrmConsultancy.find(filter).sort({ name: 1, _id: 1 }).skip(skip).limit(limit).select('name status').lean(),
    CrmConsultancy.countDocuments(filter),
    (!scope.constrained && (scope.moduleWide || canViewModuleAggregates(actor)))
      ? CrmConsultancy.countDocuments(unassignedFilter)
      : Promise.resolve(null),
  ]);
  const ids = items.map((row) => row._id);
  const links = ids.length
    ? await CrmConsultancyAssignment.find({ consultancyId: { $in: ids }, revokedAt: null })
      .select('consultancyId crmUserId')
      .lean()
    : [];
  const userIds = [...new Set(links.map((row) => String(row.crmUserId)))];
  const users = userIds.length
    ? await CrmUser.find({ _id: { $in: userIds } }).select('fullName role status').lean()
    : [];
  const userById = new Map(users.map((row) => [String(row._id), row]));
  const byConsultancy = new Map();
  links.forEach((row) => {
    const key = String(row.consultancyId);
    const list = byConsultancy.get(key) || [];
    list.push(row);
    byConsultancy.set(key, list);
  });
  return {
    items: items.map((row) => {
      const assignees = byConsultancy.get(String(row._id)) || [];
      return {
        id: String(row._id),
        name: row.name,
        status: row.status,
        activeAssignees: assignees.length,
        assignees: assignees.map((link) => {
          const user = userById.get(String(link.crmUserId));
          return {
            id: String(link.crmUserId),
            fullName: user ? user.fullName : '',
            role: user ? user.role : null,
            status: user ? user.status : null,
          };
        }),
      };
    }),
    page,
    limit,
    total,
    sort: 'name_asc,id_asc',
    unassignedConsultancies,
    unassignedMeaning: scope.constrained
      ? 'Hidden because this response is limited to one consultancy.'
      : (scope.moduleWide
        ? 'Non-deleted consultancies in this status filter with no active assignment.'
        : (canViewModuleAggregates(actor)
          ? 'Organization-wide count. This list stays limited to consultancies assigned to the caller.'
          : 'Hidden because this caller only receives assigned consultancies.')),
  };
}

async function performanceRows(range, previous, pageIds) {
  const [all, period, prior] = await Promise.all([
    CrmReferral.aggregate([
      { $match: referralMatch(pageIds, null) },
      { $group: { _id: '$consultancyId', referrals: { $sum: 1 } } },
    ]),
    CrmReferral.aggregate([
      { $match: referralMatch(pageIds, range) },
      { $group: { _id: '$consultancyId', count: { $sum: 1 } } },
    ]),
    previous
      ? CrmReferral.aggregate([
        { $match: referralMatch(pageIds, previous) },
        { $group: { _id: '$consultancyId', count: { $sum: 1 } } },
      ])
      : [],
  ]);
  return {
    all: new Map(all.map((row) => [String(row._id), row.referrals])),
    period: new Map(period.map((row) => [String(row._id), row.count])),
    prior: new Map(prior.map((row) => [String(row._id), row.count])),
  };
}

async function getOperations(actor, query, now = new Date()) {
  assertKeys(query, OPERATION_KEYS, 'operations');
  const { page, limit, skip } = parsePageLimit(query);
  const range = resolveAnalyticsRange(query, now);
  const previous = previousBounds(range);
  const scope = await resolveScope(actor, query.consultancyId);
  const totalsModule = !scope.constrained && (scope.moduleWide || canViewModuleAggregates(actor));
  const listFilter = { deletedAt: null };
  if (scope.ids) listFilter._id = { $in: scope.ids };
  const totalFilter = { deletedAt: null };
  if (!totalsModule && scope.ids) totalFilter._id = { $in: scope.ids };
  const [consultancies, listTotal, totalConsultancies, activeConsultancies, inactiveConsultancies] = await Promise.all([
    CrmConsultancy.find(listFilter).sort({ name: 1, _id: 1 }).skip(skip).limit(limit).select('name status').lean(),
    CrmConsultancy.countDocuments(listFilter),
    CrmConsultancy.countDocuments(totalFilter),
    CrmConsultancy.countDocuments({ ...totalFilter, status: 'active' }),
    CrmConsultancy.countDocuments({ ...totalFilter, status: 'inactive' }),
  ]);
  const pageIds = consultancies.map((row) => row._id);
  const aggregateIds = totalsModule ? null : scope.ids;
  const populationMatch = referralMatch(aggregateIds, null);
  const periodMatch = referralMatch(aggregateIds, range);
  const previousMatch = previous ? referralMatch(aggregateIds, previous) : null;
  const activeAssignmentIds = totalsModule
    ? await CrmConsultancyAssignment.find({ revokedAt: null }).distinct('consultancyId')
    : [];
  const [distribution, volume, referralTotal, periodReferrals, previousReferrals, rows, security, presence, withoutReferral] = await Promise.all([
    statusCounts(populationMatch),
    referralVolume(range, periodMatch),
    CrmReferral.countDocuments(populationMatch),
    CrmReferral.countDocuments(periodMatch),
    previousMatch ? CrmReferral.countDocuments(previousMatch) : Promise.resolve(null),
    performanceRows(range, previous, pageIds),
    securityCounts(actor, range, query.consultancyId),
    canViewPresence(actor) ? presenceTotals() : Promise.resolve(null),
    totalsModule
      ? CrmStudent.aggregate([
        { $match: { deletedAt: null } },
        {
          $lookup: {
            from: 'crmReferrals',
            localField: '_id',
            foreignField: 'crmStudentId',
            as: 'referral',
          },
        },
        { $match: { referral: { $size: 0 } } },
        { $count: 'count' },
      ])
      : Promise.resolve([]),
  ]);
  const assignmentCounts = pageIds.length
    ? await CrmConsultancyAssignment.aggregate([
      { $match: { consultancyId: { $in: pageIds }, revokedAt: null } },
      { $group: { _id: '$consultancyId', count: { $sum: 1 } } },
    ])
    : [];
  const assignees = new Map(assignmentCounts.map((row) => [String(row._id), row.count]));
  const studentsWithoutReferral = totalsModule ? ((withoutReferral[0] && withoutReferral[0].count) || 0) : null;
  let admission = distribution.length ? distribution.map((row) => ({ status: row.status, count: row.count })) : emptyAdmission();
  if (totalsModule) {
    const extras = await statusesWithoutReferral();
    admission = admission.map((row) => ({
      status: row.status,
      count: row.count + (extras.get(row.status) || 0),
    }));
  }
  return {
    generatedAt: now,
    scope: scope.moduleWide ? 'module' : 'assigned',
    aggregateScope: totalsModule ? 'module' : 'assigned',
    limitations: LIMITATIONS,
    timeZone: range.timeZone,
    range: {
      id: range.id,
      label: range.label,
      from: range.from,
      to: range.to,
      start: range.start,
      end: range.end,
      meaning: 'event timestamps in this window',
    },
    previousRange: previous,
    current: {
      meaning: 'state at generatedAt, ignoring the selected period',
      consultancies: { total: totalConsultancies, active: activeConsultancies, inactive: inactiveConsultancies },
      students: {
        withCurrentReferral: referralTotal,
        withoutReferral: studentsWithoutReferral,
        total: totalsModule ? referralTotal + (studentsWithoutReferral || 0) : referralTotal,
      },
      referrals: { total: referralTotal, meaning: 'one current referral row per student' },
      admissionStatus: {
        population: totalsModule ? 'all_non_deleted_students' : 'students_with_current_referral_in_scope',
        rows: admission,
        history: null,
      },
    },
    period: {
      meaning: totalsModule
        ? 'referrals whose referredAt falls in the selected window, counted across the organization'
        : 'referrals whose referredAt falls in the selected window and whose current consultancy is in scope',
      newReferrals: periodReferrals,
      previousNewReferrals: previousReferrals,
      volume,
    },
    security,
    presence,
    consultancies: {
      page,
      limit,
      total: listTotal,
      unassigned: totalsModule
        ? await CrmConsultancy.countDocuments({ deletedAt: null, _id: { $nin: activeAssignmentIds } })
        : null,
      items: consultancies.map((row) => ({
        id: String(row._id),
        name: row.name,
        status: row.status,
        students: rows.all.get(String(row._id)) || 0,
        referrals: rows.all.get(String(row._id)) || 0,
        newReferrals: rows.period.get(String(row._id)) || 0,
        previousNewReferrals: previous ? (rows.prior.get(String(row._id)) || 0) : null,
        activeAssignees: assignees.get(String(row._id)) || 0,
      })),
    },
  };
}

module.exports = {
  listConsultancyOverview,
  getOperations,
};
