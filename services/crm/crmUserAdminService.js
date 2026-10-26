'use strict';

const CrmUser = require('../../models/CrmUser');
const CrmSession = require('../../models/CrmSession');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { escapeRegex, parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const {
  CRM_ACCOUNT_STATUSES,
  CRM_PRIVILEGED_PERMISSIONS,
  CRM_ROLES,
  CRM_ROLE_KEYS,
  permissionSummary,
} = require('../../constants/crmUsers');
const { hashPassword, validatePassword } = require('./crmUserPassword');
const { accountSnapshot, writeAuthAudit } = require('./crmAuthAudit');
const { invalidateOutstandingResetTokens, issuePasswordToken } = require('./crmPasswordResetService');
const { commitWithAudit } = require('../../utils/crmMutation');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function requireEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 200 || !EMAIL_PATTERN.test(email)) {
    throw new CrmError(400, 'Enter a valid email.', 'invalid_body');
  }
  return email;
}

function requireName(value) {
  if (typeof value !== 'string') throw new CrmError(400, 'Full name is required.', 'invalid_body');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new CrmError(400, 'Full name must be 2–120 characters.', 'invalid_body');
  }
  return name;
}

function requireUsername(value, email) {
  const username = value == null || value === '' ? email : normalizeUsername(value);
  if (!/^[a-z0-9._@+-]{3,120}$/.test(username)) {
    throw new CrmError(400, 'Username must be 3–120 characters and use letters, numbers, or . _ @ + -.', 'invalid_body');
  }
  return username;
}

function samePermissions(left, right) {
  const a = [...(left || [])].sort();
  const b = [...(right || [])].sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function resolveAccess(role, requested) {
  if (!CRM_ROLE_KEYS.includes(role)) {
    throw new CrmError(400, 'Choose a CRM role.', 'invalid_role');
  }
  const allowed = CRM_ROLES[role].permissions;
  if (requested == null) return [...allowed];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new CrmError(400, 'Select at least one permission.', 'invalid_permissions');
  }
  const unique = [];
  requested.forEach((key) => {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new CrmError(400, 'Permissions must belong to the selected role.', 'invalid_permissions');
    }
    if (!unique.includes(key)) unique.push(key);
  });
  return unique;
}

function isPrivileged(user) {
  if (!user || user.deletedAt || user.status !== 'active') return false;
  const granted = user.permissions || [];
  return CRM_PRIVILEGED_PERMISSIONS.every((key) => granted.includes(key));
}

function duplicateKey(err) {
  let current = err;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (isMongoDuplicateKeyError(current)) return true;
    current = current.cause || current.errorResponse || null;
  }
  return false;
}

async function otherPrivilegedCount(userId, session) {
  const query = CrmUser.countDocuments({
    _id: { $ne: userId },
    deletedAt: null,
    status: 'active',
    permissions: { $all: CRM_PRIVILEGED_PERMISSIONS },
  });
  if (session) query.session(session);
  return query;
}

async function assertKeepsPrivilegedAccount(existing, next, session) {
  if (!isPrivileged(existing) || isPrivileged(next)) return;
  const others = await otherPrivilegedCount(existing._id, session);
  if (others < 1) {
    throw new CrmError(
      409,
      'The last CRM administrator who can manage accounts cannot be removed or demoted.',
      'last_privileged_account'
    );
  }
}

function assertActorCanGrant(actor, role, permissions) {
  if (!actor || actor.kind === 'admin') return;
  const granted = actor.permissions || [];
  const actorRole = CRM_ROLES[actor.role];
  const targetRole = CRM_ROLES[role];
  if (!actorRole || !targetRole || targetRole.rank > actorRole.rank) {
    throw new CrmError(403, 'You cannot assign a role above your own.', 'privilege_escalation');
  }
  const missing = permissions.filter((key) => !granted.includes(key));
  if (missing.length > 0) {
    throw new CrmError(403, 'You cannot grant permissions you do not have.', 'privilege_escalation');
  }
}

function actorFields(actor, existing) {
  if (actor.kind === 'admin') {
    return {
      createdByAdminId: existing ? existing.createdByAdminId : actor.id,
      updatedByAdminId: actor.id,
      createdByCrmUserId: existing ? existing.createdByCrmUserId : null,
      updatedByCrmUserId: null,
    };
  }
  return {
    createdByAdminId: existing ? existing.createdByAdminId : null,
    updatedByAdminId: existing ? existing.updatedByAdminId : null,
    createdByCrmUserId: existing ? existing.createdByCrmUserId : actor.id,
    updatedByCrmUserId: actor.id,
  };
}

