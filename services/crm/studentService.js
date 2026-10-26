'use strict';

const CrmStudent = require('../../models/CrmStudent');
const CrmReferral = require('../../models/CrmReferral');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { commitWithAudit } = require('../../utils/crmMutation');
const { normalizeIndianMobile } = require('../../utils/crmPhone');
const { escapeRegex, parseObjectId, parsePageLimit, requestMeta } = require('../../utils/crmHttp');
const { ADMISSION_STATUSES } = require('../../constants/crm');
const { writeAudit } = require('./auditService');
const { actorId, auditActor, requireText, optionalText, optionalEmail } = require('./fields');
const { planNewReferral, sourceSnapshot, toReferral } = require('./referralService');
const {
  assertConsultancyAccess,
  assertStudentAccess,
  isCrmActor,
  visibleStudentIds,
} = require('./crmAccess');

function admissionStatusList() {
  return ADMISSION_STATUSES.join(', ');
}

function requireAdmissionStatus(value) {
  if (typeof value !== 'string' || !ADMISSION_STATUSES.includes(value)) {
    throw new CrmError(
      400,
      `Admission status must be one of: ${admissionStatusList()}.`,
      'invalid_body'
    );
  }
  return value;
}

function admissionStatusForCreate(input) {
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'admissionStatus') || input.admissionStatus == null) {
    return 'Not started';
  }
  return requireAdmissionStatus(input.admissionStatus);
}

function displayAdmissionStatus(value) {
  return ADMISSION_STATUSES.includes(value) ? value : 'Not started';
}

function referralRequested(input) {
  if (!input || typeof input !== 'object') return false;
  return ['consultancyId', 'consultancyContactId', 'referredAt'].some((key) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return false;
    const value = input[key];
    return value != null && value !== '';
  });
}

