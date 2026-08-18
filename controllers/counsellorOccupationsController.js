const FormSubmission = require('../models/FormSubmission');
const TrainingFeedback = require('../models/TrainingFeedback');
const MeetingAttendance = require('../models/MeetingAttendance');
const AssessmentSubmission = require('../models/AssessmentSubmission');
const AssessmentSubmission2 = require('../models/AssessmentSubmission2');
const AssessmentSubmission3 = require('../models/AssessmentSubmission3');
const AssessmentSubmission4 = require('../models/AssessmentSubmission4');
const AssessmentSubmission5 = require('../models/AssessmentSubmission5');
const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const { getISTDayRangeFromString } = require('../utils/dateHelpers');
const {
  NOT_SPECIFIED,
  isSyntheticOccupation,
  normalizeOccupation,
} = require('../utils/occupationNormalizer');

const SOURCE_LABEL = {
  apply: 'Apply form',
  activation: 'Activation form',
  both: 'Both',
};

const FUNNEL_STATUS_KEYS = [
  'form_submitted',
  'otp_verified',
  'slot_booked',
  'demo_attended',
  'assessment_written',
  'activation_filled',
];

const FUNNEL_STATUS_LABEL = {
  form_submitted: 'Form submitted',
  otp_verified: 'OTP verified',
  slot_booked: 'Slot booked',
  demo_attended: 'Demo attended',
  assessment_written: 'Assessment written',
  activation_filled: 'Activation filled',
};

