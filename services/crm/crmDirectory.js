'use strict';

const CrmUser = require('../../models/CrmUser');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const { CRM_ACCOUNT_STATUSES, CRM_ROLE_KEYS, CRM_ROLES, permissionSummary } = require('../../constants/crmUsers');
const { CrmError } = require('../../utils/crmError');
const { escapeRegex, parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { loadPresenceMap } = require('./crmPresence');

const QUERY_KEYS = Object.freeze([
  'page',
  'limit',
  'status',
  'role',
  'q',
  'consultancyId',
  'assignment',
  'presence',
]);

function assertKeys(query) {
  Object.keys(query || {}).forEach((key) => {
    if (!QUERY_KEYS.includes(key)) {
      throw new CrmError(400, `${key} is not a supported directory filter.`, 'unsupported_filter');
    }
  });
}

function assertViewer(actor) {
  if (!actor) throw new CrmError(401, 'Authentication required', 'authentication_required');
  if (actor.kind === 'admin') return;
  if (actor.kind === 'crm-user' && (actor.permissions || []).includes('crm.roles.manage')) return;
  throw new CrmError(403, 'You do not have permission to view the CRM directory.', 'permission_denied');
}

async function accountFilter(query) {
  const filter = { deletedAt: null };
  if (query.status) {
    if (!CRM_ACCOUNT_STATUSES.includes(query.status)) {
      throw new CrmError(400, 'Status filter is not valid.', 'invalid_query');
    }
    filter.status = query.status;
  }
  if (query.role) {
    if (!CRM_ROLE_KEYS.includes(query.role)) throw new CrmError(400, 'Role filter is not valid.', 'invalid_query');
  }
  if (query.role) filter.role = query.role;
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q) {
    if (q.length > 100) throw new CrmError(400, 'Search text is too long.', 'invalid_query');
    const safe = escapeRegex(q);
    filter.$or = [
      { fullName: new RegExp(safe, 'i') },
      { email: new RegExp(safe, 'i') },
      { username: new RegExp(safe, 'i') },
    ];
  }
  let assignment = '';
  if (query.assignment != null && query.assignment !== '') {
    if (query.assignment !== 'assigned' && query.assignment !== 'unassigned') {
      throw new CrmError(400, 'assignment must be assigned or unassigned.', 'invalid_query');
    }
    assignment = query.assignment;
  }
  let presence = '';
  if (query.presence != null && query.presence !== '') {
    if (!['online', 'idle', 'offline', 'inactive', 'invited'].includes(query.presence)) {
      throw new CrmError(400, 'presence must be online, idle, offline, inactive, or invited.', 'invalid_query');
    }
    presence = query.presence;
  }
  const assignedIds = await CrmConsultancyAssignment.find({ revokedAt: null }).distinct('crmUserId');
  if (query.consultancyId) {
    const consultancyId = parseObjectId(query.consultancyId, 'Consultancy id');
    const consultancy = await CrmConsultancy.exists({ _id: consultancyId, deletedAt: null });
    if (!consultancy) throw new CrmError(404, 'Consultancy not found.', 'not_found');
    const onConsultancy = await CrmConsultancyAssignment.find({
      consultancyId,
      revokedAt: null,
    }).distinct('crmUserId');
    filter._id = { $in: onConsultancy };
  }
  if (assignment === 'assigned') {
    filter._id = filter._id
      ? { $in: filter._id.$in.filter((id) => assignedIds.some((assigned) => String(assigned) === String(id))) }
      : { $in: assignedIds };
  }
  if (assignment === 'unassigned') {
    const blocked = new Set(assignedIds.map(String));
    if (filter._id && filter._id.$in) {
      filter._id = { $in: filter._id.$in.filter((id) => !blocked.has(String(id))) };
    } else {
      filter._id = { $nin: assignedIds };
    }
  }
  return { filter, presence };
}

