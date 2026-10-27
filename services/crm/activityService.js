'use strict';

const mongoose = require('mongoose');
const Admin = require('../../models/Admin');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmStudent = require('../../models/CrmStudent');
const CrmUser = require('../../models/CrmUser');
const { CRM_ACCESS_SECTION } = require('../../constants/crmUsers');
const { CrmError } = require('../../utils/crmError');
const { escapeRegex, parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { businessAuditScope } = require('./auditService');
const { reportingConsultancyIds, reportingScopeBasis } = require('./crmAccess');
const { resolveAnalyticsRange } = require('../../utils/crmRange');

const ASSIGNMENT_ACTIONS = Object.freeze(['crm_assignment.created', 'crm_assignment.revoked']);
const AUTHENTICATION_ACTIONS = Object.freeze([
  'crm_user.login_succeeded',
  'crm_user.login_failed',
  'crm_user.login_inactive',
  'crm_user.logout',
  'crm_session.revoked',
  'crm_session.revoked_all',
]);
const NO_MATCH = Object.freeze({ _id: { $exists: false } });
const QUERY_KEYS = Object.freeze([
  'page',
  'limit',
  'from',
  'to',
  'actorId',
  'actorType',
  'action',
  'source',
  'entityType',
  'entityId',
  'consultancyId',
  'q',
  'timeZone',
]);
const SECRET_KEY = /password|token|otp|secret|authorization|mongodb|connection|cookie|csrf|sessiontoken|resetcode/i;
const SUMMARIES = Object.freeze({
  'consultancy.created': 'Consultancy created.',
  'consultancy.updated': 'Consultancy updated.',
  'contact.created': 'Consultancy contact created.',
  'contact.updated': 'Consultancy contact updated.',
  'contact.deactivated': 'Consultancy contact deactivated.',
  'student.created': 'Student created.',
  'student.updated': 'Student updated.',
  'referral.created': 'Referral recorded.',
  'referral.source_corrected': 'Referral source corrected.',
  'crm_assignment.created': 'Consultancy assignment created.',
  'crm_assignment.revoked': 'Consultancy assignment revoked.',
  'crm_user.created': 'CRM account created.',
  'crm_user.invited': 'CRM account invited.',
  'crm_user.updated': 'CRM account updated.',
  'crm_user.deactivated': 'CRM account deactivated.',
  'crm_user.reset_issued': 'Password reset code issued.',
  'crm_user.password_reset': 'Password reset by an administrator.',
  'crm_user.login_succeeded': 'Sign-in succeeded.',
  'crm_user.login_failed': 'Sign-in failed.',
  'crm_user.login_inactive': 'Sign-in denied for an inactive account.',
  'crm_user.logout': 'Signed out.',
  'crm_session.revoked': 'CRM session revoked.',
  'crm_session.revoked_all': 'CRM sessions revoked.',
  'crm_user.reset_requested': 'Password reset requested.',
  'crm_user.reset_completed': 'Password reset completed.',
  'crm_permission.updated': 'CRM admin access updated.',
  'crm_permission.revoked': 'CRM admin access revoked.',
  'consultancy.follow_up': 'Follow-up created.',
  'consultancy.follow_up_updated': 'Follow-up updated.',
  'consultancy.follow_up_completed': 'Follow-up completed.',
  'consultancy.follow_up_cancelled': 'Follow-up cancelled.',
  'consultancy.calling_status': 'Calling status changed.',
  'consultancy.remark_added': 'Remark added.',
  'consultancy.remark_edited': 'Remark edited.',
  'consultancy.owner_reassigned': 'Consultancy owner reassigned.',
});
const REMARK_ACTIONS = Object.freeze(['consultancy.remark_added', 'consultancy.remark_edited']);
const STUDENT_ENTITY_TYPES = Object.freeze(['student', 'crmStudent']);
const ENTITY_TYPE_ALIASES = Object.freeze({
  student: ['student', 'crmStudent'],
  crmStudent: ['student', 'crmStudent'],
  referral: ['referral', 'crmReferral'],
  crmReferral: ['referral', 'crmReferral'],
  contact: ['contact', 'consultancy_contact'],
  consultancy_contact: ['contact', 'consultancy_contact'],
});

function canViewAccountSecurity(actor) {
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

// Remark text follows consultancy record access, not audit.read alone.
function canReadRemarkContent(actor) {
  if (!actor) return false;
  if (actor.actorType === 'admin') {
    if (actor.isSuperAdmin === true) return true;
    return Array.isArray(actor.sectionAccess) && actor.sectionAccess.includes(CRM_ACCESS_SECTION);
  }
  return Array.isArray(actor.permissions) && actor.permissions.includes('crm.consultancies.read');
}

function scrubRemarkSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'text')) return snapshot;
  return { ...snapshot, text: '[redacted]' };
}

