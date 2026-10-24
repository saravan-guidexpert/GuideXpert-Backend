'use strict';

const CrmStudent = require('../../models/CrmStudent');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyContact = require('../../models/CrmConsultancyContact');
const CrmReferral = require('../../models/CrmReferral');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { commitWithAudit } = require('../../utils/crmMutation');
const { parsePageLimit, parseObjectId, requestMeta } = require('../../utils/crmHttp');
const { resolveListRange } = require('../../utils/crmRange');
const { writeAudit } = require('./auditService');
const { actorId, auditActor } = require('./fields');
const {
  assertConsultancyAccess,
  assertReferralAccess,
  assertStudentAccess,
  assignedConsultancyIds,
} = require('./crmAccess');
const { ADMISSION_STATUSES, CRM_REASON_MIN, CRM_REASON_MAX } = require('../../constants/crm');

function toReferral(doc, extras = {}) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    crmStudentId: String(doc.crmStudentId),
    studentName: extras.studentName || '',
    consultancyId: String(doc.consultancyId),
    consultancyName: doc.consultancyNameSnapshot,
    consultancyContactId: doc.consultancyContactId ? String(doc.consultancyContactId) : null,
    contactName: doc.contactNameSnapshot || '',
    originalConsultancyId: String(doc.originalConsultancyId),
    originalConsultancyName: doc.originalConsultancyName,
    referredAt: doc.referredAt,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    sourceCorrectedAt: doc.sourceCorrectedAt || null,
    sourceCorrectedBy: doc.sourceCorrectedBy ? String(doc.sourceCorrectedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function sourceSnapshot(doc) {
  return {
    consultancyId: String(doc.consultancyId),
    consultancyName: doc.consultancyNameSnapshot,
    consultancyContactId: doc.consultancyContactId ? String(doc.consultancyContactId) : null,
    contactName: doc.contactNameSnapshot || '',
    originalConsultancyId: String(doc.originalConsultancyId),
    originalConsultancyName: doc.originalConsultancyName,
  };
}

function conflict(existing, extras) {
  return new CrmError(
    409,
    'This student already has an original consultancy attribution. The source was not changed.',
    'referral_exists',
    { referral: toReferral(existing, extras) }
  );
}

function isDuplicate(err) {
  return isMongoDuplicateKeyError(err) || (err && err.cause && isMongoDuplicateKeyError(err.cause));
}

function parseReferredAt(value) {
  if (value == null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CrmError(400, 'referredAt is not a valid date.', 'invalid_date');
  }
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new CrmError(400, 'referredAt cannot be more than a day in the future.', 'invalid_date');
  }
  return date;
}

function requireReason(value) {
  const text = String(value ?? '').trim();
  if (text.length < CRM_REASON_MIN || text.length > CRM_REASON_MAX) {
    throw new CrmError(400, `A reason of ${CRM_REASON_MIN}–${CRM_REASON_MAX} characters is required.`, 'reason_required');
  }
  return text;
}

async function loadEligibleStudent(studentId) {
  const id = parseObjectId(studentId, 'Student id');
  const student = await CrmStudent.findById(id).lean();
  if (!student) throw new CrmError(404, 'Student not found.', 'not_found');
  if (student.deletedAt) {
    throw new CrmError(409, 'A deleted student cannot receive a referral.', 'student_not_eligible');
  }
  return student;
}

async function loadEligibleConsultancy(consultancyId) {
  const id = parseObjectId(consultancyId, 'Consultancy id');
  const consultancy = await CrmConsultancy.findById(id).lean();
  if (!consultancy || consultancy.deletedAt) {
    throw new CrmError(404, 'Consultancy not found.', 'not_found');
  }
  if (consultancy.status !== 'active') {
    throw new CrmError(409, 'Referrals can only be recorded for an active consultancy.', 'consultancy_not_eligible');
  }
  return consultancy;
}

