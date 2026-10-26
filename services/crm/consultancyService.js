'use strict';

const Admin = require('../../models/Admin');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmConsultancyContact = require('../../models/CrmConsultancyContact');
const CrmConsultancyRemark = require('../../models/CrmConsultancyRemark');
const CrmReferral = require('../../models/CrmReferral');
const CrmUser = require('../../models/CrmUser');
const { CONSULTANCY_PIPELINE, CONSULTANCY_FOLLOW_UP_STATUSES, CALLING_STATUSES } = require('../../constants/crm');
const { applyWorkflow, blankWorkflow } = require('./consultancyWorkflow');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { escapeRegex, parseObjectId, parsePageLimit, optionalQueryString } = require('../../utils/crmHttp');
const { commitWithAudit } = require('../../utils/crmMutation');
const { writeAudit } = require('./auditService');
const { writeAuthAudit } = require('./crmAuthAudit');
const { insertActiveAssignment } = require('./crmAssignmentService');
const { assertConsultancyAccess, assignedConsultancyIds, isCrmActor } = require('./crmAccess');
const {
  requireText,
  optionalText,
  optionalContactEmail,
  optionalStatus,
  requireStatus,
  normalizeConsultancyName,
  normalizeIndianMobile,
  actorId,
  auditActor,
  CONSULTANCY_STATUS,
  CONTACT_STATUS,
} = require('./fields');

