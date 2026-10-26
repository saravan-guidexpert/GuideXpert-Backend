'use strict';

const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmReferral = require('../../models/CrmReferral');
const { CrmError } = require('../../utils/crmError');

function isCrmActor(actor) {
  return Boolean(actor && actor.actorType === 'crm-user' && actor._id);
}

async function assignedConsultancyIds(actor, session) {
  if (!isCrmActor(actor)) return null;
  const query = CrmConsultancyAssignment.find({
    crmUserId: actor._id,
    revokedAt: null,
  }).select('consultancyId');
  if (session) query.session(session);
  const rows = await query.lean();
  return rows.map((row) => row.consultancyId);
}

async function assertConsultancyAccess(actor, consultancyId, session, message = 'Consultancy not found.') {
  const ids = await assignedConsultancyIds(actor, session);
  if (ids == null) return;
  const allowed = ids.some((id) => String(id) === String(consultancyId));
  if (!allowed) throw new CrmError(404, message, 'not_found');
}

async function visibleStudentIds(actor) {
  const consultancyIds = await assignedConsultancyIds(actor);
  if (consultancyIds == null) return null;
  return CrmReferral.distinct('crmStudentId', { consultancyId: { $in: consultancyIds } });
}

async function assertStudentAccess(actor, studentId, session) {
  if (!isCrmActor(actor)) return;
  const query = CrmReferral.findOne({ crmStudentId: studentId }).select('consultancyId');
  if (session) query.session(session);
  const referral = await query.lean();
  if (!referral) throw new CrmError(404, 'Student not found.', 'not_found');
  await assertConsultancyAccess(actor, referral.consultancyId, session, 'Student not found.');
}

async function assertReferralAccess(actor, referral, session) {
  if (!isCrmActor(actor)) return;
  if (!referral || !referral.consultancyId) throw new CrmError(404, 'Referral not found.', 'not_found');
  await assertConsultancyAccess(actor, referral.consultancyId, session, 'Referral not found.');
}

module.exports = {
  isCrmActor,
  assignedConsultancyIds,
  assertConsultancyAccess,
  visibleStudentIds,
  assertStudentAccess,
  assertReferralAccess,
};