function auditActor(actor) {
  if (actor.kind === 'admin') return { actorAdminId: actor.id };
  return { actorCrmUserId: actor.id };
}

function toDTO(user) {
  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email,
    username: user.username,
    role: user.role,
    roleLabel: CRM_ROLES[user.role] ? CRM_ROLES[user.role].label : user.role,
    permissions,
    permissionSummary: permissionSummary(permissions),
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
    createdByAdminId: user.createdByAdminId ? String(user.createdByAdminId) : null,
    updatedByAdminId: user.updatedByAdminId ? String(user.updatedByAdminId) : null,
    createdByCrmUserId: user.createdByCrmUserId ? String(user.createdByCrmUserId) : null,
    updatedByCrmUserId: user.updatedByCrmUserId ? String(user.updatedByCrmUserId) : null,
  };
}

async function revokeSessions(user, session) {
  if (!session) {
    throw new CrmError(
      503,
      'This change requires a MongoDB transaction, and this database does not support transactions. Nothing was changed.',
      'transaction_required'
    );
  }
  user.sessionVersion = (user.sessionVersion || 1) + 1;
  await CrmSession.updateMany(
    { userId: user._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { session }
  );
}

async function summary() {
  const base = { deletedAt: null };
  const [total, active, inactive, invited, grouped, recent] = await Promise.all([
    CrmUser.countDocuments(base),
    CrmUser.countDocuments({ ...base, status: 'active' }),
    CrmUser.countDocuments({ ...base, status: 'inactive' }),
    CrmUser.countDocuments({ ...base, status: 'invited' }),
    CrmUser.aggregate([
      { $match: base },
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]),
    CrmUser.find(base).sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  const counts = new Map(grouped.map((row) => [row._id, row.count]));
  return {
    total,
    active,
    inactive,
    invited,
    byRole: CRM_ROLE_KEYS.map((role) => ({
      role,
      label: CRM_ROLES[role].label,
      count: counts.get(role) || 0,
    })),
    recent: recent.map(toDTO),
  };
}

async function listUsers(query) {
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { deletedAt: null };
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
  if (query.role) {
    if (!CRM_ROLE_KEYS.includes(query.role)) throw new CrmError(400, 'Role filter is not valid.', 'invalid_query');
    filter.role = query.role;
  }
  if (query.status) {
    if (!CRM_ACCOUNT_STATUSES.includes(query.status)) {
      throw new CrmError(400, 'Status filter is not valid.', 'invalid_query');
    }
    filter.status = query.status;
  }
  const [rows, total] = await Promise.all([
    CrmUser.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmUser.countDocuments(filter),
  ]);
  return { items: rows.map(toDTO), page, limit, total };
}

async function getUser(id) {
  const user = await CrmUser.findOne({ _id: parseObjectId(id, 'User id'), deletedAt: null }).lean();
  if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
  return toDTO(user);
}

function rejectAssignmentFields(body) {
  const forbidden = ['assignments', 'consultancyIds', 'consultancyId', 'ownerId'];
  if (forbidden.some((key) => body && Object.prototype.hasOwnProperty.call(body, key))) {
    throw new CrmError(400, 'Assignments are changed through the assignment endpoint.', 'invalid_body');
  }
}

function rejectPresenceFields(body) {
  const forbidden = ['lastSeenAt', 'sessionId', 'sessions', 'presence', 'revokedAt'];
  if (forbidden.some((key) => body && Object.prototype.hasOwnProperty.call(body, key))) {
    throw new CrmError(400, 'Session presence cannot be changed through the account endpoint.', 'invalid_body');
  }
}

async function createUser(actor, body, req) {
  rejectAssignmentFields(body);
  rejectPresenceFields(body);
  if (actor.kind === 'crm-user' && !(actor.permissions || []).includes('crm.users.create')) {
    throw new CrmError(403, 'You do not have permission to create CRM users.', 'permission_denied');
  }
  const email = requireEmail(body.email);
  const username = requireUsername(body.username, email);
  const fullName = requireName(body.fullName);
  const role = body.role;
  const permissions = resolveAccess(role, body.permissions);
  assertActorCanGrant(actor, role, permissions);
  const invite = body.invite === true;
  const password = typeof body.password === 'string' ? body.password : '';
  if (invite === password.length > 0) {
    throw new CrmError(400, 'Provide an initial password or a one-time setup code, not both.', 'invalid_body');
  }
  if (!invite) validatePassword(password, [email, username]);
  let status = body.status == null || body.status === '' ? 'active' : body.status;
  if (invite) status = 'invited';
  if (!CRM_ACCOUNT_STATUSES.includes(status) || status === 'invited' && !invite) {
    throw new CrmError(400, 'Status must be active or inactive.', 'invalid_body');
  }
  const authorship = actorFields(actor, null);
  const passwordHash = invite ? '' : await hashPassword(password);
  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const created = await CrmUser.create([{
          email,
          username,
          fullName,
          passwordHash,
          status,
          role,
          permissions,
          passwordChangedAt: invite ? null : new Date(),
          ...authorship,
        }], { session });
        const user = created[0];
        const setup = invite ? await issuePasswordToken(user, actor, 'invite', session) : null;
        return { user, setup };
      },
      audit: (session, created) => writeAuthAudit({
        ...auditActor(actor),
        targetUserId: created.user._id,
        action: invite ? 'crm_user.invited' : 'crm_user.created',
        after: accountSnapshot(created.user),
      }, req, session),
    });
    const data = { user: toDTO(payload.user) };
    if (payload.setup) {
      data.setupToken = payload.setup.token;
      data.setupTokenExpiresAt = payload.setup.expiresAt;
      data.delivery = 'admin_display';
    }
    return data;
  } catch (err) {
    if (duplicateKey(err)) {
      throw new CrmError(409, 'An account with this email or username already exists.', 'duplicate_account');
    }
    throw err;
  }
}

