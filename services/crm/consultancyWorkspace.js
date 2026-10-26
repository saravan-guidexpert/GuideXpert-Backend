'use strict';

const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyContact = require('../../models/CrmConsultancyContact');
const CrmConsultancyFollowUp = require('../../models/CrmConsultancyFollowUp');
const CrmConsultancyRemark = require('../../models/CrmConsultancyRemark');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmUser = require('../../models/CrmUser');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { commitWithAudit } = require('../../utils/crmMutation');
const { writeAudit } = require('./auditService');
const { writeAuthAudit } = require('./crmAuthAudit');
const { insertActiveAssignment } = require('./crmAssignmentService');
const { assertConsultancyAccess, isCrmActor } = require('./crmAccess');
const { auditActor, actorId } = require('./fields');
const { presentConsultancy } = require('./consultancyService');
const {
  actorName,
  authorStamp,
  sameAuthor,
  boundedText,
  remarkText,
  parseDate,
  applyCallingChange,
  earliestOpenFollowUp,
  OPEN_FOLLOW_UP_STATUSES,
  REMARK_MAX,
} = require('./consultancyWorkflow');
const { CONSULTANCY_FOLLOW_UP_STATUSES, CALLING_STATUSES, FOLLOW_UP_PIPELINE } = require('../../constants/crm');

function accessActor(actor) {
  if (isCrmActor(actor)) return actor;
  if (actor && actor.actorType === 'crm-user') return actor;
  if (actor && actor.kind === 'crm-user') return { _id: actor.id, actorType: 'crm-user' };
  if (actor && actor.kind === 'admin') return actor.id;
  return actor;
}

function followUpType(status) {
  if (status === 'Meeting Scheduled' || status === 'Meeting Completed' || status === 'Contacted') return 'call';
  return 'follow_up';
}

function toRemark(row) {
  return {
    id: String(row._id),
    consultancyId: String(row.consultancyId),
    text: row.text,
    authorId: row.authorCrmUserId ? String(row.authorCrmUserId) : (row.authorAdminId ? String(row.authorAdminId) : null),
    authorName: row.authorName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    previousText: row.previousText || null,
    history: (row.history || []).map((item) => ({ text: item.text, updatedAt: item.updatedAt })),
  };
}

function toFollowUp(row) {
  return {
    id: String(row._id),
    consultancyId: String(row.consultancyId),
    contactId: row.contactId ? String(row.contactId) : null,
    type: row.type,
    status: row.status,
    scheduledAt: row.scheduledAt || null,
    completedAt: row.completedAt || null,
    cancelledAt: row.cancelledAt || null,
    outcome: row.outcome || '',
    nextAction: row.nextAction || '',
    reason: row.reason || '',
    notes: row.notes || '',
    actorId: row.createdByCrmUserId ? String(row.createdByCrmUserId) : (row.createdByAdminId ? String(row.createdByAdminId) : null),
    actorName: row.actorName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadConsultancy(id, actor, session) {
  const consultancyId = parseObjectId(id, 'Consultancy id');
  await assertConsultancyAccess(accessActor(actor), consultancyId, session);
  const query = CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null });
  if (session) query.session(session);
  const doc = await query;
  if (!doc) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  return doc;
}

async function listRemarks(consultancyId, query, actor) {
  const doc = await loadConsultancy(consultancyId, actor);
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { consultancyId: doc._id };
  const [rows, total] = await Promise.all([
    CrmConsultancyRemark.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmConsultancyRemark.countDocuments(filter),
  ]);
  return { items: rows.map(toRemark), page, limit, total };
}