function applyRemarkPrivacy(action, before, after, actor) {
  if (!REMARK_ACTIONS.includes(action) || canReadRemarkContent(actor)) {
    return { before, after };
  }
  return {
    before: scrubRemarkSnapshot(before),
    after: scrubRemarkSnapshot(after),
  };
}

function andFilters(parts) {
  const present = parts.filter(Boolean);
  if (present.length === 0) return {};
  if (present.length === 1) return present[0];
  return { $and: present };
}

function parseTimestamp(value, label, bound) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CrmError(400, `${label} is not valid.`, 'invalid_query');
  }
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const suffix = bound === 'to' ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    return new Date(`${text}${suffix}`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new CrmError(400, `${label} is not a valid UTC timestamp.`, 'invalid_query');
  }
  return parsed;
}

function parseActivityQuery(query) {
  const sourceQuery = query || {};
  if (Object.prototype.hasOwnProperty.call(sourceQuery, 'outcome')) {
    throw new CrmError(400, 'outcome is not stored on audit events.', 'unsupported_filter');
  }
  Object.keys(sourceQuery).forEach((key) => {
    if (!QUERY_KEYS.includes(key)) {
      throw new CrmError(400, `${key} is not a supported activity filter.`, 'unsupported_filter');
    }
  });
  let timeZone = '';
  if (sourceQuery.timeZone != null && sourceQuery.timeZone !== '') {
    timeZone = String(sourceQuery.timeZone);
  }
  const fromText = sourceQuery.from == null ? '' : String(sourceQuery.from).trim();
  const toText = sourceQuery.to == null ? '' : String(sourceQuery.to).trim();
  const zonedDates = timeZone && /^\d{4}-\d{2}-\d{2}$/.test(fromText) && /^\d{4}-\d{2}-\d{2}$/.test(toText);
  let from;
  let to;
  if (zonedDates) {
    const bounds = resolveAnalyticsRange({ period: 'custom', from: fromText, to: toText, timeZone });
    from = bounds.start;
    to = bounds.end;
  } else {
    from = parseTimestamp(sourceQuery.from, 'from', 'from');
    to = parseTimestamp(sourceQuery.to, 'to', 'to');
  }
  if (from && to && from.getTime() > to.getTime()) {
    throw new CrmError(400, 'from must be before to.', 'invalid_query');
  }
  let source = 'both';
  if (sourceQuery.source != null && sourceQuery.source !== '') {
    if (sourceQuery.source !== 'business' && sourceQuery.source !== 'security') {
      throw new CrmError(400, 'source must be business or security.', 'invalid_query');
    }
    source = sourceQuery.source;
  }
  let actorType = '';
  if (sourceQuery.actorType != null && sourceQuery.actorType !== '') {
    if (sourceQuery.actorType !== 'admin' && sourceQuery.actorType !== 'crm-user') {
      throw new CrmError(400, 'actorType must be admin or crm-user.', 'invalid_query');
    }
    actorType = sourceQuery.actorType;
  }
  let action = '';
  if (sourceQuery.action != null && sourceQuery.action !== '') {
    if (typeof sourceQuery.action !== 'string' || !/^[a-z0-9._]{1,80}$/i.test(sourceQuery.action)) {
      throw new CrmError(400, 'action is not valid.', 'invalid_query');
    }
    action = sourceQuery.action;
  }
  let entityType = '';
  if (sourceQuery.entityType != null && sourceQuery.entityType !== '') {
    if (typeof sourceQuery.entityType !== 'string' || !/^[a-z0-9_]{1,40}$/i.test(sourceQuery.entityType)) {
      throw new CrmError(400, 'entityType is not valid.', 'invalid_query');
    }
    entityType = sourceQuery.entityType;
  }
  if ((entityType || sourceQuery.entityId) && source === 'security') {
    throw new CrmError(400, 'Security events have no entity id.', 'unsupported_filter');
  }
  let q = '';
  if (sourceQuery.q != null && sourceQuery.q !== '') {
    if (typeof sourceQuery.q !== 'string') {
      throw new CrmError(400, 'q is not valid.', 'invalid_query');
    }
    q = sourceQuery.q.trim();
    if (q.length < 2 || q.length > 80) {
      throw new CrmError(400, 'q must be 2–80 characters.', 'invalid_query');
    }
  }
  return {
    from,
    to,
    timeZone: timeZone || 'UTC',
    source,
    actorType,
    actorId: sourceQuery.actorId ? parseObjectId(sourceQuery.actorId, 'Actor id') : null,
    action,
    entityType,
    entityId: sourceQuery.entityId ? parseObjectId(sourceQuery.entityId, 'Entity id') : null,
    consultancyId: sourceQuery.consultancyId ? String(parseObjectId(sourceQuery.consultancyId, 'Consultancy id')) : '',
    q,
  };
}