function accessWillChange(existing, role, permissions) {
  return existing.role !== role || !samePermissions(existing.permissions, permissions);
}

async function updateUser(actor, id, body, req, options = {}) {
  rejectAssignmentFields(body);
  rejectPresenceFields(body);
  const actorPermissions = actor.permissions || [];
  if (!options.skipBasePermission && actor.kind === 'crm-user' && !actorPermissions.includes('crm.users.update')) {
    throw new CrmError(403, 'You do not have permission to update CRM users.', 'permission_denied');
  }
  const existing = await CrmUser.findOne({ _id: parseObjectId(id, 'User id'), deletedAt: null }).select('+passwordHash');
  if (!existing) throw new CrmError(404, 'CRM user not found.', 'not_found');
  const before = accountSnapshot(existing);
  if (body.email != null) existing.email = requireEmail(body.email);
  if (body.username != null) existing.username = requireUsername(body.username, existing.email);
  if (body.fullName != null) existing.fullName = requireName(body.fullName);
  const nextRole = body.role == null ? existing.role : body.role;
  const nextPermissions = body.permissions == null && body.role == null
    ? [...existing.permissions]
    : resolveAccess(nextRole, body.permissions == null ? undefined : body.permissions);
  if (accessWillChange(existing, nextRole, nextPermissions)) {
    if (actor.kind === 'crm-user' && !(actor.permissions || []).includes('crm.roles.manage')) {
      throw new CrmError(403, 'You cannot change roles or permissions.', 'privilege_escalation');
    }
    assertActorCanGrant(actor, nextRole, nextPermissions);
  }
  const nextStatus = body.status == null ? existing.status : body.status;
  if (!CRM_ACCOUNT_STATUSES.includes(nextStatus) || nextStatus === 'invited') {
    throw new CrmError(400, 'Status must be active or inactive.', 'invalid_body');
  }
  if (nextStatus !== existing.status && actor.kind === 'crm-user') {
    const needed = nextStatus === 'inactive' ? 'crm.users.deactivate' : 'crm.users.update';
    if (!actorPermissions.includes(needed)) {
      throw new CrmError(403, 'You do not have permission for this account action.', 'permission_denied');
    }
  }
  if (actor.kind === 'crm-user' && String(actor.id) === String(existing._id) && nextStatus !== 'active') {
    throw new CrmError(409, 'You cannot deactivate your own account.', 'self_deactivation');
  }
  await assertKeepsPrivilegedAccount(existing, {
    status: nextStatus,
    deletedAt: null,
    permissions: nextPermissions,
  });
  const nextEmail = existing.email;
  const nextUsername = existing.username;
  const nextName = existing.fullName;
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const current = await CrmUser.findOne({ _id: existing._id, deletedAt: null }).session(session).select('+passwordHash');
        if (!current) throw new CrmError(404, 'CRM user not found.', 'not_found');
        await assertKeepsPrivilegedAccount(current, {
          status: nextStatus,
          deletedAt: null,
          permissions: nextPermissions,
        }, session);
        const wasActive = current.status === 'active';
        current.email = nextEmail;
        current.username = nextUsername;
        current.fullName = nextName;
        current.role = nextRole;
        current.permissions = nextPermissions;
        current.status = nextStatus;
        const authorship = actorFields(actor, current);
        current.updatedByAdminId = authorship.updatedByAdminId;
        current.updatedByCrmUserId = authorship.updatedByCrmUserId;
        if (wasActive && nextStatus !== 'active') await revokeSessions(current, session);
        await current.save({ session });
        return { user: current, deactivated: wasActive && nextStatus !== 'active' };
      },
      audit: (session, saved) => writeAuthAudit({
        ...auditActor(actor),
        targetUserId: saved.user._id,
        action: saved.deactivated ? 'crm_user.deactivated' : 'crm_user.updated',
        reason,
        before,
        after: accountSnapshot(saved.user),
      }, req, session),
    });
    return { user: toDTO(payload.user) };
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (duplicateKey(err)) {
      throw new CrmError(409, 'An account with this email or username already exists.', 'duplicate_account');
    }
    throw err;
  }
}