async function addRemark(actor, consultancyId, body, meta) {
  const text = remarkText(body && body.text);
  const stamp = authorStamp(actor);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consultancy = await loadConsultancy(consultancyId, actor, session);
      const created = await CrmConsultancyRemark.create([{
        consultancyId: consultancy._id,
        text,
        authorAdminId: stamp.authorAdminId,
        authorCrmUserId: stamp.authorCrmUserId,
        authorName: stamp.authorName,
        previousText: null,
        history: [],
      }], { session });
      consultancy.updatedBy = actorId(actor);
      await consultancy.save({ session });
      return { consultancy, remark: created[0] };
    },
    audit: async (session, saved) => {
      await writeAudit({
        ...auditActor(actor),
        action: 'consultancy.remark_added',
        entityType: 'consultancy',
        entityId: saved.consultancy._id,
        after: { remarkId: String(saved.remark._id) },
        ip: meta && meta.ip,
        userAgent: meta && meta.userAgent,
      }, session);
    },
  });
  return { remark: toRemark(payload.remark), consultancy: await presentConsultancy(payload.consultancy) };
}

async function editRemark(actor, consultancyId, remarkIdParam, body, meta) {
  const remarkId = parseObjectId(remarkIdParam, 'Remark id');
  const text = remarkText(body && body.text);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consultancy = await loadConsultancy(consultancyId, actor, session);
      const remark = await CrmConsultancyRemark.findOne({ _id: remarkId, consultancyId: consultancy._id }).session(session);
      if (!remark) throw new CrmError(404, 'Remark not found.', 'not_found');
      if (!sameAuthor(remark, actor)) {
        throw new CrmError(403, 'Only the author can edit this remark.', 'remark_forbidden');
      }
      if (remark.text === text) return { consultancy, remark, unchanged: true };
      remark.history = Array.isArray(remark.history) ? remark.history : [];
      remark.history.push({ text: remark.text, updatedAt: remark.updatedAt });
      remark.previousText = remark.text;
      remark.text = text;
      await remark.save({ session });
      return { consultancy, remark, unchanged: false };
    },
    audit: async (session, saved) => {
      if (saved.unchanged) return;
      await writeAudit({
        ...auditActor(actor),
        action: 'consultancy.remark_edited',
        entityType: 'consultancy',
        entityId: saved.consultancy._id,
        after: { remarkId: String(saved.remark._id) },
        ip: meta && meta.ip,
        userAgent: meta && meta.userAgent,
      }, session);
    },
  });
  return { remark: toRemark(payload.remark) };
}

function validateFollowUpBody(body, now) {
  const source = body || {};
  const hasStatus = source.consultancyStatus != null || source.followUpStatus != null;
  const status = hasStatus ? (source.consultancyStatus || source.followUpStatus) : null;
  const hasCalling = Object.prototype.hasOwnProperty.call(source, 'callingStatus');
  const calling = hasCalling ? source.callingStatus : null;
  if (!hasStatus && !hasCalling) {
    throw new CrmError(400, 'Choose a consultancy status or a calling status.', 'invalid_body');
  }
  if (hasStatus && !CONSULTANCY_FOLLOW_UP_STATUSES.includes(status)) {
    throw new CrmError(400, 'Choose a consultancy status.', 'invalid_body');
  }
  if (hasCalling && calling && !CALLING_STATUSES.includes(calling)) {
    throw new CrmError(400, 'Choose a calling status.', 'invalid_body');
  }
  const notes = boundedText(source.notes, 'Remark', REMARK_MAX);
  const outcome = boundedText(source.outcome, 'Outcome', 160);
  const nextAction = boundedText(source.nextAction, 'Next action', 160);
  const reason = boundedText(source.reason, 'Reason', REMARK_MAX);
  let scheduledAt = null;
  if (status === 'Meeting Scheduled') {
    const when = parseDate(source.scheduledAt, 'Meeting date');
    if (when.getTime() <= now.getTime()) {
      throw new CrmError(400, 'Meeting Scheduled needs a future date and time.', 'invalid_body');
    }
    scheduledAt = when;
  }
  if (status === 'Meeting Completed' && (outcome.length < 2 || notes.length < 1)) {
    throw new CrmError(400, 'Meeting Completed needs an outcome and a remark.', 'invalid_body');
  }
  if (status === 'Follow-up Required') {
    if (nextAction.length < 2) {
      throw new CrmError(400, 'Follow-up Required needs a next action and a date.', 'invalid_body');
    }
    scheduledAt = parseDate(source.scheduledAt, 'Follow-up date');
  }
  if (status === 'Not Interested' && reason.length < 2 && notes.length < 2) {
    throw new CrmError(400, 'Not Interested needs a reason.', 'invalid_body');
  }
  return { hasStatus, status, hasCalling, calling: calling || '', notes, outcome, nextAction, reason, scheduledAt };
}