function normalizePhoneTo10(value) {
  if (value == null) return '';
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function toMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buildCreatedAtRange(from, to) {
  const range = {};
  const startRange = from ? getISTDayRangeFromString(String(from)) : null;
  const endRange = to ? getISTDayRangeFromString(String(to)) : null;
  if (startRange) range.$gte = startRange.start;
  if (endRange) range.$lt = endRange.end;
  return Object.keys(range).length ? range : null;
}

function occupationUsable(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (!text) return false;
  return !isSyntheticOccupation(text);
}

function hasSlotValue(value) {
  return value != null && String(value).trim() !== '';
}

function isSlotBooked(doc) {
  if (!doc) return false;
  return doc.isRegistered === true
    || hasSlotValue(doc.step3Data && doc.step3Data.selectedSlot)
    || hasSlotValue(doc.selectedSlot);
}

function parseOccupationList(value) {
  if (value == null || value === '') return [];
  const parts = Array.isArray(value) ? value : [value];
  const out = [];
  for (const part of parts) {
    String(part).split(',').forEach((item) => {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    });
  }
  return [...new Set(out)];
}

function parseFunnelStatus(value) {
  const key = String(value || '').trim().toLowerCase();
  return FUNNEL_STATUS_KEYS.includes(key) ? key : '';
}

function furthestFunnelStatus(flags) {
  if (flags.activationFilled) return 'activation_filled';
  if (flags.assessmentWritten) return 'assessment_written';
  if (flags.demoAttended) return 'demo_attended';
  if (flags.slotBooked) return 'slot_booked';
  if (flags.otpVerified) return 'otp_verified';
  if (flags.formSubmitted) return 'form_submitted';
  return '';
}

function matchesFunnelStatus(flags, status) {
  if (!status) return true;
  if (status === 'form_submitted') return flags.formSubmitted;
  if (status === 'otp_verified') return flags.otpVerified;
  if (status === 'slot_booked') return flags.slotBooked;
  if (status === 'demo_attended') return flags.demoAttended;
  if (status === 'assessment_written') return flags.assessmentWritten;
  if (status === 'activation_filled') return flags.activationFilled;
  return true;
}

function upsertPerson(map, incoming) {
  const phone = incoming.phone;
  if (!phone) return;

  const ts = toMs(incoming.createdAt);
  const usable = occupationUsable(incoming.occupation);
  const existing = map.get(phone);

  const occupationText = incoming.occupation == null ? '' : String(incoming.occupation).trim();
  const occupationStored = incoming.occupation == null ? '' : String(incoming.occupation);
  const synthetic = Boolean(occupationText) && !usable;

  if (!existing) {
    map.set(phone, {
      phone,
      name: incoming.name || '',
      email: incoming.email || '',
      createdAt: incoming.createdAt || null,
      createdAtMs: ts,
      occupationRaw: usable ? occupationStored : '',
      occupationAtMs: usable ? ts : -1,
      hadUsableOccupation: usable,
      hadSyntheticOccupation: synthetic,
      sources: new Set([incoming.sourceKey]),
      formSubmitted: incoming.sourceKey === 'apply',
      otpVerified: Boolean(incoming.otpVerified),
      slotBooked: Boolean(incoming.slotBooked),
    });
    return;
  }

  existing.sources.add(incoming.sourceKey);
  if (incoming.sourceKey === 'apply') existing.formSubmitted = true;
  if (incoming.otpVerified) existing.otpVerified = true;
  if (incoming.slotBooked) existing.slotBooked = true;
  if (synthetic) existing.hadSyntheticOccupation = true;

  if (ts >= existing.createdAtMs) {
    if (incoming.name) existing.name = incoming.name;
    if (incoming.email) existing.email = incoming.email;
    existing.createdAt = incoming.createdAt || existing.createdAt;
    existing.createdAtMs = ts;
  } else {
    if (!existing.name && incoming.name) existing.name = incoming.name;
    if (!existing.email && incoming.email) existing.email = incoming.email;
  }

  if (usable && ts >= existing.occupationAtMs) {
    existing.occupationRaw = occupationStored;
    existing.occupationAtMs = ts;
    existing.hadUsableOccupation = true;
  }
}

function sourceKeyFromSet(sources) {
  const hasApply = sources.has('apply');
  const hasActivation = sources.has('activation');
  if (hasApply && hasActivation) return 'both';
  if (hasActivation) return 'activation';
  return 'apply';
}

function toRow(person) {
  const sourceKey = sourceKeyFromSet(person.sources);
  const { occupationRaw, occupationCategory } = normalizeOccupation(person.occupationRaw);
  const otpVerified = Boolean(person.otpVerified);
  const slotBooked = otpVerified && Boolean(person.slotBooked);
  const demoAttended = slotBooked && Boolean(person.demoAttended);
  const assessmentWritten = demoAttended && Boolean(person.assessmentWritten);
  const activationFilled = sourceKey === 'activation' || sourceKey === 'both';
  const flags = {
    formSubmitted: Boolean(person.formSubmitted),
    otpVerified,
    slotBooked,
    demoAttended,
    assessmentWritten,
    activationFilled,
  };
  const funnelStatus = furthestFunnelStatus(flags);
  return {
    id: person.phone,
    name: person.name || '',
    phone: person.phone,
    occupationCategory,
    occupationRaw,
    source: SOURCE_LABEL[sourceKey],
    sourceKey,
    email: person.email || '',
    createdAt: person.createdAt,
    funnelStatus,
    funnelStatusLabel: FUNNEL_STATUS_LABEL[funnelStatus] || '—',
    funnel: flags,
  };
}

async function loadMergedPeople(createdAtRange, { includeFunnel = false } = {}) {
  const match = {};
  if (createdAtRange) match.createdAt = createdAtRange;

  const applyProjection = {
    fullName: 1,
    phone: 1,
    occupation: 1,
    email: 1,
    createdAt: 1,
    isRegistered: 1,
    selectedSlot: 1,
    'step1Data.occupation': 1,
    'step1Data.fullName': 1,
    'step2Data.otpVerified': 1,
    'step3Data.selectedSlot': 1,
    'postRegistrationData.email': 1,
  };

  const loads = [
    FormSubmission.find(match, applyProjection).lean(),
    TrainingFeedback.find(match, {
      name: 1,
      mobileNumber: 1,
      whatsappNumber: 1,
      occupation: 1,
      email: 1,
      createdAt: 1,
    }).lean(),
  ];

  if (includeFunnel) {
    loads.push(
      MeetingAttendance.distinct('mobileNumber'),
      AssessmentSubmission.distinct('phone'),
      AssessmentSubmission2.distinct('phone'),
      AssessmentSubmission3.distinct('phone'),
      AssessmentSubmission4.distinct('phone'),
      AssessmentSubmission5.distinct('phone'),
    );
  }

  const [
    applyDocs,
    activationDocs,
    attendeeRaw,
    a1,
    a2,
    a3,
    a4,
    a5,
  ] = await Promise.all(loads);

  const attendeeSet = includeFunnel
    ? new Set((attendeeRaw || []).map(normalizePhoneTo10).filter(Boolean))
    : null;
  const assessmentSet = includeFunnel
    ? new Set([...(a1 || []), ...(a2 || []), ...(a3 || []), ...(a4 || []), ...(a5 || [])].map(normalizePhoneTo10).filter(Boolean))
    : null;

  const map = new Map();

  for (const doc of applyDocs || []) {
    const applyOccupation = (doc.occupation != null && String(doc.occupation).trim())
      ? String(doc.occupation)
      : (doc.step1Data && doc.step1Data.occupation != null ? String(doc.step1Data.occupation) : '');
    upsertPerson(map, {
      phone: normalizePhoneTo10(doc.phone),
      name: (doc.fullName && String(doc.fullName).trim())
        || (doc.step1Data && doc.step1Data.fullName && String(doc.step1Data.fullName).trim())
        || '',
      email: (doc.email && String(doc.email).trim())
        || (doc.postRegistrationData && doc.postRegistrationData.email && String(doc.postRegistrationData.email).trim())
        || '',
      occupation: applyOccupation,
      createdAt: doc.createdAt,
      sourceKey: 'apply',
      otpVerified: Boolean(doc.step2Data && doc.step2Data.otpVerified === true),
      slotBooked: isSlotBooked(doc),
    });
  }

  for (const doc of activationDocs || []) {
    upsertPerson(map, {
      phone: normalizePhoneTo10(doc.mobileNumber || doc.whatsappNumber),
      name: doc.name ? String(doc.name).trim() : '',
      email: doc.email ? String(doc.email).trim() : '',
      occupation: doc.occupation != null ? String(doc.occupation) : '',
      createdAt: doc.createdAt,
      sourceKey: 'activation',
    });
  }

  const rows = [];
  for (const person of map.values()) {
    // OTP / IIT form placeholders are not counsellor jobs; keep empty occupation as Not specified.
    if (!person.hadUsableOccupation && person.hadSyntheticOccupation) continue;
    if (includeFunnel) {
      const phone = person.phone;
      person.demoAttended = attendeeSet.has(phone);
      person.assessmentWritten = assessmentSet.has(phone);
    }
    rows.push(toRow(person));
  }

  rows.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  return rows;
}

function matchesSearch(row, q) {
  if (!q) return true;
  const term = String(q).trim().toLowerCase();
  if (!term) return true;
  const digits = term.replace(/\D/g, '');
  const haystacks = [
    row.name,
    row.email,
    row.occupationRaw,
    row.occupationCategory,
    row.phone,
  ].map((v) => String(v || '').toLowerCase());
  if (haystacks.some((h) => h.includes(term))) return true;
  if (digits && row.phone && row.phone.includes(digits)) return true;
  return false;
}

function applyFilters(rows, { q, occupations, source, status }) {
  const selected = Array.isArray(occupations) ? occupations.filter(Boolean) : [];
  const selectedSet = selected.length ? new Set(selected) : null;
  const sourceKey = source ? String(source).trim().toLowerCase() : '';
  const funnelStatus = parseFunnelStatus(status);
  return rows.filter((row) => {
    if (!matchesSearch(row, q)) return false;
    if (selectedSet && !selectedSet.has(row.occupationCategory)) return false;
    if (sourceKey && sourceKey !== 'all' && row.sourceKey !== sourceKey) return false;
    if (!matchesFunnelStatus(row.funnel || {}, funnelStatus)) return false;
    return true;
  });
}

function percentOf(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function buildStats(rows) {
  let applyOnly = 0;
  let activationOnly = 0;
  let both = 0;
  const buckets = new Map();

  for (const row of rows) {
    if (row.sourceKey === 'both') both += 1;
    else if (row.sourceKey === 'activation') activationOnly += 1;
    else applyOnly += 1;

    const key = row.occupationCategory;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { category: key, count: 0, applyOnly: 0, activationOnly: 0, both: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (row.sourceKey === 'both') bucket.both += 1;
    else if (row.sourceKey === 'activation') bucket.activationOnly += 1;
    else bucket.applyOnly += 1;
  }

  const uniquePeople = rows.length;
  const byCategory = [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      percent: percentOf(bucket.count, uniquePeople),
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const notSpecifiedEntry = buckets.get(NOT_SPECIFIED);
  const notSpecified = notSpecifiedEntry ? notSpecifiedEntry.count : 0;
  const specified = uniquePeople - notSpecified;
  const singletonCategories = byCategory.filter((item) => item.count === 1).length;
  const top = byCategory[0] || null;
  const topCategory = top
    ? { category: top.category, count: top.count, percent: top.percent }
    : null;

  return {
    uniquePeople,
    applyOnly,
    activationOnly,
    both,
    byCategory,
    distinctOccupations: byCategory.length,
    specified,
    notSpecified,
    singletonCategories,
    topCategory,
  };
}

/**
 * GET /api/admin/counsellor-occupations
 */
exports.getCounsellorOccupations = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const createdAtRange = buildCreatedAtRange(req.query.from, req.query.to);
    const merged = await loadMergedPeople(createdAtRange, { includeFunnel: true });
    const filtered = applyFilters(merged, {
      q: req.query.q,
      occupations: parseOccupationList(req.query.occupation),
      source: req.query.source,
      status: req.query.status,
    });
    const stats = buildStats(filtered);
    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;
    const data = filtered.slice(skip, skip + limit);

    return res.status(200).json({
      success: true,
      data,
      pagination: { page: safePage, limit, total, totalPages },
      stats,
    });
  } catch (err) {
    console.error('[getCounsellorOccupations]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * GET /api/admin/counsellor-occupations/categories
 */
exports.getCounsellorOccupationCategories = async (req, res) => {
  try {
    const createdAtRange = buildCreatedAtRange(req.query.from, req.query.to);
    const merged = await loadMergedPeople(createdAtRange);
    const stats = buildStats(merged);
    return res.status(200).json({
      success: true,
      data: {
        categories: stats.byCategory,
        uniquePeople: stats.uniquePeople,
        distinctOccupations: stats.distinctOccupations,
        specified: stats.specified,
        notSpecified: stats.notSpecified,
        singletonCategories: stats.singletonCategories,
        topCategory: stats.topCategory,
      },
    });
  } catch (err) {
    console.error('[getCounsellorOccupationCategories]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