async function setStatus(actor, id, status, req, reason) {
  const permission = status === 'inactive' ? 'crm.users.deactivate' : 'crm.users.update';
  if (actor.kind === 'crm-user' && !(actor.permissions || []).includes(permission)) {
    throw new CrmError(403, 'You do not have permission for this account action.', 'permission_denied');
  }
  return updateUser(actor, id, { status, reason }, req, { skipBasePermission: true });
}

async function resetPassword(actor, id, body, req) {
  if (actor.kind === 'crm-user' && !(actor.permissions || []).includes('crm.users.update')) {
    throw new CrmError(403, 'You do not have permission to reset CRM passwords.', 'permission_denied');
  }
  const user = await CrmUser.findOne({ _id: parseObjectId(id, 'User id'), deletedAt: null }).select('+passwordHash');
  if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
  if (body && body.issueToken === true) {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const current = await CrmUser.findOne({ _id: user._id, deletedAt: null }).session(session);
        if (!current) throw new CrmError(404, 'CRM user not found.', 'not_found');
        const issued = await issuePasswordToken(current, actor, 'reset', session);
        return { issued, user: current };
      },
      audit: (session, saved) => writeAuthAudit({
        ...auditActor(actor),
        targetUserId: saved.user._id,
        action: 'crm_user.reset_issued',
        before: accountSnapshot(saved.user),
        after: accountSnapshot(saved.user),
      }, req, session),
    });
    return {
      delivery: 'admin_display',
      resetToken: payload.issued.token,
      resetTokenExpiresAt: payload.issued.expiresAt,
      user: toDTO(payload.user),
    };
  }
  const password = body && typeof body.password === 'string' ? body.password : '';
  validatePassword(password, [user.email, user.username]);
  const passwordHash = await hashPassword(password);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const current = await CrmUser.findOne({ _id: user._id, deletedAt: null }).session(session).select('+passwordHash');
      if (!current) throw new CrmError(404, 'CRM user not found.', 'not_found');
      const before = accountSnapshot(current);
      await invalidateOutstandingResetTokens(current._id, session);
      current.passwordHash = passwordHash;
      current.passwordChangedAt = new Date();
      if (current.status === 'invited') current.status = 'active';
      await revokeSessions(current, session);
      const authorship = actorFields(actor, current);
      current.updatedByAdminId = authorship.updatedByAdminId;
      current.updatedByCrmUserId = authorship.updatedByCrmUserId;
      await current.save({ session });
      return { before, user: current };
    },
    audit: (session, saved) => writeAuthAudit({
      ...auditActor(actor),
      targetUserId: saved.user._id,
      action: 'crm_user.password_reset',
      before: saved.before,
      after: accountSnapshot(saved.user),
    }, req, session),
  });
  return { user: toDTO(payload.user), delivery: 'password_set' };
}

async function listUserAudit(id, query) {
  const userId = parseObjectId(id, 'User id');
  const exists = await CrmUser.exists({ _id: userId, deletedAt: null });
  if (!exists) throw new CrmError(404, 'CRM user not found.', 'not_found');
  const { page, limit, skip } = parsePageLimit(query);
  const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
  const filter = { targetUserId: userId };
  const [rows, total] = await Promise.all([
    CrmAuthAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CrmAuthAuditLog.countDocuments(filter),
  ]);
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      action: row.action,
      reason: row.reason || '',
      before: row.before || null,
      after: row.after || null,
      actorAdminId: row.actorAdminId ? String(row.actorAdminId) : null,
      actorCrmUserId: row.actorCrmUserId ? String(row.actorCrmUserId) : null,
      ip: row.ip || null,
      userAgent: row.userAgent || null,
      createdAt: row.createdAt,
    })),
    page,
    limit,
    total,
  };
}

module.exports = {
  summary,
  listUsers,
  getUser,
  createUser,
  updateUser,
  setStatus,
  resetPassword,
  listUserAudit,
  toDTO,
  normalizeEmail,
  isPrivileged,
  revokeSessions,
};