function actorClause(parsed) {
  if (parsed.actorType === 'admin') {
    return parsed.actorId
      ? { actorAdminId: parsed.actorId }
      : { actorAdminId: { $type: 'objectId' } };
  }
  if (parsed.actorType === 'crm-user') {
    return parsed.actorId
      ? { actorCrmUserId: parsed.actorId }
      : { actorCrmUserId: { $type: 'objectId' } };
  }
  if (parsed.actorId) {
    return { $or: [{ actorAdminId: parsed.actorId }, { actorCrmUserId: parsed.actorId }] };
  }
  return null;
}

function rangeClause(parsed) {
  if (!parsed.from && !parsed.to) return null;
  const createdAt = {};
  if (parsed.from) createdAt.$gte = parsed.from;
  if (parsed.to) createdAt.$lte = parsed.to;
  return { createdAt };
}

function searchClause(parsed) {
  if (!parsed.q) return null;
  const pattern = new RegExp(escapeRegex(parsed.q), 'i');
  return { $or: [{ action: pattern }, { reason: pattern }] };
}

function assignmentClause(idStrings) {
  if (!idStrings.length) return NO_MATCH;
  return {
    action: { $in: ASSIGNMENT_ACTIONS },
    'after.consultancyId': { $in: idStrings },
    $expr: {
      $or: [
        { $eq: [{ $ifNull: ['$before.consultancyId', null] }, null] },
        { $eq: ['$before.consultancyId', '$after.consultancyId'] },
      ],
    },
  };
}

function securityScope(actor, consultancyIds, consultancyConstrained) {
  const unrestricted = consultancyIds == null;
  const idStrings = unrestricted ? [] : consultancyIds.map(String);
  const assignment = unrestricted
    ? { action: { $in: ASSIGNMENT_ACTIONS } }
    : assignmentClause(idStrings);
  if (consultancyConstrained) return assignment;
  if (canViewAccountSecurity(actor)) {
    if (unrestricted) return {};
    return { $or: [assignment, { action: { $nin: ASSIGNMENT_ACTIONS } }] };
  }
  if (unrestricted) return assignment;
  return assignment;
}

// Platform admins are not CRM users and have no consultancy assignments.
// Their business activity stays module-wide, matching the existing /api/admin/crm contract.
// A CRM user only receives business events for consultancies assigned to that user.
// Consultancy-crm staff do not receive authentication events unless they are Super Admin
// or also have crm-access-management.
async function resolveConsultancyIds(actor, consultancyId) {
  const assigned = await reportingConsultancyIds(actor);
  if (!consultancyId) {
    return { consultancyIds: assigned, consultancyConstrained: false };
  }
  if (assigned != null && !assigned.some((id) => String(id) === consultancyId)) {
    throw new CrmError(404, 'Consultancy not found.', 'not_found');
  }
  return {
    consultancyIds: [new mongoose.Types.ObjectId(consultancyId)],
    consultancyConstrained: true,
  };
}

async function authorizedFilters(actor, parsed) {
  const scope = await resolveConsultancyIds(actor, parsed.consultancyId);
  const common = [actorClause(parsed), rangeClause(parsed), searchClause(parsed)];
  if (parsed.action) common.push({ action: parsed.action });
  let business = andFilters([
    await businessAuditScope(scope.consultancyIds),
    ...common,
  ]);
  let security = andFilters([
    securityScope(actor, scope.consultancyIds, scope.consultancyConstrained),
    ...common,
  ]);
  if (parsed.entityType) {
    const entityTypes = ENTITY_TYPE_ALIASES[parsed.entityType] || [parsed.entityType];
    business = andFilters([
      business,
      entityTypes.length === 1 ? { entityType: entityTypes[0] } : { entityType: { $in: entityTypes } },
    ]);
  }
  if (parsed.entityId) business = andFilters([business, { entityId: parsed.entityId }]);
  if (parsed.entityType || parsed.entityId) security = NO_MATCH;
  if (parsed.source === 'business') security = NO_MATCH;
  if (parsed.source === 'security') business = NO_MATCH;
  let recordScope = scope.consultancyIds == null ? 'module' : 'assigned';
  if (scope.consultancyConstrained) recordScope = 'consultancy';
  return {
    business,
    security,
    recordScope,
    scopeBasis: reportingScopeBasis(actor),
    accountEventsIncluded: canViewAccountSecurity(actor),
  };
}

