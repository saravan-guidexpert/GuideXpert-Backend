'use strict';

const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmUser = require('../../models/CrmUser');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { commitWithAudit } = require('../../utils/crmMutation');
const { writeAuthAudit } = require('./crmAuthAudit');

function canManage(actor) {
  if (!actor) return false;
  if (actor.kind === 'admin') return true;
  return actor.kind === 'crm-user' && (actor.permissions || []).includes('crm.roles.manage');
}

function assertManager(actor) {
  if (!canManage(actor)) {
    throw new CrmError(403, 'You do not have permission to manage consultancy assignments.', 'permission_denied');
  }
}

function canReadUserAssignments(actor, userId) {
  if (canManage(actor)) return true;
  return actor && actor.kind === 'crm-user' && String(actor.id) === String(userId);
}

function authorship(actor) {
  if (actor.kind === 'admin') return { createdByAdminId: actor.id, createdByCrmUserId: null };
  return { createdByAdminId: null, createdByCrmUserId: actor.id };
}

function auditActor(actor) {
  if (actor.kind === 'admin') return { actorAdminId: actor.id };
  return { actorCrmUserId: actor.id };
}

function duplicateKey(err) {
  let current = err;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (isMongoDuplicateKeyError(current)) return true;
    current = current.cause || current.errorResponse || null;
  }
  return false;
}

async function insertActiveAssignment(fields, session) {
  const created = await CrmConsultancyAssignment.create([fields], { session });
  return created[0];
}

async function present(row) {
  const [user, consultancy] = await Promise.all([
    CrmUser.findById(row.crmUserId).select('fullName email status').lean(),
    CrmConsultancy.findById(row.consultancyId).select('name status').lean(),
  ]);
  return {
    id: String(row._id),
    consultancyId: String(row.consultancyId),
    consultancyName: consultancy ? consultancy.name : '',
    consultancyStatus: consultancy ? consultancy.status : null,
    crmUserId: String(row.crmUserId),
    userName: user ? user.fullName : '',
    userEmail: user ? user.email : '',
    userStatus: user ? user.status : null,
    revokedAt: row.revokedAt || null,
    createdAt: row.createdAt,
    createdByAdminId: row.createdByAdminId ? String(row.createdByAdminId) : null,
    createdByCrmUserId: row.createdByCrmUserId ? String(row.createdByCrmUserId) : null,
  };
}

async function requireActiveUser(userId) {
  const user = await CrmUser.findOne({ _id: userId, deletedAt: null });
  if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
  if (user.status !== 'active') {
    throw new CrmError(409, 'Only an active CRM user can hold a consultancy assignment.', 'assignee_not_eligible');
  }
  return user;
}

async function requireConsultancy(consultancyId) {
  const consultancy = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null });
  if (!consultancy) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  return consultancy;
}

async function listForUser(actor, userIdParam, query) {
  const userId = parseObjectId(userIdParam, 'User id');
  if (!canReadUserAssignments(actor, userId)) {
    throw new CrmError(403, 'You do not have permission to view these assignments.', 'permission_denied');
  }
  const exists = await CrmUser.exists({ _id: userId, deletedAt: null });
  if (!exists) throw new CrmError(404, 'CRM user not found.', 'not_found');
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { crmUserId: userId, revokedAt: null };
  const [rows, total] = await Promise.all([
    CrmConsultancyAssignment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmConsultancyAssignment.countDocuments(filter),
  ]);
  return { items: await Promise.all(rows.map(present)), page, limit, total };
}

async function listForConsultancy(actor, consultancyIdParam, query) {
  assertManager(actor);
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  await requireConsultancy(consultancyId);
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { consultancyId, revokedAt: null };
  const [rows, total] = await Promise.all([
    CrmConsultancyAssignment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmConsultancyAssignment.countDocuments(filter),
  ]);
  return { items: await Promise.all(rows.map(present)), page, limit, total };
}

async function assign(actor, userIdParam, body, req) {
  assertManager(actor);
  const userId = parseObjectId(userIdParam, 'User id');
  const consultancyId = parseObjectId(body && body.consultancyId, 'Consultancy id');
  await requireActiveUser(userId);
  await requireConsultancy(consultancyId);
  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const currentUser = await CrmUser.findOne({ _id: userId, deletedAt: null, status: 'active' }).session(session);
        if (!currentUser) {
          throw new CrmError(409, 'Only an active CRM user can hold a consultancy assignment.', 'assignee_not_eligible');
        }
        const consultancy = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null }).session(session);
        if (!consultancy) throw new CrmError(404, 'Consultancy not found.', 'not_found');
        return insertActiveAssignment({
          consultancyId,
          crmUserId: userId,
          revokedAt: null,
          ...authorship(actor),
        }, session);
      },
      audit: (session, row) => writeAuthAudit({
        ...auditActor(actor),
        targetUserId: row.crmUserId,
        action: 'crm_assignment.created',
        after: { consultancyId: String(row.consultancyId), status: 'active' },
      }, req, session),
    });
    return present(payload);
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (duplicateKey(err)) {
      throw new CrmError(409, 'This user is already assigned to that consultancy.', 'duplicate_assignment');
    }
    throw err;
  }
}

async function revoke(actor, userIdParam, consultancyIdParam, req) {
  assertManager(actor);
  const userId = parseObjectId(userIdParam, 'User id');
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  const exists = await CrmUser.exists({ _id: userId, deletedAt: null });
  if (!exists) throw new CrmError(404, 'CRM user not found.', 'not_found');
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      // Every active row for this pair is revoked in this transaction. A concurrent
      // insert of a different document can still commit while the unique partial
      // index is absent; that index remains what rejects the second active row.
      const rows = await CrmConsultancyAssignment.find({
        crmUserId: userId,
        consultancyId,
        revokedAt: null,
      }).session(session);
      if (rows.length === 0) throw new CrmError(404, 'Assignment not found.', 'not_found');
      const revokedAt = new Date();
      for (const current of rows) {
        current.revokedAt = revokedAt;
        if (actor.kind === 'admin') current.revokedByAdminId = actor.id;
        else current.revokedByCrmUserId = actor.id;
        await current.save({ session });
      }
      return {
        primary: rows[0],
        consultancyId,
        crmUserId: userId,
        revokedCount: rows.length,
      };
    },
    audit: (session, saved) => writeAuthAudit({
      ...auditActor(actor),
      targetUserId: saved.crmUserId,
      action: 'crm_assignment.revoked',
      before: {
        consultancyId: String(saved.consultancyId),
        status: 'active',
        activeCount: saved.revokedCount,
      },
      after: {
        consultancyId: String(saved.consultancyId),
        status: 'revoked',
        revokedCount: saved.revokedCount,
      },
    }, req, session),
  });
  return present(payload.primary);
}

module.exports = {
  insertActiveAssignment,
  listForUser,
  listForConsultancy,
  assign,
  revoke,
};