async function loadContact(consultancy, contactId) {
  if (contactId == null || contactId === '') return null;
  const id = parseObjectId(contactId, 'Contact id');
  const contact = await CrmConsultancyContact.findOne({
    _id: id,
    consultancyId: consultancy._id,
  }).lean();
  if (!contact) throw new CrmError(404, 'Contact not found for this consultancy.', 'not_found');
  if (contact.status !== 'active') {
    throw new CrmError(409, 'Choose an active contact at this consultancy.', 'contact_not_eligible');
  }
  return contact;
}

async function createReferral(actor, input, req) {
  const studentId = parseObjectId(input && input.crmStudentId, 'Student id');
  await assertStudentAccess(actor, studentId);
  const student = await loadEligibleStudent(input.crmStudentId);
  const consultancyId = parseObjectId(input && input.consultancyId, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  const consultancy = await loadEligibleConsultancy(input.consultancyId);
  const contact = await loadContact(consultancy, input && input.consultancyContactId);
  const referredAt = parseReferredAt(input && input.referredAt);
  const adminId = actorId(actor);
  const meta = requestMeta(req);
  const existing = await CrmReferral.findOne({ crmStudentId: student._id }).lean();
  if (existing) throw conflict(existing, { studentName: student.fullName });

  const fields = {
    crmStudentId: student._id,
    consultancyId: consultancy._id,
    consultancyContactId: contact ? contact._id : null,
    consultancyNameSnapshot: consultancy.name,
    contactNameSnapshot: contact ? contact.name : '',
    originalConsultancyId: consultancy._id,
    originalConsultancyName: consultancy.name,
    originalContactName: contact ? contact.name : '',
    referredAt,
    createdBy: adminId,
  };

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertStudentAccess(actor, student._id, session);
        await assertConsultancyAccess(actor, consultancy._id, session);
        const created = await CrmReferral.create([fields], { session });
        return created[0];
      },
      audit: (session, referral) => writeAudit({
        ...auditActor(actor),
        action: 'referral.created',
        entityType: 'crmReferral',
        entityId: referral._id,
        before: null,
        after: sourceSnapshot(referral),
        ip: meta.ip,
        userAgent: meta.userAgent,
      }, session),
    });
    return toReferral(payload, { studentName: student.fullName });
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (isDuplicate(err)) {
      const winner = await CrmReferral.findOne({ crmStudentId: student._id }).lean();
      if (winner) throw conflict(winner, { studentName: student.fullName });
    }
    throw err;
  }
}

async function getStudentReferral(studentId, actor) {
  const id = parseObjectId(studentId, 'Student id');
  const student = await CrmStudent.findById(id).select('fullName').lean();
  if (!student) throw new CrmError(404, 'Student not found.', 'not_found');
  await assertStudentAccess(actor, id);
  const referral = await CrmReferral.findOne({ crmStudentId: id }).lean();
  return { referral: referral ? toReferral(referral, { studentName: student.fullName }) : null };
}

async function pageReferrals(filter, { page, limit, skip, sort }) {
  const [rows, total] = await Promise.all([
    CrmReferral.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    CrmReferral.countDocuments(filter),
  ]);
  const studentIds = rows.map((row) => row.crmStudentId);
  const students = await CrmStudent.find({ _id: { $in: studentIds } }).select('fullName admissionStatus').lean();
  const byId = new Map(students.map((student) => [String(student._id), student]));
  return {
    items: rows.map((row) => {
      const student = byId.get(String(row.crmStudentId));
      const dto = toReferral(row, { studentName: student ? student.fullName : '' });
      dto.admissionStatus = student && ADMISSION_STATUSES.includes(student.admissionStatus)
        ? student.admissionStatus
        : 'Not started';
      return dto;
    }),
    page,
    limit,
    total,
  };
}