function redactValue(value, depth) {
  const level = depth || 0;
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (level > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, level + 1));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => {
      if (SECRET_KEY.test(key) || (key.startsWith('_') && key !== '_id')) return;
      out[key] = redactValue(value[key], level + 1);
    });
    return out;
  }
  return null;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffSnapshots(before, after) {
  const beforeObject = before && typeof before === 'object' && !Array.isArray(before) ? before : null;
  const afterObject = after && typeof after === 'object' && !Array.isArray(after) ? after : null;
  if (!beforeObject && !afterObject) return null;
  const keys = new Set([
    ...(beforeObject ? Object.keys(beforeObject) : []),
    ...(afterObject ? Object.keys(afterObject) : []),
  ]);
  const changes = [];
  [...keys].sort().forEach((field) => {
    const hasBefore = Boolean(beforeObject) && Object.prototype.hasOwnProperty.call(beforeObject, field);
    const hasAfter = Boolean(afterObject) && Object.prototype.hasOwnProperty.call(afterObject, field);
    const beforeValue = hasBefore ? beforeObject[field] : null;
    const afterValue = hasAfter ? afterObject[field] : null;
    if (hasBefore && hasAfter && sameValue(beforeValue, afterValue)) return;
    changes.push({
      field,
      before: beforeValue,
      beforeMissing: !hasBefore,
      after: afterValue,
      afterMissing: !hasAfter,
    });
  });
  return changes;
}

function storedId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value) ? value : null;
}

function snapshotConsultancyId(before, after) {
  const afterId = storedId(after && after.consultancyId);
  const beforeId = storedId(before && before.consultancyId);
  if (beforeId && afterId && beforeId !== afterId) return null;
  return afterId || beforeId || null;
}

function categoryFor(source, action, entityType) {
  if (entityType === 'admin' || action === 'crm_permission.updated' || action === 'crm_permission.revoked') {
    return 'permission';
  }
  if (ASSIGNMENT_ACTIONS.includes(action)) return 'assignment';
  if (AUTHENTICATION_ACTIONS.includes(action)) return 'authentication';
  if (typeof action === 'string' && action.startsWith('crm_user.')) return 'account';
  if (source === 'security') return 'security';
  return 'business';
}


async function namesForActors(actors) {
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
  users.forEach((row) => names.set(`crm-user:${String(row._id)}`, row.fullName || ''));
  admins.forEach((row) => names.set(`admin:${String(row._id)}`, row.name || ''));
  return names;
}

function fallbackActorName(type) {
  if (type === 'admin') return 'Unknown platform admin';
  if (type === 'crm-user') return 'Unknown actor';
  return 'Unknown actor';
}

function fallbackEntityLabel(item) {
  if (item.entityName) return item.entityName;
  if (item.entityType && item.entityId) return `${item.entityType} ${item.entityId}`;
  if (item.targetUserName) return item.targetUserName;
  if (item.targetUserId) return `user ${item.targetUserId}`;
  return null;
}

