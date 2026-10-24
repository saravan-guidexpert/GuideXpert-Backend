'use strict';

const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyContact = require('../../models/CrmConsultancyContact');
const CrmReferral = require('../../models/CrmReferral');
const { CrmError } = require('../../utils/crmError');
const { isMongoDuplicateKeyError } = require('../../utils/mongoDuplicateKey');
const { escapeRegex, parseObjectId, parsePageLimit, optionalQueryString } = require('../../utils/crmHttp');
const { commitWithAudit } = require('../../utils/crmMutation');
const { writeAudit } = require('./auditService');
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
const { CONSULTANCY_PIPELINE } = require('../../constants/crm');

function pipelineStageOf(value) {
  return CONSULTANCY_PIPELINE.includes(value) ? value : 'fresh';
}

function readPipelineStage(value) {
  if (!CONSULTANCY_PIPELINE.includes(value)) {
    throw new CrmError(400, 'Pipeline stage must be fresh, contacted, meeting done, or onboarded.', 'invalid_body');
  }
  return value;
}

function consultancyDTO(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    status: doc.status,
    pipelineStage: pipelineStageOf(doc.pipelineStage),
    notes: doc.notes || '',
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
  const counts = await studentCountsByConsultancy([doc._id]);
  return { ...consultancyDTO(doc), studentCount: counts.get(String(doc._id)) || 0 };
}

async function presentConsultancies(docs) {
  const counts = await studentCountsByConsultancy(docs.map((doc) => doc._id));
  return docs.map((doc) => ({
    ...consultancyDTO(doc),
    studentCount: counts.get(String(doc._id)) || 0,
  }));
}

function publicFields(dto) {
  return {
    name: dto.name,
    status: dto.status,
    pipelineStage: dto.pipelineStage,
    notes: dto.notes,
  };
}

async function countPipeline(filter) {
  const rows = await CrmConsultancy.aggregate([
    { $match: filter },
    { $group: { _id: { $ifNull: ['$pipelineStage', 'fresh'] }, count: { $sum: 1 } } },
  ]);
  const pipeline = { total: 0, fresh: 0, contacted: 0, meeting_done: 0, onboarded: 0 };
  rows.forEach((row) => {
    const key = pipelineStageOf(row._id);
    pipeline[key] += row.count;
    pipeline.total += row.count;
  });
  return pipeline;
}

async function listConsultancies(query) {
  const { page, limit, skip } = parsePageLimit(query);
  const q = optionalQueryString(query.q, 'q');
  const status = optionalQueryString(query.status, 'status');
  const pipelineStage = optionalQueryString(query.pipelineStage, 'pipelineStage');
  const filter = { deletedAt: null };
  if (status) {
    if (!CONSULTANCY_STATUS.includes(status)) {
      throw new CrmError(400, 'status must be active or inactive.', 'invalid_query');
    }
    filter.status = status;
  }
  if (q) {
    filter.name = new RegExp(escapeRegex(q), 'i');
  }
  const pipeline = await countPipeline(filter);
  if (pipelineStage) {
    if (!CONSULTANCY_PIPELINE.includes(pipelineStage)) {
      throw new CrmError(400, 'pipelineStage must be fresh, contacted, meeting_done, or onboarded.', 'invalid_query');
    }
    if (pipelineStage === 'fresh') {
      filter.$or = [
        { pipelineStage: 'fresh' },
        { pipelineStage: { $exists: false } },
        { pipelineStage: null },
      ];
    } else {
      filter.pipelineStage = pipelineStage;
    }
  }
  const [items, total] = await Promise.all([
    CrmConsultancy.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
    CrmConsultancy.countDocuments(filter),
  ]);
  return { items: await presentConsultancies(items), page, limit, total, pipeline };
}

async function createConsultancy(actor, body, meta) {
  const name = requireText(body && body.name, 'Name', 2, 200);
  const notes = optionalText(body && body.notes, 'Notes', 2000);
  const status = optionalStatus(body && body.status, CONSULTANCY_STATUS, 'Status', 'active');
  const pipelineStage = body && Object.prototype.hasOwnProperty.call(body, 'pipelineStage') && body.pipelineStage !== ''
    ? readPipelineStage(body.pipelineStage)
    : 'fresh';
  const normalizedName = normalizeConsultancyName(name);
  const adminId = actorId(actor);

  const existing = await CrmConsultancy.findOne({
    normalizedName,
    deletedAt: null,
    status: 'active',
  }).lean();
  if (existing && status === 'active') {
    throw new CrmError(409, 'An active consultancy with this name already exists.', 'duplicate_consultancy', {
      consultancy: await presentConsultancy(existing),
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
              pipelineStage,
              notes,
              createdBy: adminId,
              updatedBy: adminId,
              deletedAt: null,
            },
          ],
          { session }
        );
        return created[0];
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
      throw new CrmError(409, 'An active consultancy with this name already exists.', 'duplicate_consultancy', {
        consultancy: again ? await presentConsultancy(again) : null,
      });
    }
    throw err;
  }
}

async function getConsultancy(id) {
  const consultancyId = parseObjectId(id, 'Consultancy id');
  const doc = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null }).lean();
  if (!doc) throw new CrmError(404, 'Consultancy not found.', 'not_found');
  return presentConsultancy(doc);
}

async function updateConsultancy(actor, id, body, meta) {
  const consultancyId = parseObjectId(id, 'Consultancy id');
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
  if (body && Object.prototype.hasOwnProperty.call(body, 'pipelineStage')) {
    doc.pipelineStage = readPipelineStage(body.pipelineStage);
  }
  doc.updatedBy = adminId;
  const after = publicFields(consultancyDTO(doc));

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
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

async function listContacts(consultancyIdParam, query) {
  const consultancyId = parseObjectId(consultancyIdParam, 'Consultancy id');
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
  const consultancy = await loadEligibleConsultancy(consultancyId, { requireActive: false });
  const fields = parseContactBody(body, { partial: false });
  if (!Object.prototype.hasOwnProperty.call(fields, 'status')) fields.status = 'active';
  assertContactReachable(fields.phone, fields.email);
  const adminId = actorId(actor);

  try {
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
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
};
