const ProFormSubmission = require('../models/ProFormSubmission');
const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const { PRO_FORM_ROLES, INDIA_STATES } = require('../constants/proForm');
const otpRepository = require('../utils/otpRepository');

const NAME_PATTERN = /^[A-Za-z][A-Za-z .']{0,98}$/;

function normalizeMobile(value) {
  return otpRepository.normalize(value || '');
}

function validateName(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length < 2) return { ok: false, message: 'Name is required (at least 2 characters)' };
  if (raw.length > 100) return { ok: false, message: 'Name must be at most 100 characters' };
  if (!NAME_PATTERN.test(raw)) return { ok: false, message: 'Name may only include letters, spaces, periods, and apostrophes' };
  return { ok: true, value: raw };
}

function validateRequiredText(value, { label, min, max }) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length < min) return { ok: false, message: `${label} is required (at least ${min} characters)` };
  if (raw.length > max) return { ok: false, message: `${label} must be at most ${max} characters` };
  return { ok: true, value: raw };
}

exports.proFormHealth = async (req, res) => {
  try {
    await ProFormSubmission.countDocuments();
    return res.status(200).json({ status: 'ok', message: 'PRO form API and DB connected' });
  } catch (error) {
    console.error('[proFormHealth] Error:', error);
    return res.status(500).json({
      status: 'error',
      message:
        process.env.NODE_ENV !== 'production'
          ? error.message
          : 'DB or PRO form model unavailable',
    });
  }
};

exports.submitProForm = async (req, res) => {
  try {
    const body = req.body || {};
    const nameResult = validateName(body.name);
    if (!nameResult.ok) return res.status(400).json({ success: false, message: nameResult.message });

    const contact = normalizeMobile(body.contactNumber || '');
    if (!contact || contact.length !== 10) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit contact number is required' });
    }

    const alternateRaw = typeof body.alternateNumber === 'string' ? body.alternateNumber.trim() : '';
    let alternateNumber = '';
    if (alternateRaw) {
      alternateNumber = normalizeMobile(alternateRaw);
      if (!alternateNumber || alternateNumber.length !== 10) {
        return res.status(400).json({ success: false, message: 'Alternate number must be 10 digits if provided' });
      }
      if (alternateNumber === contact) {
        return res.status(400).json({ success: false, message: 'Alternate number must be different from contact number' });
      }
    }

    const cityResult = validateRequiredText(body.cityTown, { label: 'City/town', min: 2, max: 80 });
    if (!cityResult.ok) return res.status(400).json({ success: false, message: cityResult.message });

    const state = typeof body.state === 'string' ? body.state.trim() : '';
    if (!INDIA_STATES.includes(state)) {
      return res.status(400).json({ success: false, message: 'Select a valid state' });
    }

    const currentlyWorkingAs = typeof body.currentlyWorkingAs === 'string' ? body.currentlyWorkingAs.trim() : '';
    if (!PRO_FORM_ROLES.includes(currentlyWorkingAs)) {
      return res.status(400).json({ success: false, message: 'Select a valid role' });
    }

    const collegeResult = validateRequiredText(body.associatedCollegeName, {
      label: 'Present associated college name',
      min: 2,
      max: 150,
    });
    if (!collegeResult.ok) return res.status(400).json({ success: false, message: collegeResult.message });

    const existing = await ProFormSubmission.findOne({ contactNumber: contact }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'This contact number has already been submitted.',
        code: 'ALREADY_SUBMITTED',
      });
    }

    const record = await ProFormSubmission.create({
      name: nameResult.value,
      contactNumber: contact,
      alternateNumber,
      cityTown: cityResult.value,
      state,
      currentlyWorkingAs,
      associatedCollegeName: collegeResult.value,
    });

    return res.status(201).json({
      success: true,
      message: 'Submitted successfully',
      data: mapRow(record),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This contact number has already been submitted.',
        code: 'ALREADY_SUBMITTED',
      });
    }
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors).map((e) => e.message).join('; ');
      return res.status(400).json({ success: false, message: msg || 'Validation failed' });
    }
    console.error('[submitProForm] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

function buildDateRange(from, to) {
  const range = {};
  if (from) {
    const start = new Date(from);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      range.$gte = start;
    }
  }
  if (to) {
    const end = new Date(to);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
  }
  return Object.keys(range).length ? range : null;
}