async function enrichActivityItems(items) {
  const actors = [];
  const targetIds = [];
  const consultancyIds = [];
  const studentIds = [];
  items.forEach((item) => {
    if (item.actorType && item.actorId) actors.push({ type: item.actorType, id: item.actorId });
    if (item.targetUserId) targetIds.push(item.targetUserId);
    if (item.consultancyId) consultancyIds.push(item.consultancyId);
    if (STUDENT_ENTITY_TYPES.includes(item.entityType) && item.entityId) studentIds.push(item.entityId);
  });
  const [actorNames, targets, consultancies, students] = await Promise.all([
    namesForActors(actors),
    targetIds.length ? CrmUser.find({ _id: { $in: targetIds } }).select('fullName').lean() : [],
    consultancyIds.length
      ? CrmConsultancy.find({ _id: { $in: consultancyIds } }).select('name deletedAt').lean()
      : [],
    studentIds.length
      ? CrmStudent.find({ _id: { $in: studentIds } }).select('fullName deletedAt').lean()
      : [],
  ]);
  const targetNames = new Map(targets.map((row) => [String(row._id), row.fullName || '']));
  const consultancyNames = new Map(consultancies.map((row) => [
    String(row._id),
    row.deletedAt ? `${row.name || 'Consultancy'} (deleted)` : (row.name || ''),
  ]));
  const studentNames = new Map(students.map((row) => [
    String(row._id),
    row.deletedAt ? `${row.fullName || 'Student'} (deleted)` : (row.fullName || ''),
  ]));
  return items.map((item) => {
    const resolvedActorName = item.actorType && item.actorId
      ? (actorNames.get(`${item.actorType}:${item.actorId}`) || '')
      : '';
    const actor = item.actorType && item.actorId
      ? {
        type: item.actorType,
        id: item.actorId,
        name: resolvedActorName,
        displayName: resolvedActorName || fallbackActorName(item.actorType),
      }
      : null;
    const targetUserName = item.targetUserId ? (targetNames.get(String(item.targetUserId)) || '') : null;
    const consultancyName = item.consultancyId ? (consultancyNames.get(String(item.consultancyId)) || '') : null;
    let entityName = item.entityName || null;
    if (!entityName && STUDENT_ENTITY_TYPES.includes(item.entityType) && item.entityId) {
      entityName = studentNames.get(String(item.entityId)) || null;
    }
    if (!entityName && item.entityType === 'consultancy' && consultancyName) {
      entityName = consultancyName;
    }
    const withNames = {
      ...item,
      actor,
      targetUserName,
      consultancyName,
      entityName,
    };
    return {
      ...withNames,
      entityLabel: fallbackEntityLabel(withNames) || consultancyName || null,
    };
  });
}


function snapshotLabel(before, after) {
  for (const snapshot of [after, before]) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    const text = snapshot.fullName || snapshot.name;
    if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 200);
  }
  return null;
}

function presentEvent(row, source, actor) {
  const redactedBefore = redactValue(row.before == null ? null : row.before);
  const redactedAfter = redactValue(row.after == null ? null : row.after);
  // Diff first so identical redacted placeholders do not hide that text changed.
  let changes = diffSnapshots(redactedBefore, redactedAfter);
  const privateSnapshots = applyRemarkPrivacy(row.action, redactedBefore, redactedAfter, actor);
  const before = privateSnapshots.before;
  const after = privateSnapshots.after;
  if (
    REMARK_ACTIONS.includes(row.action)
    && !canReadRemarkContent(actor)
    && Array.isArray(changes)
  ) {
    changes = changes.map((change) => (
      change.field === 'text'
        ? { ...change, before: '[redacted]', after: '[redacted]' }
        : change
    ));
  }
  const actorAdminId = row.actorAdminId ? String(row.actorAdminId) : null;
  const actorCrmUserId = row.actorCrmUserId ? String(row.actorCrmUserId) : null;
  let actorType = null;
  let actorId = null;
  if (actorCrmUserId && !actorAdminId) {
    actorType = 'crm-user';
    actorId = actorCrmUserId;
  } else if (actorAdminId && !actorCrmUserId) {
    actorType = 'admin';
    actorId = actorAdminId;
  }
  const entityType = source === 'business' ? row.entityType : null;
  const consultancyId = entityType === 'consultancy' && row.entityId
    ? String(row.entityId)
    : snapshotConsultancyId(before, after);
  return {
    id: String(row._id),
    source,
    createdAt: row.createdAt,
    actorId,
    actorType,
    actorAdminId,
    actorCrmUserId,
    action: row.action,
    category: categoryFor(source, row.action, entityType),
    entityType,
    entityId: source === 'business' && row.entityId ? String(row.entityId) : null,
    targetUserId: source === 'security' && row.targetUserId ? String(row.targetUserId) : null,
    consultancyId,
    entityName: snapshotLabel(before, after),
    outcome: null,
    summary: SUMMARIES[row.action] || row.action,
    reason: row.reason || '',
    changes,
    before,
    after,
    requestId: null,
  };
}