function applyStatusDates(doc, parsed, body, now) {
  const { status, scheduledAt } = parsed;
  if (status === 'Meeting Scheduled' || status === 'Follow-up Required') {
    doc.nextFollowUpAt = scheduledAt;
    return;
  }
  if (status === 'Meeting Completed' || status === 'Contacted') {
    doc.lastContactAt = now;
    if (body && body.nextFollowUpAt) {
      doc.nextFollowUpAt = parseDate(body.nextFollowUpAt, 'Next follow-up');
    } else if (status === 'Meeting Completed') {
      doc.nextFollowUpAt = null;
    }
    return;
  }
  if ((status === 'Interested' || status === 'On Hold' || status === 'Onboarding in Progress' || status === 'On - Boarded') && body && body.scheduledAt) {
    doc.nextFollowUpAt = parseDate(body.scheduledAt, 'Date');
    return;
  }
  if (status === 'Fresh Lead' || status === 'Not Interested' || status === 'Discontinued') {
    doc.nextFollowUpAt = null;
  }
}

async function listFollowUps(consultancyId, query, actor) {
  const doc = await loadConsultancy(consultancyId, actor);
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { consultancyId: doc._id };
  const [rows, total] = await Promise.all([
    CrmConsultancyFollowUp.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmConsultancyFollowUp.countDocuments(filter),
  ]);
  return { items: rows.map(toFollowUp), page, limit, total };
}

async function recordFollowUp(actor, consultancyId, body, meta, now = new Date()) {
  const parsed = validateFollowUpBody(body, now);
  const stamp = authorStamp(actor);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consultancy = await loadConsultancy(consultancyId, actor, session);
      const before = {
        followUpStatus: consultancy.followUpStatus,
        callingStatus: consultancy.callingStatus || '',
        pipelineStage: consultancy.pipelineStage,
        lastContactAt: consultancy.lastContactAt,
        nextFollowUpAt: consultancy.nextFollowUpAt,
      };
      if (parsed.hasCalling) applyCallingChange(consultancy, parsed.calling, actor, now);
      let followUp = null;
      let remark = null;
      if (parsed.hasStatus) {
        consultancy.followUpStatus = parsed.status;
        consultancy.pipelineStage = FOLLOW_UP_PIPELINE[parsed.status];
        applyStatusDates(consultancy, parsed, body, now);
        let contactId = null;
        if (body && body.contactId) {
          contactId = parseObjectId(body.contactId, 'Contact id');
          const contact = await CrmConsultancyContact.findOne({ _id: contactId, consultancyId: consultancy._id }).session(session);
          if (!contact) throw new CrmError(404, 'Contact not found.', 'not_found');
        }
        const created = await CrmConsultancyFollowUp.create([{
          consultancyId: consultancy._id,
          contactId,
          type: followUpType(parsed.status),
          status: parsed.status,
          scheduledAt: parsed.scheduledAt,
          completedAt: parsed.status === 'Meeting Completed' || parsed.status === 'Contacted' ? now : null,
          outcome: parsed.outcome,
          nextAction: parsed.nextAction,
          reason: parsed.reason,
          notes: parsed.notes,
          createdByAdminId: stamp.createdByAdminId,
          createdByCrmUserId: stamp.createdByCrmUserId,
          actorName: stamp.authorName,
        }], { session });
        followUp = created[0];
        if (parsed.notes) {
          const remarks = await CrmConsultancyRemark.create([{
            consultancyId: consultancy._id,
            text: parsed.notes,
            authorAdminId: stamp.authorAdminId,
            authorCrmUserId: stamp.authorCrmUserId,
            authorName: stamp.authorName,
            previousText: null,
            history: [],
          }], { session });
          remark = remarks[0];
        }
      }
      consultancy.updatedBy = actorId(actor);
      await consultancy.save({ session });
      return { consultancy, followUp, remark, before, hasStatus: parsed.hasStatus };
    },
    audit: async (session, saved) => {
      await writeAudit({
        ...auditActor(actor),
        action: saved.hasStatus ? 'consultancy.follow_up' : 'consultancy.calling_status',
        entityType: 'consultancy',
        entityId: saved.consultancy._id,
        before: saved.before,
        after: {
          followUpStatus: saved.consultancy.followUpStatus,
          callingStatus: saved.consultancy.callingStatus || '',
          pipelineStage: saved.consultancy.pipelineStage,
          lastContactAt: saved.consultancy.lastContactAt,
          nextFollowUpAt: saved.consultancy.nextFollowUpAt,
          followUpId: saved.followUp ? String(saved.followUp._id) : null,
          remarkId: saved.remark ? String(saved.remark._id) : null,
        },
        ip: meta && meta.ip,
        userAgent: meta && meta.userAgent,
      }, session);
    },
  });
  return {
    consultancy: await presentConsultancy(payload.consultancy),
    followUp: payload.followUp ? toFollowUp(payload.followUp) : null,
    remark: payload.remark ? toRemark(payload.remark) : null,
  };
}