function toStudent(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    fullName: doc.fullName,
    phone: doc.phone,
    email: doc.email || '',
    city: doc.city || '',
    notes: doc.notes || '',
    admissionStatus: displayAdmissionStatus(doc.admissionStatus),
    deletedAt: doc.deletedAt || null,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function identitySnapshot(doc, notesChanged) {
  return {
    fullName: doc.fullName,
    phone: doc.phone,
    city: doc.city || '',
    emailPresent: Boolean(doc.email),
    notesChanged: Boolean(notesChanged),
    admissionStatus: doc.admissionStatus || null,
  };
}

function phoneConflict(existing) {
  if (existing.deletedAt) {
    return new CrmError(
      409,
      'This mobile number belongs to a deleted student and was not restored.',
      'deleted_student_phone',
      { studentId: String(existing._id), deletedAt: existing.deletedAt }
    );
  }
  return new CrmError(
    409,
    'A student with this mobile number already exists. No duplicate was created.',
    'duplicate_student',
    { student: toStudent(existing) }
  );
}

function isDuplicate(err) {
  return isMongoDuplicateKeyError(err) || (err && err.cause && isMongoDuplicateKeyError(err.cause));
}

// Phone numbers are unique across the CRM. An out-of-scope conflict uses the
// same 409 duplicate_student code and message as an in-scope conflict, with
// no student payload. A different code would tell the caller the owner is
// outside their consultancies. Returning success without saving would be a
// different product contract. Hiding the fact that a write did not apply
// requires per-consultancy phone uniqueness or an asynchronous accept.
async function raisePhoneConflict(existing, actor) {
  if (isCrmActor(actor)) {
    try {
      await assertStudentAccess(actor, existing._id);
    } catch (err) {
      if (err instanceof CrmError && err.code === 'not_found') {
        throw new CrmError(
          409,
          'A student with this mobile number already exists. No duplicate was created.',
          'duplicate_student'
        );
      }
      throw err;
    }
  }
  throw phoneConflict(existing);
}

async function createStudent(actor, input, req) {
  const fullName = requireText(input.fullName, 'Name', 2, 160);
  const phone = normalizeIndianMobile(input.phone);
  const email = optionalEmail(input.email);
  const city = optionalText(input.city, 'City', 80);
  const notes = optionalText(input.notes, 'Notes', 2000);
  const admissionStatus = admissionStatusForCreate(input);
  const adminId = actorId(actor);
  const meta = requestMeta(req);
  let referralPlan = null;
  if (isCrmActor(actor) && !referralRequested(input)) {
    throw new CrmError(400, 'An active consultancy is required to record a student.', 'consultancy_required');
  }
  if (referralRequested(input)) {
    if (!input.consultancyId) {
      throw new CrmError(400, 'An active consultancy is required to record a referral.', 'consultancy_required');
    }
    await assertConsultancyAccess(actor, parseObjectId(input.consultancyId, 'Consultancy id'));
    referralPlan = await planNewReferral(input, adminId);
  }
  const existing = await CrmStudent.findOne({ phone }).lean();
  if (existing) await raisePhoneConflict(existing, actor);

  const studentFields = {
    fullName,
    phone,
    email,
    city,
    notes,
    admissionStatus,
    createdBy: adminId,
    updatedBy: adminId,
    deletedAt: null,
  };

  try {
    if (!referralPlan) {
      const { payload } = await commitWithAudit({
        requireTransaction: true,
        mutate: async (session) => {
          const created = await CrmStudent.create([studentFields], { session });
          return created[0];
        },
        audit: (session, student) => writeAudit({
          ...auditActor(actor),
          action: 'student.created',
          entityType: 'crmStudent',
          entityId: student._id,
          before: null,
          after: identitySnapshot(student, false),
          ip: meta.ip,
          userAgent: meta.userAgent,
        }, session),
      });
      return { student: toStudent(payload), referral: null };
    }

    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertConsultancyAccess(actor, input.consultancyId, session);
        const created = await CrmStudent.create([studentFields], { session });
        const student = created[0];
        const referrals = await CrmReferral.create([referralPlan.build(student._id)], { session });
        return { student, referral: referrals[0] };
      },
      audit: async (session, created) => {
        await writeAudit({
          ...auditActor(actor),
          action: 'student.created',
          entityType: 'crmStudent',
          entityId: created.student._id,
          before: null,
          after: identitySnapshot(created.student, false),
          ip: meta.ip,
          userAgent: meta.userAgent,
        }, session);
        await writeAudit({
          ...auditActor(actor),
          action: 'referral.created',
          entityType: 'crmReferral',
          entityId: created.referral._id,
          before: null,
          after: sourceSnapshot(created.referral),
          ip: meta.ip,
          userAgent: meta.userAgent,
        }, session);
      },
    });
    return {
      student: toStudent(payload.student),
      referral: toReferral(payload.referral, { studentName: payload.student.fullName }),
    };
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (isDuplicate(err)) {
      const winner = await CrmStudent.findOne({ phone }).lean();
      if (winner) await raisePhoneConflict(winner, actor);
    }
    throw err;
  }
}

async function listStudents(query, actor) {
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { deletedAt: null };
  const clauses = [];
  const studentIds = await visibleStudentIds(actor);
  if (studentIds) clauses.push({ _id: { $in: studentIds } });
  const q = String(query.q || '').trim();
  if (q) {
    if (q.length > 100) throw new CrmError(400, 'Search text is too long.', 'invalid_search');
    const safe = escapeRegex(q);
    const or = [
      { fullName: new RegExp(safe, 'i') },
      { phone: new RegExp(safe) },
    ];
    try {
      or.push({ phone: normalizeIndianMobile(q) });
    } catch (err) {
      if (!(err instanceof CrmError)) throw err;
    }
    clauses.push({ $or: or });
  }
  if (query.admissionStatus != null && query.admissionStatus !== '') {
    const status = String(query.admissionStatus);
    if (!ADMISSION_STATUSES.includes(status)) {
      throw new CrmError(400, `admissionStatus must be one of: ${admissionStatusList()}.`, 'invalid_query');
    }
    if (status === 'Not started') {
      clauses.push({
        admissionStatus: { $nin: ADMISSION_STATUSES.filter((item) => item !== 'Not started') },
      });
    } else {
      clauses.push({ admissionStatus: status });
    }
  }
  if (clauses.length === 1) Object.assign(filter, clauses[0]);
  else if (clauses.length > 1) filter.$and = clauses;
  const [rows, total] = await Promise.all([
    CrmStudent.find(filter).sort({ fullName: 1 }).skip(skip).limit(limit).lean(),
    CrmStudent.countDocuments(filter),
  ]);
  return { items: rows.map(toStudent), page, limit, total };
}