function consultancyDTO(doc) {
  const followUpStatus = CONSULTANCY_FOLLOW_UP_STATUSES.includes(doc.followUpStatus) ? doc.followUpStatus : 'Fresh Lead';
  const callingStatus = CALLING_STATUSES.includes(doc.callingStatus) ? doc.callingStatus : '';
  const pipelineStage = CONSULTANCY_PIPELINE.includes(doc.pipelineStage) ? doc.pipelineStage : 'fresh';
  return {
    id: String(doc._id),
    name: doc.name,
    status: doc.status,
    notes: doc.notes || '',
    followUpStatus,
    callingStatus,
    pipelineStage,
    lastContactAt: doc.lastContactAt || null,
    nextFollowUpAt: doc.nextFollowUpAt || null,
    callingStatusChangedAt: doc.callingStatusChangedAt || null,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    deletedAt: doc.deletedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function contactDTO(doc) {
  return {
    id: String(doc._id),
    consultancyId: String(doc.consultancyId),
    name: doc.name,
    phone: doc.phone || null,
    email: doc.email || null,
    role: doc.role || '',
    status: doc.status,
    deactivatedAt: doc.deactivatedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function studentCountsByConsultancy(ids) {
  if (!ids.length) return new Map();
  const rows = await CrmReferral.aggregate([
    { $match: { consultancyId: { $in: ids } } },
    { $group: { _id: '$consultancyId', studentCount: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.studentCount]));
}

async function presentConsultancy(doc) {
  if (!doc) return null;
  const [row] = await presentConsultancies([doc]);
  return row;
}

async function presentConsultancies(docs) {
  if (!docs.length) return [];
  const ids = docs.map((doc) => doc._id);
  const [counts, remarks, assignments] = await Promise.all([
    studentCountsByConsultancy(ids),
    CrmConsultancyRemark.aggregate([
      { $match: { consultancyId: { $in: ids } } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$consultancyId',
          text: { $first: '$text' },
          authorName: { $first: '$authorName' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ]),
    CrmConsultancyAssignment.find({ consultancyId: { $in: ids }, revokedAt: null }).sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  const nameIds = [...docs.map((doc) => doc.createdBy), ...assignments.map((row) => row.crmUserId)].filter(Boolean);
  const [users, admins] = await Promise.all([
    CrmUser.find({ _id: { $in: nameIds } }).select('fullName').lean(),
    Admin.find({ _id: { $in: nameIds } }).select('name').lean(),
  ]);
  const names = new Map();
  admins.forEach((row) => names.set(String(row._id), row.name || ''));
  users.forEach((row) => names.set(String(row._id), row.fullName || ''));
  const latest = new Map(remarks.map((row) => [String(row._id), row]));
  const owners = new Map();
  assignments.forEach((row) => {
    const key = String(row.consultancyId);
    const list = owners.get(key) || [];
    list.push(row);
    owners.set(key, list);
  });
  return docs.map((doc) => {
    const key = String(doc._id);
    const links = owners.get(key) || [];
    const remark = latest.get(key);
    return {
      ...consultancyDTO(doc),
      studentCount: counts.get(key) || 0,
      createdByName: doc.createdBy ? (names.get(String(doc.createdBy)) || '') : '',
      ownerId: links[0] ? String(links[0].crmUserId) : null,
      ownerName: links.map((link) => names.get(String(link.crmUserId)) || '').filter(Boolean).join(', '),
      latestRemark: remark ? { text: remark.text, authorName: remark.authorName, createdAt: remark.createdAt } : null,
    };
  });
}

function publicFields(dto) {
  return {
    name: dto.name,
    status: dto.status,
    notes: dto.notes,
    followUpStatus: dto.followUpStatus,
    callingStatus: dto.callingStatus,
    pipelineStage: dto.pipelineStage,
  };
}

async function listConsultancies(query, actor) {
  const { page, limit, skip } = parsePageLimit(query);
  const q = optionalQueryString(query.q, 'q');
  const status = optionalQueryString(query.status, 'status');
  const filter = { deletedAt: null };
  const allowedIds = await assignedConsultancyIds(actor);
  if (allowedIds) filter._id = { $in: allowedIds };
  if (status) {
    if (!CONSULTANCY_STATUS.includes(status)) {
      throw new CrmError(400, 'status must be active or inactive.', 'invalid_query');
    }
    filter.status = status;
  }
  const pipelineStage = optionalQueryString(query.pipelineStage, 'pipelineStage');
  if (pipelineStage) {
    if (!CONSULTANCY_PIPELINE.includes(pipelineStage)) {
      throw new CrmError(400, 'pipelineStage is not a consultancy pipeline stage.', 'invalid_query');
    }
    filter.pipelineStage = pipelineStage;
  }
  if (q) {
    filter.name = new RegExp(escapeRegex(q), 'i');
  }
  const [items, total] = await Promise.all([
    CrmConsultancy.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
    CrmConsultancy.countDocuments(filter),
  ]);
  return { items: await presentConsultancies(items), page, limit, total };
}

async function createConsultancy(actor, body, meta) {
  const name = requireText(body && body.name, 'Name', 2, 200);
  const notes = optionalText(body && body.notes, 'Notes', 2000);
  const status = optionalStatus(body && body.status, CONSULTANCY_STATUS, 'Status', 'active');
  const normalizedName = normalizeConsultancyName(name);
  const adminId = actorId(actor);
  const workflow = blankWorkflow();
  applyWorkflow(workflow, body, actor, new Date());

  const existing = await CrmConsultancy.findOne({
    normalizedName,
    deletedAt: null,
    status: 'active',
  }).lean();
  if (existing && status === 'active') {
    let visible = null;
    if (!isCrmActor(actor)) visible = await presentConsultancy(existing);
    else {
      try {
        await assertConsultancyAccess(actor, existing._id);
        visible = await presentConsultancy(existing);
      } catch (err) {
        if (!(err instanceof CrmError) || err.code !== 'not_found') throw err;
      }
    }
    throw new CrmError(409, 'An active consultancy with this name already exists.', 'duplicate_consultancy', {
      consultancy: visible,
    });
  }

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const created = await CrmConsultancy.create(
          [
            {
              name,
              normalizedName,
              status,
              notes,
              ...workflow,
              createdBy: adminId,
              updatedBy: adminId,
              deletedAt: null,
            },
          ],
          { session }
        );
        const doc = created[0];
        if (isCrmActor(actor)) {
          await insertActiveAssignment({
            consultancyId: doc._id,
            crmUserId: actor._id,
            createdByCrmUserId: actor._id,
            revokedAt: null,
          }, session);
        }
        return doc;
      },
      audit: async (session, doc) => {
        const dto = consultancyDTO(doc);
        await writeAudit(
          {
            ...auditActor(actor),
            action: 'consultancy.created',
            entityType: 'consultancy',
            entityId: doc._id,
            before: null,
            after: publicFields(dto),
            ip: meta && meta.ip,
            userAgent: meta && meta.userAgent,
          },
          session
        );
        if (isCrmActor(actor)) {
          await writeAuthAudit({
            actorCrmUserId: actor._id,
            targetUserId: actor._id,
            action: 'crm_assignment.created',
            after: { consultancyId: String(doc._id), status: 'active' },
          }, meta, session);
        }
      },
    });
    return presentConsultancy(payload);
  } catch (err) {
    if (isMongoDuplicateKeyError(err)) {
      const again = await CrmConsultancy.findOne({
        normalizedName,
        deletedAt: null,
        status: 'active',
      }).lean();
      let visible = null;
      if (again && !isCrmActor(actor)) visible = await presentConsultancy(again);
      else if (again) {
        try {
          await assertConsultancyAccess(actor, again._id);
          visible = await presentConsultancy(again);
        } catch (accessError) {
          if (!(accessError instanceof CrmError) || accessError.code !== 'not_found') throw accessError;
        }
      }
      throw new CrmError(409, 'An active consultancy with this name already exists.', 'duplicate_consultancy', {
        consultancy: visible,
      });
    }
    throw err;
  }
}

async function getConsultancy(id, actor) {
  const consultancyId = parseObjectId(id, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  const doc = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null }).lean();
  if (!doc) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  return presentConsultancy(doc);
}

async function updateConsultancy(actor, id, body, meta) {
  const consultancyId = parseObjectId(id, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  const adminId = actorId(actor);
  const doc = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null });
  if (!doc) throw new CrmError(404, 'Consultancy not found.', 'not_found');

  const before = publicFields(consultancyDTO(doc));
  if (body && Object.prototype.hasOwnProperty.call(body, 'name')) {
    doc.name = requireText(body.name, 'Name', 2, 200);
    doc.normalizedName = normalizeConsultancyName(doc.name);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'notes')) {
    doc.notes = optionalText(body.notes, 'Notes', 2000);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'status')) {
    doc.status = requireStatus(body.status, CONSULTANCY_STATUS, 'Status');
  }
  applyWorkflow(doc, body, actor, new Date());
  doc.updatedBy = adminId;
  const after = publicFields(consultancyDTO(doc));

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertConsultancyAccess(actor, doc._id, session);
        await doc.save({ session });
        return doc;
      },
      audit: async (session) => {
        await writeAudit(
          {
            ...auditActor(actor),
            action: 'consultancy.updated',
            entityType: 'consultancy',
            entityId: doc._id,
            before,
            after,
            ip: meta && meta.ip,
            userAgent: meta && meta.userAgent,
          },
          session
        );
      },
    });
    return presentConsultancy(payload);
  } catch (err) {
    if (isMongoDuplicateKeyError(err)) {
      throw new CrmError(409, 'An active consultancy with this name already exists.', 'duplicate_consultancy');
    }
    throw err;
  }
}