// Offset pages match the other CRM lists. MongoDB sorts and limits the merged
// ids, so the process does not load either collection. A newer insert can shift
// later pages; page numbers are not a stable cursor.
async function pageRows(businessFilter, securityFilter, source, skip, limit) {
  const businessStages = [
    { $match: businessFilter },
    { $project: { createdAt: 1, source: { $literal: 'business' }, sourceRank: { $literal: 0 } } },
  ];
  const securityStages = [
    { $match: securityFilter },
    { $project: { createdAt: 1, source: { $literal: 'security' }, sourceRank: { $literal: 1 } } },
  ];
  let model = CrmAuditLog;
  let pipeline = businessStages;
  if (source === 'security') {
    model = CrmAuthAuditLog;
    pipeline = securityStages;
  } else if (source === 'both') {
    pipeline = businessStages.concat([
      { $unionWith: { coll: 'crmAuthAuditLogs', pipeline: securityStages } },
    ]);
  }
  pipeline.push(
    { $sort: { createdAt: -1, sourceRank: 1, _id: -1 } },
    { $skip: skip },
    { $limit: limit }
  );
  return model.aggregate(pipeline);
}

async function countRows(source, businessFilter, securityFilter) {
  if (source === 'business') return CrmAuditLog.countDocuments(businessFilter);
  if (source === 'security') return CrmAuthAuditLog.countDocuments(securityFilter);
  const [businessCount, securityCount] = await Promise.all([
    CrmAuditLog.countDocuments(businessFilter),
    CrmAuthAuditLog.countDocuments(securityFilter),
  ]);
  return businessCount + securityCount;
}

async function loadScoped(model, ids, filter) {
  if (!ids.length) return [];
  return model.find(andFilters([filter, { _id: { $in: ids } }])).lean();
}

async function listActivity(query, actor) {
  const { page, limit, skip } = parsePageLimit(query);
  const parsed = parseActivityQuery(query);
  const filters = await authorizedFilters(actor, parsed);
  const [rows, total] = await Promise.all([
    pageRows(filters.business, filters.security, parsed.source, skip, limit),
    countRows(parsed.source, filters.business, filters.security),
  ]);
  const businessIds = rows.filter((row) => row.source === 'business').map((row) => row._id);
  const securityIds = rows.filter((row) => row.source === 'security').map((row) => row._id);
  const [businessDocs, securityDocs] = await Promise.all([
    loadScoped(CrmAuditLog, businessIds, filters.business),
    loadScoped(CrmAuthAuditLog, securityIds, filters.security),
  ]);
  const byId = new Map();
  businessDocs.forEach((doc) => byId.set(`business:${String(doc._id)}`, presentEvent(doc, 'business', actor)));
  securityDocs.forEach((doc) => byId.set(`security:${String(doc._id)}`, presentEvent(doc, 'security', actor)));
  const items = await enrichActivityItems(
    rows.map((row) => byId.get(`${row.source}:${String(row._id)}`)).filter(Boolean)
  );
  return {
    items,
    page,
    limit,
    total,
    order: 'createdAt_desc,source_asc,id_desc',
    recordScope: filters.recordScope,
    scopeBasis: filters.scopeBasis,
    accountEventsIncluded: filters.accountEventsIncluded,
  };
}

async function getActivity(source, id, actor) {
  if (source !== 'business' && source !== 'security') {
    throw new CrmError(404, 'Activity event not found.', 'not_found');
  }
  const eventId = parseObjectId(id, 'Activity id');
  const filters = await authorizedFilters(actor, {
    from: null,
    to: null,
    source,
    actorType: '',
    actorId: null,
    action: '',
    entityType: '',
    entityId: null,
    consultancyId: '',
    q: '',
  });
  const model = source === 'business' ? CrmAuditLog : CrmAuthAuditLog;
  const filter = source === 'business' ? filters.business : filters.security;
  const doc = await model.findOne(andFilters([filter, { _id: eventId }])).lean();
  if (!doc) throw new CrmError(404, 'Activity event not found.', 'not_found');
  const [item] = await enrichActivityItems([presentEvent(doc, source, actor)]);
  return item;
}

function actionCount(rows, name) {
  const found = rows.find((row) => row._id === name);
  return found ? found.count : 0;
}

async function activityScope(query, actor) {
  return authorizedFilters(actor, parseActivityQuery(query || {}));
}