async function getStudent(id, actor) {
  const studentId = parseObjectId(id, 'Student id');
  const doc = await CrmStudent.findById(studentId).lean();
  if (isCrmActor(actor)) await assertStudentAccess(actor, studentId);
  if (!doc) throw new CrmError(404, 'Student not found.', 'not_found');
  return toStudent(doc);
}

async function updateStudent(actor, id, input, req) {
  const studentId = parseObjectId(id, 'Student id');
  const student = await CrmStudent.findById(studentId);
  if (!student) throw new CrmError(404, 'Student not found.', 'not_found');
  await assertStudentAccess(actor, studentId);
  if (student.deletedAt) {
    throw new CrmError(409, 'This student is deleted and was not changed.', 'student_deleted');
  }
  const allowed = ['fullName', 'phone', 'email', 'city', 'notes', 'admissionStatus'];
  const present = allowed.filter((key) => Object.prototype.hasOwnProperty.call(input || {}, key));
  if (present.length === 0) throw new CrmError(400, 'No updatable fields were provided.', 'empty_update');
  const nextAdmission = present.includes('admissionStatus')
    ? requireAdmissionStatus(input.admissionStatus)
    : null;

  const adminId = actorId(actor);
  const meta = requestMeta(req);
  const restore = {
    fullName: student.fullName,
    phone: student.phone,
    email: student.email,
    city: student.city,
    notes: student.notes,
  };
  const before = identitySnapshot(student, false);

  if (present.includes('fullName')) student.fullName = requireText(input.fullName, 'Name', 2, 160);
  if (present.includes('phone')) {
    const phone = normalizeIndianMobile(input.phone);
    if (phone !== student.phone) {
      const other = await CrmStudent.findOne({ phone }).lean();
      if (other) await raisePhoneConflict(other, actor);
      student.phone = phone;
    }
  }
  if (present.includes('email')) student.email = optionalEmail(input.email);
  if (present.includes('city')) student.city = optionalText(input.city, 'City', 80);
  if (present.includes('notes')) student.notes = optionalText(input.notes, 'Notes', 2000);
  if (present.includes('admissionStatus')) student.admissionStatus = nextAdmission;
  student.updatedBy = adminId;
  const after = identitySnapshot(student, present.includes('notes') && student.notes !== restore.notes);

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertStudentAccess(actor, student._id, session);
        await student.save({ session });
        return student;
      },
      audit: (session) => writeAudit({
        ...auditActor(actor),
        action: 'student.updated',
        entityType: 'crmStudent',
        entityId: student._id,
        before,
        after,
        ip: meta.ip,
        userAgent: meta.userAgent,
      }, session),
    });
    return toStudent(payload);
  } catch (err) {
    if (err instanceof CrmError) throw err;
    if (isDuplicate(err)) {
      const winner = await CrmStudent.findOne({ phone: student.phone }).lean();
      if (winner && String(winner._id) !== String(student._id)) await raisePhoneConflict(winner, actor);
    }
    throw err;
  }
}

module.exports = {
  createStudent,
  listStudents,
  getStudent,
  updateStudent,
  toStudent,
};