async function loadEligibleConsultancy(consultancyId, { requireActive }) {
  const doc = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null });
  if (!doc) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  if (requireActive && doc.status !== 'active') {
    throw new CrmError(409, 'This consultancy is inactive.', 'consultancy_inactive');
  }
  return doc;
}

function parseContactBody(body, { partial }) {
  const source = body || {};
  const next = {};
  if (!partial || Object.prototype.hasOwnProperty.call(source, 'name')) {
    next.name = requireText(source.name, 'Name', 2, 200);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(source, 'phone')) {
    if (source.phone === undefined || source.phone === null || source.phone === '') {
      next.phone = null;
    } else {
      next.phone = normalizeIndianMobile(source.phone);
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(source, 'email')) {
    next.email = optionalContactEmail(source.email);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(source, 'role')) {
    next.role = optionalText(source.role, 'Role', 80);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'status')) {
    next.status = requireStatus(source.status, CONTACT_STATUS, 'Status');
  }
  return next;
}

function assertContactReachable(phone, email) {
  if (!phone && !email) {
    throw new CrmError(400, 'A contact needs a mobile number or an email address.', 'invalid_body');
  }
}

async function listContacts(consultancyIdParam, query, actor) {
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  await loadEligibleConsultancy(consultancyId, { requireActive: false });
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { consultancyId };
  const [items, total] = await Promise.all([
    CrmConsultancyContact.find(filter).sort({ status: 1, name: 1 }).skip(skip).limit(limit).lean(),
    CrmConsultancyContact.countDocuments(filter),
  ]);
  return { items: items.map(contactDTO), page, limit, total };
}