async function loadFollowUp(consultancy, followUpId, session) {
  const id = parseObjectId(followUpId, 'Follow-up id');
  const query = CrmConsultancyFollowUp.findOne({ _id: id, consultancyId: consultancy._id });
  if (session) query.session(session);
  const row = await query;
  if (!row) throw new CrmError(404, 'Follow-up not found.', 'not_found');
  return row;
}

async function refreshNextFollowUp(consultancy, session) {
  const rows = await CrmConsultancyFollowUp.find({ consultancyId: consultancy._id }).session(session);
  const next = earliestOpenFollowUp(rows);
  consultancy.nextFollowUpAt = next ? next.scheduledAt : null;
}

async function updateFollowUp(actor, consultancyId, followUpId, body, meta, now = new Date()) {
  const notes = body && Object.prototype.hasOwnProperty.call(body, 'notes') ? boundedText(body.notes, 'Remark', REMARK_MAX) : undefined;
  const outcome = body && Object.prototype.hasOwnProperty.call(body, 'outcome') ? boundedText(body.outcome, 'Outcome', 160) : undefined;
  const nextAction = body && Object.prototype.hasOwnProperty.call(body, 'nextAction') ? boundedText(body.nextAction, 'Next action', 160) : undefined;
  const reason = body && Object.prototype.hasOwnProperty.call(body, 'reason') ? boundedText(body.reason, 'Reason', REMARK_MAX) : undefined;
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consultancy = await loadConsultancy(consultancyId, actor, session);
      const followUp = await loadFollowUp(consultancy, followUpId, session);
      if (followUp.cancelledAt) throw new CrmError(409, 'A cancelled follow-up cannot be edited.', 'invalid_transition');
      if (followUp.completedAt) throw new CrmError(409, 'A completed follow-up cannot be edited.', 'invalid_transition');
      if (notes !== undefined) followUp.notes = notes;
      if (outcome !== undefined) followUp.outcome = outcome;
      if (nextAction !== undefined) followUp.nextAction = nextAction;
      if (reason !== undefined) followUp.reason = reason;
      if (body && Object.prototype.hasOwnProperty.call(body, 'scheduledAt')) {
        const when = parseDate(body.scheduledAt, 'Date');
        if (followUp.status === 'Meeting Scheduled' && when.getTime() <= now.getTime()) {
          throw new CrmError(400, 'Meeting Scheduled needs a future date and time.', 'invalid_body');
        }
        followUp.scheduledAt = when;
      }
      await followUp.save({ session });
      if (OPEN_FOLLOW_UP_STATUSES.includes(followUp.status)) {
        await refreshNextFollowUp(consultancy, session);
        await consultancy.save({ session });
      }
      return { consultancy, followUp };
    },
    audit: async (session, saved) => {
      await writeAudit({
        ...auditActor(actor),
        action: 'consultancy.follow_up_updated',
        entityType: 'consultancy',
        entityId: saved.consultancy._id,
        after: { followUpId: String(saved.followUp._id), status: saved.followUp.status, scheduledAt: saved.followUp.scheduledAt },
        ip: meta && meta.ip,
        userAgent: meta && meta.userAgent,
      }, session);
    },
  });
  return { followUp: toFollowUp(payload.followUp), consultancy: await presentConsultancy(payload.consultancy) };
}