async function decorate(users, now) {
  const ids = users.map((user) => user._id);
  const [presence, assignments, authActivity, businessActivity] = await Promise.all([
    loadPresenceMap(users, now),
    ids.length
      ? CrmConsultancyAssignment.find({ crmUserId: { $in: ids }, revokedAt: null })
        .select('crmUserId consultancyId')
        .lean()
      : [],
    ids.length
      ? CrmAuthAuditLog.aggregate([
        { $match: { targetUserId: { $in: ids } } },
        { $group: { _id: '$targetUserId', last: { $max: '$createdAt' } } },
      ])
      : [],
    ids.length
      ? CrmAuditLog.aggregate([
        { $match: { actorCrmUserId: { $in: ids } } },
        { $group: { _id: '$actorCrmUserId', last: { $max: '$createdAt' } } },
      ])
      : [],
  ]);
  const consultancyIds = [...new Set(assignments.map((row) => String(row.consultancyId)))];
  const consultancies = consultancyIds.length
    ? await CrmConsultancy.find({ _id: { $in: consultancyIds } }).select('name status').lean()
    : [];
  const consultancyById = new Map(consultancies.map((row) => [String(row._id), row]));
  const assignmentsByUser = new Map();
  assignments.forEach((row) => {
    const key = String(row.crmUserId);
    const list = assignmentsByUser.get(key) || [];
    list.push(row);
    assignmentsByUser.set(key, list);
  });
  const authByUser = new Map(authActivity.map((row) => [String(row._id), row.last]));
  const businessByUser = new Map(businessActivity.map((row) => [String(row._id), row.last]));
  return users.map((user) => {
    const key = String(user._id);
    const links = assignmentsByUser.get(key) || [];
    const stamps = [user.updatedAt, authByUser.get(key), businessByUser.get(key)]
      .filter(Boolean)
      .map((value) => new Date(value).getTime());
    const row = presence.get(key);
    return {
      id: key,
      fullName: user.fullName,
      email: user.email,
      username: user.username,
      status: user.status,
      role: user.role,
      roleLabel: CRM_ROLES[user.role] ? CRM_ROLES[user.role].label : user.role,
      permissionSummary: permissionSummary(user.permissions),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      assignmentCount: links.length,
      consultancies: links.slice(0, 8).map((link) => {
        const consultancy = consultancyById.get(String(link.consultancyId));
        return {
          id: String(link.consultancyId),
          name: consultancy ? consultancy.name : '',
          status: consultancy ? consultancy.status : null,
        };
      }),
      presence: {
        state: row.state,
        lastSeenAt: row.lastSeenAt,
        activeSessions: row.activeSessions,
      },
      lastActivityAt: stamps.length ? new Date(Math.max(...stamps)) : null,
    };
  });
}

async function listDirectory(actor, query) {
  assertViewer(actor);
  assertKeys(query);
  const { page, limit, skip } = parsePageLimit(query);
  const { filter, presence } = await accountFilter(query || {});
  const unassignedUsers = await CrmUser.countDocuments({
    deletedAt: null,
    _id: { $nin: await CrmConsultancyAssignment.find({ revokedAt: null }).distinct('crmUserId') },
  });
  const now = new Date();
  if (!presence) {
    const [users, total] = await Promise.all([
      CrmUser.find(filter).sort({ fullName: 1, _id: 1 }).skip(skip).limit(limit)
        .select('fullName email username status role permissions createdAt updatedAt sessionVersion')
        .lean(),
      CrmUser.countDocuments(filter),
    ]);
    return {
      items: await decorate(users, now),
      page,
      limit,
      total,
      sort: 'fullName_asc,id_asc',
      unassignedUsers,
    };
  }
  const users = await CrmUser.find(filter).sort({ fullName: 1, _id: 1 })
    .select('fullName email username status role permissions createdAt updatedAt sessionVersion')
    .lean();
  const presenceMap = await loadPresenceMap(users, now);
  const matched = users.filter((user) => presenceMap.get(String(user._id)).state === presence);
  return {
    items: await decorate(matched.slice(skip, skip + limit), now),
    page,
    limit,
    total: matched.length,
    sort: 'fullName_asc,id_asc',
    unassignedUsers,
  };
}

module.exports = {
  listDirectory,
};