async function createContact(actor, consultancyIdParam, body, meta) {
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  const consultancy = await loadEligibleConsultancy(consultancyId, { requireActive: false });
  const fields = parseContactBody(body, { partial: false });
  if (!Object.prototype.hasOwnProperty.call(fields, 'status')) fields.status = 'active';
  assertContactReachable(fields.phone, fields.email);
  const adminId = actorId(actor);

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertConsultancyAccess(actor, consultancy._id, session);
        const created = await CrmConsultancyContact.create(
          [
            {
              consultancyId: consultancy._id,
              name: fields.name,
              phone: fields.phone,
              email: fields.email,
              role: fields.role || '',
              status: fields.status,
              deactivatedAt: fields.status === 'inactive' ? new Date() : null,
              createdBy: adminId,
              updatedBy: adminId,
            },
          ],
          { session }
        );
        return created[0];
      },
      audit: async (session, doc) => {
        await writeAudit(
          {
            ...auditActor(actor),
            action: 'contact.created',
            entityType: 'consultancy_contact',
            entityId: doc._id,
            before: null,
            after: {
              consultancyId: String(consultancy._id),
              name: doc.name,
              role: doc.role,
              status: doc.status,
              hasPhone: !!doc.phone,
              hasEmail: !!doc.email,
            },
            ip: meta && meta.ip,
            userAgent: meta && meta.userAgent,
          },
          session
        );
      },
    });
    return contactDTO(payload);
  } catch (err) {
    if (isMongoDuplicateKeyError(err)) {
      throw new CrmError(
        409,
        'This consultancy already has an active contact with that mobile number.',
        'duplicate_contact'
      );
    }
    throw err;
  }
}

async function findContactForConsultancy(consultancyId, contactIdParam) {
  const contactId = parseObjectId(contactIdParam, 'Contact id');
  const doc = await CrmConsultancyContact.findOne({ _id: contactId, consultancyId });
  if (!doc) {
    throw new CrmError(404, 'Contact not found for this consultancy.', 'not_found');
  }
  return doc;
}

async function updateContact(actor, consultancyIdParam, contactIdParam, body, meta) {
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  await loadEligibleConsultancy(consultancyId, { requireActive: false });
  const doc = await findContactForConsultancy(consultancyId, contactIdParam);
  const fields = parseContactBody(body, { partial: true });
  const adminId = actorId(actor);
  const previous = {
    name: doc.name,
    role: doc.role,
    status: doc.status,
    phone: doc.phone,
    email: doc.email,
    deactivatedAt: doc.deactivatedAt,
  };
  const before = {
    name: previous.name,
    role: previous.role,
    status: previous.status,
    hasPhone: !!previous.phone,
    hasEmail: !!previous.email,
  };
  if (Object.prototype.hasOwnProperty.call(fields, 'name')) doc.name = fields.name;
  if (Object.prototype.hasOwnProperty.call(fields, 'phone')) doc.phone = fields.phone;
  if (Object.prototype.hasOwnProperty.call(fields, 'email')) doc.email = fields.email;
  if (Object.prototype.hasOwnProperty.call(fields, 'role')) doc.role = fields.role;
  let action = 'contact.updated';
  if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
    doc.status = fields.status;
    if (fields.status === 'inactive') {
      doc.deactivatedAt = doc.deactivatedAt || new Date();
      action = 'contact.deactivated';
    } else {
      doc.deactivatedAt = null;
    }
  }
  assertContactReachable(doc.phone, doc.email);
  doc.updatedBy = adminId;
  const after = {
    name: doc.name,
    role: doc.role,
    status: doc.status,
    hasPhone: !!doc.phone,
    hasEmail: !!doc.email,
  };

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await assertConsultancyAccess(actor, consultancyId, session);
        await doc.save({ session });
        return doc;
      },
      audit: async (session) => {
        await writeAudit(
          {
            ...auditActor(actor),
            action,
            entityType: 'consultancy_contact',
            entityId: doc._id,
            before,
            after,
            ip: meta && meta.ip,
            userAgent: meta && meta.userAgent,
          },
          session
        );
      },
    });
    return contactDTO(payload);
  } catch (err) {
    if (isMongoDuplicateKeyError(err)) {
      throw new CrmError(
        409,
        'This consultancy already has an active contact with that mobile number.',
        'duplicate_contact'
      );
    }
    throw err;
  }
}

async function deactivateContact(actor, consultancyIdParam, contactIdParam, meta) {
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
  await assertConsultancyAccess(actor, consultancyId);
  await loadEligibleConsultancy(consultancyId, { requireActive: false });
  const doc = await findContactForConsultancy(consultancyId, contactIdParam);
  if (doc.status === 'inactive') {
    return contactDTO(doc);
  }
  return updateContact(
    actor,
    consultancyIdParam,
    contactIdParam,
    { status: 'inactive' },
    meta
  );
}

module.exports = {
  listConsultancies,
  createConsultancy,
  getConsultancy,
  updateConsultancy,
  listContacts,
  createContact,
  updateContact,
  deactivateContact,
  consultancyDTO,
  contactDTO,
  loadEligibleConsultancy,
  presentConsultancy,
};