const CREATE_ACTIONS = Object.freeze([
  'consultancy.created',
  'contact.created',
  'student.created',
  'referral.created',
  'crm_user.created',
  'crm_user.invited',
  'crm_assignment.created',
  'consultancy.follow_up',
  'consultancy.remark_added',
]);
const UPDATE_ACTIONS = Object.freeze([
  'consultancy.updated',
  'contact.updated',
  'contact.deactivated',
  'student.updated',
  'referral.source_corrected',
  'crm_user.updated',
  'crm_user.deactivated',
  'crm_assignment.revoked',
  'consultancy.follow_up_updated',
  'consultancy.follow_up_completed',
  'consultancy.follow_up_cancelled',
  'consultancy.calling_status',
  'consultancy.remark_edited',
  'consultancy.owner_reassigned',
  'crm_permission.updated',
  'crm_permission.revoked',
]);

function countNamedActions(rows, names) {
  const wanted = new Set(names);
  return rows.reduce((sum, row) => sum + (wanted.has(row._id) ? row.count : 0), 0);
}

function daySeries(rows, from, to, timeZone) {
  const byDay = new Map(rows.map((row) => [row._id, row.count]));
  const points = [];
  if (!from || !to) {
    [...byDay.entries()]
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .forEach(([key, count]) => points.push({ key, label: key, count }));
    return points;
  }
  const cursor = new Date(from.getTime());
  const end = to.getTime();
  // Walk calendar days in the reporting zone by advancing 12 hours at a time and
  // formatting each stamp, so DST gaps do not drop a day key.
  const seen = new Set();
  while (cursor.getTime() <= end) {
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(cursor);
    if (!seen.has(key)) {
      seen.add(key);
      const label = new Intl.DateTimeFormat('en-IN', {
        timeZone,
        day: 'numeric',
        month: 'short',
      }).format(cursor);
      points.push({ key, label, count: byDay.get(key) || 0 });
    }
    cursor.setTime(cursor.getTime() + (12 * 60 * 60 * 1000));
  }
  return points;
}