async function completeFollowUp(actor, consultancyId, followUpId, meta, now = new Date()) {
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consultancy = await loadConsultancy(consultancyId, actor, session);
      const followUp = await loadFollowUp(consultancy, followUpId, session);
      if (followUp.cancelledAt) throw new CrmError(409, 'A cancelled follow-up cannot be completed.', 'invalid_transition');
      if (followUp.completedAt) return { consultancy, followUp, unchanged: true };
      followUp.completedAt = now;
      if (actor && actor.actorType === 'crm-user') followUp.completedByCrmUserId = actor._id;
      else followUp.completedByAdminId = actorId(actor);
      await followUp.save({ session });
      await refreshNextFollowUp(consultancy, session);
      await consultancy.save({ session });
      return { consultancy, followUp, unchanged: false };
    },
    audit: async (session, saved) => {
      if (saved.unchanged) return;
      await writeAudit({
        ...auditActor(actor),
        action: 'consultancy.follow_up_completed',
        entityType: 'consultancy',
        entityId: saved.consultancy._id,
        after: { followUpId: String(saved.followUp._id), status: saved.followUp.status, completedAt: saved.followUp.completedAt },
        ip: meta && meta.ip,
        userAgent: meta && meta.userAgent,
      }, session);
    },
  });
  return { followUp: toFollowUp(payload.followUp), consultancy: await presentConsultancy(payload.consultancy) };
}

async function cancelFollowUp(actor, consultancyId, followUpId, meta, now = new Date()) {
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consultancy = await loadConsultancy(consultancyId, actor, session);
      const followUp = await loadFollowUp(consultancy, followUpId, session);
      if (followUp.cancelledAt) return { consultancy, followUp, unchanged: true };
      followUp.cancelledAt = now;
      if (actor && actor.actorType === 'crm-user') followUp.cancelledByCrmUserId = actor._id;
      else followUp.cancelledByAdminId = actorId(actor);
      await followUp.save({ session });
      await refreshNextFollowUp(consultancy, session);
      await consultancy.save({ session });
      return { consultancy, followUp, unchanged: false };
    },
    audit: async (session, saved) => {
      if (saved.unchanged) return;
      await writeAudit({
        ...auditActor(actor),
        action: 'consultancy.follow_up_cancelled',
        entityType: 'consultancy',
        entityId: saved.consultancy._id,
        after: { followUpId: String(saved.followUp._id), status: saved.followUp.status },
        ip: meta && meta.ip,
        userAgent: meta && meta.userAgent,
      }, session);
    },
  });
  return { followUp: toFollowUp(payload.followUp), consultancy: await presentConsultancy(payload.consultancy) };
}

function canManageAccess(actor) {
  return Boolean(actor && actor.canManageAccess);
}