function buildSearchQuery(q) {
  if (!q) return null;
  const term = String(q).trim();
  if (!term) return null;
  const digits = term.replace(/\D/g, '');
  const clauses = [
    { name: { $regex: term, $options: 'i' } },
    { cityTown: { $regex: term, $options: 'i' } },
    { associatedCollegeName: { $regex: term, $options: 'i' } },
    { state: { $regex: term, $options: 'i' } },
  ];
  if (digits) {
    clauses.push({ contactNumber: { $regex: digits, $options: 'i' } });
    clauses.push({ alternateNumber: { $regex: digits, $options: 'i' } });
  }
  return { $or: clauses };
}

function buildMatch({ from, to, q, role, state }) {
  const parts = [];
  const dateRange = buildDateRange(from, to);
  if (dateRange) parts.push({ createdAt: dateRange });
  const searchQuery = buildSearchQuery(q);
  if (searchQuery) parts.push(searchQuery);
  const roleValue = typeof role === 'string' ? role.trim() : '';
  if (roleValue && PRO_FORM_ROLES.includes(roleValue)) {
    parts.push({ currentlyWorkingAs: roleValue });
  }
  const stateValue = typeof state === 'string' ? state.trim() : '';
  if (stateValue && INDIA_STATES.includes(stateValue)) {
    parts.push({ state: stateValue });
  }
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

function mapRow(r) {
  return {
    id: r._id,
    name: r.name,
    contactNumber: r.contactNumber,
    alternateNumber: r.alternateNumber || '',
    cityTown: r.cityTown,
    state: r.state,
    currentlyWorkingAs: r.currentlyWorkingAs,
    associatedCollegeName: r.associatedCollegeName,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

exports.getProFormSubmissions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const uniqueByMobile = String(req.query.uniqueByMobile || '').toLowerCase() === 'true';
    const dedupeMode = String(req.query.dedupeMode || 'latest').toLowerCase();
    const sortDirection = dedupeMode === 'oldest' ? 1 : -1;
    const match = buildMatch({
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
      role: req.query.role,
      state: req.query.state,
    });

    const uniquePipeline = [
      { $match: match },
      { $group: { _id: '$contactNumber' } },
      { $count: 'uniqueContacts' },
    ];
    const rolePipeline = [
      { $match: match },
      { $group: { _id: '$currentlyWorkingAs', count: { $sum: 1 } } },
    ];

    const [records, totalRecords, uniqueAgg, roleAgg] = uniqueByMobile
      ? await Promise.all([
          ProFormSubmission.aggregate([
            { $match: match },
            { $sort: { createdAt: sortDirection } },
            { $group: { _id: '$contactNumber', record: { $first: '$$ROOT' } } },
            { $replaceRoot: { newRoot: '$record' } },
            { $sort: { createdAt: sortDirection } },
            { $skip: skip },
            { $limit: limit },
          ]),
          ProFormSubmission.countDocuments(match),
          ProFormSubmission.aggregate(uniquePipeline),
          ProFormSubmission.aggregate(rolePipeline),
        ])
      : await Promise.all([
          ProFormSubmission.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
          ProFormSubmission.countDocuments(match),
          ProFormSubmission.aggregate(uniquePipeline),
          ProFormSubmission.aggregate(rolePipeline),
        ]);

    const uniqueContacts = uniqueAgg[0]?.uniqueContacts || 0;
    const duplicateCount = Math.max(0, totalRecords - uniqueContacts);
    const byRole = {};
    for (const row of roleAgg) {
      if (row._id) byRole[row._id] = row.count;
    }
    const listTotal = uniqueByMobile ? uniqueContacts : totalRecords;
    const totalPages = Math.ceil(listTotal / limit) || 1;

    return res.status(200).json({
      success: true,
      data: records.map(mapRow),
      pagination: { page, limit, total: listTotal, totalPages },
      stats: { totalRecords, uniqueContacts, duplicateCount, byRole },
    });
  } catch (error) {
    console.error('[getProFormSubmissions] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