async function listReferrals(query, actor) {
  const { page, limit, skip } = parsePageLimit(query);
  const filter = {};
  if (query.consultancyId) filter.consultancyId = parseObjectId(query.consultancyId, 'Consultancy id');
  if (query.studentId) filter.crmStudentId = parseObjectId(query.studentId, 'Student id');
  const allowed = await assignedConsultancyIds(actor);
  if (allowed) {
    const requested = filter.consultancyId;
    const requestedAllowed = requested && allowed.some((id) => String(id) === String(requested));
    if (requested && !requestedAllowed) filter.consultancyId = { $in: [] };
    else if (!requested) filter.consultancyId = { $in: allowed };
  }
  const dateRange = resolveListRange(query);
  if (dateRange) filter.referredAt = { $gte: dateRange.start, $lte: dateRange.end };
  return pageReferrals(filter, { page, limit, skip, sort: { createdAt: -1 } });
}

async function correctReferralSource(actor, referralId, input, req) {
  const id = parseObjectId(referralId, 'Referral id');
  const reason = requireReason(input && input.reason);
  const targetId = parseObjectId(input && input.consultancyId, 'Consultancy id');
  const existing = await CrmReferral.findById(id);
  if (!existing) throw new CrmError(404, 'Referral not found.', 'not_found');
  await assertReferralAccess(actor, existing);
  await assertConsultancyAccess(actor, targetId);
  const consultancy = await loadEligibleConsultancy(input.consultancyId);
  const contact = await loadContact(consultancy, input && input.consultancyContactId);
  if (String(existing.consultancyId) === String(consultancy._id)) {
    throw new CrmError(400, 'The referral already uses this consultancy. The source was not changed.', 'source_unchanged');
  }

  const adminId = actorId(actor);
  const meta = requestMeta(req);
  const before = sourceSnapshot(existing);
  const correctedAt = new Date();

  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const current = await CrmReferral.findById(existing._id).session(session);
      if (!current) throw new CrmError(404, 'Referral not found.', 'not_found');
      await assertReferralAccess(actor, current, session);
      await assertConsultancyAccess(actor, consultancy._id, session);
      const updated = await CrmReferral.findOneAndUpdate(
        { _id: existing._id, consultancyId: existing.consultancyId },
        {
          $set: {
            consultancyId: consultancy._id,
            consultancyNameSnapshot: consultancy.name,
            consultancyContactId: contact ? contact._id : null,
            contactNameSnapshot: contact ? contact.name : '',
            sourceCorrectedAt: correctedAt,
            sourceCorrectedBy: adminId,
            sourceCorrectionReason: reason,
          },
        },
        { new: true, session }
      );
      if (!updated) {
        throw new CrmError(409, 'The referral source changed before this correction was saved.', 'referral_conflict');
      }
      return updated;
    },
    audit: (session, updated) => writeAudit({
      ...auditActor(actor),
      action: 'referral.source_corrected',
      entityType: 'crmReferral',
      entityId: updated._id,
      reason,
      before,
      after: sourceSnapshot(updated),
      ip: meta.ip,
      userAgent: meta.userAgent,
    }, session),
  });

  return toReferral(payload);
}

async function planNewReferral(input, adminId) {
  const consultancy = await loadEligibleConsultancy(input && input.consultancyId);
  const contact = await loadContact(consultancy, input && input.consultancyContactId);
  const referredAt = parseReferredAt(input && input.referredAt);
  return {
    build(studentId) {
      return {
        crmStudentId: studentId,
        consultancyId: consultancy._id,
        consultancyContactId: contact ? contact._id : null,
        consultancyNameSnapshot: consultancy.name,
        contactNameSnapshot: contact ? contact.name : '',
        originalConsultancyId: consultancy._id,
        originalConsultancyName: consultancy.name,
        originalContactName: contact ? contact.name : '',
        referredAt,
        createdBy: adminId,
      };
    },
  };
}

function assertNoGenericSourceWrite() {
  throw new CrmError(
    403,
    'Referral source cannot be changed on this endpoint. CRM managers use the source-correction action.',
    'referral_source_immutable'
  );
}

module.exports = {
  createReferral,
  getStudentReferral,
  listReferrals,
  pageReferrals,
  correctReferralSource,
  assertNoGenericSourceWrite,
  planNewReferral,
  sourceSnapshot,
  toReferral,
};