async function summarizeActivity(query, actor) {
  const sourceQuery = { ...(query || {}) };
  if (Object.prototype.hasOwnProperty.call(sourceQuery, 'page')) {
    throw new CrmError(400, 'page is not a supported activity summary filter.', 'unsupported_filter');
  }
  if (Object.prototype.hasOwnProperty.call(sourceQuery, 'limit')) {
    const limit = Number(sourceQuery.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new CrmError(400, 'limit must be an integer from 1 to 20.', 'invalid_query');
    }
    delete sourceQuery.limit;
  }
  const recentLimit = query && query.limit != null && query.limit !== '' ? Number(query.limit) : 10;
  const parsed = parseActivityQuery(sourceQuery);
  const filters = await authorizedFilters(actor, parsed);
  const accountEventsIncluded = canViewAccountSecurity(actor);
  const timeZone = parsed.timeZone || 'UTC';
  const dayExpr = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone } };
  const [
    businessTotal,
    securityTotal,
    businessActions,
    securityActions,
    recent,
    activeActorRows,
    consultancyRows,
    businessLast,
    securityLast,
    businessDays,
    securityDays,
    staffRows,
  ] = await Promise.all([
    CrmAuditLog.countDocuments(filters.business),
    CrmAuthAuditLog.countDocuments(filters.security),
    CrmAuditLog.aggregate([{ $match: filters.business }, { $group: { _id: '$action', count: { $sum: 1 } } }]),
    CrmAuthAuditLog.aggregate([{ $match: filters.security }, { $group: { _id: '$action', count: { $sum: 1 } } }]),
    listActivity({ ...sourceQuery, page: '1', limit: String(recentLimit) }, actor),
    CrmAuditLog.aggregate([
      { $match: andFilters([filters.business, { actorCrmUserId: { $type: 'objectId' } }]) },
      { $group: { _id: '$actorCrmUserId' } },
      { $count: 'total' },
    ]),
    CrmAuditLog.aggregate([
      { $match: filters.business },
      {
        $project: {
          consultancyId: {
            $cond: [
              { $and: [{ $eq: ['$entityType', 'consultancy'] }, { $ne: ['$entityId', null] }] },
              '$entityId',
              {
                $cond: [
                  { $and: [{ $ne: ['$after.consultancyId', null] }, { $eq: [{ $type: '$after.consultancyId' }, 'string'] }] },
                  { $toObjectId: '$after.consultancyId' },
                  null,
                ],
              },
            ],
          },
        },
      },
      { $match: { consultancyId: { $type: 'objectId' } } },
      { $group: { _id: '$consultancyId' } },
      { $count: 'total' },
    ]),
    CrmAuditLog.findOne(filters.business).sort({ createdAt: -1 }).select('createdAt').lean(),
    CrmAuthAuditLog.findOne(filters.security).sort({ createdAt: -1 }).select('createdAt').lean(),
    CrmAuditLog.aggregate([
      { $match: filters.business },
      { $group: { _id: dayExpr, count: { $sum: 1 } } },
    ]),
    CrmAuthAuditLog.aggregate([
      { $match: filters.security },
      { $group: { _id: dayExpr, count: { $sum: 1 } } },
    ]),
    CrmAuditLog.aggregate([
      { $match: andFilters([filters.business, { actorCrmUserId: { $type: 'objectId' } }]) },
      {
        $group: {
          _id: '$actorCrmUserId',
          businessEvents: { $sum: 1 },
          lastAt: { $max: '$createdAt' },
        },
      },
      { $sort: { businessEvents: -1, lastAt: -1 } },
      { $limit: 20 },
    ]),
  ]);
  const byAction = (rows) => rows
    .map((row) => ({ action: row._id, count: row.count }))
    .sort((left, right) => right.count - left.count || String(left.action).localeCompare(String(right.action)));
  const staffIds = staffRows.map((row) => row._id);
  const staffPeople = staffIds.length
    ? await CrmUser.find({ _id: { $in: staffIds } }).select('fullName email role status').lean()
    : [];
  const staffById = new Map(staffPeople.map((row) => [String(row._id), row]));
  const lastCandidates = [businessLast && businessLast.createdAt, securityLast && securityLast.createdAt]
    .filter(Boolean)
    .map((value) => new Date(value).getTime());
  return {
    visibility: 'visible_to_caller',
    recordScope: filters.recordScope,
    aggregateScope: filters.recordScope,
    scopeBasis: filters.scopeBasis,
    accountEventsIncluded,
    timeZone,
    timeZoneConfirmed: false,
    order: recent.order,
    business: { total: businessTotal, byAction: byAction(businessActions) },
    security: {
      total: securityTotal,
      byAction: byAction(securityActions),
      signInFailed: accountEventsIncluded ? actionCount(securityActions, 'crm_user.login_failed') : null,
      signInInactive: accountEventsIncluded ? actionCount(securityActions, 'crm_user.login_inactive') : null,
      sessionRevocations: accountEventsIncluded
        ? actionCount(securityActions, 'crm_session.revoked') + actionCount(securityActions, 'crm_session.revoked_all')
        : null,
      assignmentCreated: actionCount(securityActions, 'crm_assignment.created'),
      assignmentRevoked: actionCount(securityActions, 'crm_assignment.revoked'),
    },
    insights: {
      meaning: {
        businessActions: 'Recorded successful business audit events in the selected filters.',
        activeCrmUsers: 'Distinct CRM accounts that appear as actors on business events in this range.',
        consultanciesTouched: 'Distinct consultancies referenced by business events in this range.',
        recordsCreated: 'Business create-style actions recorded in this range.',
        recordsUpdated: 'Business update-style actions recorded in this range.',
        securityEvents: 'Authentication, assignment, and account-security events visible to this caller.',
        lastActivityAt: 'Newest recorded business or security event in this filtered view.',
        staffBusinessEvents: 'Business audit events attributed to that CRM actor. Not a productivity score.',
      },
      activeCrmUsers: activeActorRows[0] ? activeActorRows[0].total : 0,
      consultanciesTouched: consultancyRows[0] ? consultancyRows[0].total : 0,
      recordsCreated: countNamedActions(businessActions, CREATE_ACTIONS),
      recordsUpdated: countNamedActions(businessActions, UPDATE_ACTIONS),
      lastActivityAt: lastCandidates.length ? new Date(Math.max(...lastCandidates)).toISOString() : null,
    },
    series: {
      grain: 'day',
      timeZone,
      business: daySeries(businessDays, parsed.from, parsed.to, timeZone),
      security: daySeries(securityDays, parsed.from, parsed.to, timeZone),
    },
    staff: staffRows.map((row) => {
      const person = staffById.get(String(row._id));
      return {
        userId: String(row._id),
        fullName: person ? person.fullName : '',
        email: person ? person.email : null,
        role: person ? person.role : null,
        status: person ? person.status : null,
        businessEvents: row.businessEvents,
        lastBusinessAt: row.lastAt || null,
      };
    }),
    recent: recent.items,
  };
}

module.exports = {
  listActivity,
  getActivity,
  summarizeActivity,
  activityScope,
  canViewAccountSecurity,
};