async function reassignOwner(actor, consultancyIdParam, body, req) {
  if (!canManageAccess(actor)) {
    throw new CrmError(403, 'You do not have permission to reassign consultancy access.', 'permission_denied');
  }
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  const userId = parseObjectId(body && body.ownerId, 'Owner');
  await assertConsultancyAccess(accessActor(actor), consultancyId);
  const user = await CrmUser.findOne({ _id: userId, deletedAt: null });
  if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
  if (user.status !== 'active') {
    throw new CrmError(409, 'Only an active CRM user can hold a consultancy assignment.', 'assignee_not_eligible');
  }
  const consultancy = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null });
  if (!consultancy) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertConsultancyAccess(accessActor(actor), consultancyId, session);
        const currentUser = await CrmUser.findOne({ _id: userId, deletedAt: null, status: 'active' }).session(session);
        if (!currentUser) {
          throw new CrmError(409, 'Only an active CRM user can hold a consultancy assignment.', 'assignee_not_eligible');
        }
        const active = await CrmConsultancyAssignment.find({ consultancyId, revokedAt: null }).session(session);
        if (active.length > 1) {
          throw new CrmError(
            409,
            'This consultancy has more than one assignee. Change those assignments individually so access is not removed by mistake.',
            'assignment_ambiguous'
          );
        }
        if (active.length === 1 && String(active[0].crmUserId) === String(userId)) {
          return { unchanged: true, previousUserId: userId, consultancyId };
        }
        const previous = active[0] || null;
        if (previous) {
          previous.revokedAt = new Date();
          if (actor.kind === 'admin' || actor.actorType === 'admin') previous.revokedByAdminId = actor.id || actor._id;
          else previous.revokedByCrmUserId = actor.id || actor._id;
          await previous.save({ session });
        }
        const created = await insertActiveAssignment({
          consultancyId,
          crmUserId: userId,
          revokedAt: null,
          createdByAdminId: actor.kind === 'admin' || actor.actorType === 'admin' ? (actor.id || actor._id) : null,
          createdByCrmUserId: actor.kind === 'crm-user' || actor.actorType === 'crm-user' ? (actor.id || actor._id) : null,
        }, session);
        return {
          unchanged: false,
          created,
          previousUserId: previous ? previous.crmUserId : null,
          consultancyId,
          ownerName: currentUser.fullName,
        };
      },
      audit: async (session, saved) => {
        if (saved.unchanged) return;
        const actorAudit = actor.kind === 'crm-user' || actor.actorType === 'crm-user'
          ? { actorCrmUserId: actor.id || actor._id }
          : { actorAdminId: actor.id || actor._id };
        if (saved.previousUserId) {
          await writeAuthAudit({
            ...actorAudit,
            targetUserId: saved.previousUserId,
            action: 'crm_assignment.revoked',
            before: { consultancyId: String(saved.consultancyId), status: 'active' },
            after: { consultancyId: String(saved.consultancyId), status: 'revoked' },
          }, req, session);
        }
        await writeAuthAudit({
          ...actorAudit,
          targetUserId: saved.created.crmUserId,
          action: 'crm_assignment.created',
          after: { consultancyId: String(saved.consultancyId), status: 'active' },
        }, req, session);
        await writeAudit({
          ...actorAudit,
          action: 'consultancy.owner_reassigned',
          entityType: 'consultancy',
          entityId: saved.consultancyId,
          before: { ownerId: saved.previousUserId ? String(saved.previousUserId) : null },
          after: { ownerId: String(saved.created.crmUserId), ownerName: saved.ownerName },
          ip: req && req.ip,
          userAgent: req && typeof req.get === 'function' ? req.get('user-agent') : null,
        }, session);
      },
    });
    const fresh = await CrmConsultancy.findById(consultancyId);
    return {
      consultancy: await presentConsultancy(fresh),
      unchanged: payload.unchanged,
    };
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (isMongoDuplicateKeyError(err)) {
      throw new CrmError(409, 'This user is already assigned to that consultancy.', 'duplicate_assignment');
    }
    throw err;
  }
}

module.exports = {
  listRemarks,
  addRemark,
  editRemark,
  listFollowUps,
  recordFollowUp,
  updateFollowUp,
  completeFollowUp,
  cancelFollowUp,
  reassignOwner,
  toRemark,
  toFollowUp,
};
