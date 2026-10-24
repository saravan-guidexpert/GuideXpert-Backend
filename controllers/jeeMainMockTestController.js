const mongoose = require('mongoose');
const JeeMainMockTestLead = require('../models/JeeMainMockTestLead');
const { CURRENT_STUDYING_OPTIONS } = JeeMainMockTestLead;
const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const otpRepository = require('../utils/otpRepository');
const otpStore = require('../utils/otpStore');
const VerifiedPhoneSession = require('../models/VerifiedPhoneSession');
const IitCounsellingVisit = require('../models/IitCounsellingVisit');
const IitCounsellingUtmSavedLink = require('../models/IitCounsellingUtmSavedLink');
const { dispatchJeeMockTestWhatsApp } = require('../services/jeeMockTestWhatsAppDispatch');

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const VERIFIED_TTL_MS = 15 * 60 * 1000;

function to10Digits(value) {
  return otpRepository.normalize(value || '');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function isPhoneVerified(phone) {
  if (otpStore.isVerified(phone)) return true;
  const since = new Date(Date.now() - VERIFIED_TTL_MS);
  const session = await VerifiedPhoneSession.findOne({ phone, verifiedAt: { $gte: since } }).lean();
  return Boolean(session);
}

function requiredText(value, label, min, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max) {
    return { error: `${label} must be ${min}–${max} characters.` };
  }
  return { text };
}

function requiredMobile(value, label) {
  const digits = to10Digits(value);
  if (!INDIAN_MOBILE_REGEX.test(digits)) {
    return { error: `Enter a valid 10-digit Indian mobile number for ${label}.` };
  }
  return { digits };
}

function mapLead(doc, influencer = {}) {
  return {
    id: String(doc._id),
    studentName: doc.studentName,
    mobileNumber: doc.mobileNumber,
    whatsappNumber: doc.whatsappNumber,
    currentStudying: doc.currentStudying,
    collegeName: doc.collegeName,
    location: doc.location,
    remarks: doc.remarks || '',
    formCompleted: Boolean(doc.formCompleted),
    currentStep: doc.currentStep || 1,
    otpVerified: Boolean(doc.otpVerified),
    submittedAt: doc.submittedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    influencerName: influencer.influencerName || '',
    utm_source: influencer.utm_source || '',
    utm_medium: influencer.utm_medium || '',
    utm_campaign: influencer.utm_campaign || '',
    utm_content: influencer.utm_content || '',
  };
}

function normalizeUtmToken(value) {
  return String(value || '').trim().toLowerCase();
}

function parseUtmParams(href) {
  if (!href || typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    return {
      utm_source: url.searchParams.get('utm_source') || '',
      utm_medium: url.searchParams.get('utm_medium') || '',
      utm_campaign: url.searchParams.get('utm_campaign') || '',
      utm_content: url.searchParams.get('utm_content') || '',
    };
  } catch {
    return null;
  }
}

function buildInfluencerLookup(links) {
  const byFullKey = new Map();
  const byContent = new Map();
  for (const link of links || []) {
    const name = String(link.influencerName || '').trim();
    if (!name) continue;
    const parsed = parseUtmParams(link.utmLink) || {};
    const content = parsed.utm_content || name;
    const fullKey = [parsed.utm_source, parsed.utm_medium, parsed.utm_campaign, content].map(normalizeUtmToken).join('|');
    if (!byFullKey.has(fullKey)) byFullKey.set(fullKey, name);
    const contentKey = normalizeUtmToken(content);
    if (contentKey && !byContent.has(contentKey)) byContent.set(contentKey, name);
    const nameKey = normalizeUtmToken(name);
    if (nameKey && !byContent.has(nameKey)) byContent.set(nameKey, name);
  }
  return { byFullKey, byContent };
}

function attributionOf(doc) {
  return {
    utm_source: doc?.utm_source || '',
    utm_medium: doc?.utm_medium || '',
    utm_campaign: doc?.utm_campaign || '',
    utm_content: doc?.utm_content || '',
  };
}

function hasAttribution(attr) {
  return Boolean(attr.utm_source || attr.utm_medium || attr.utm_campaign || attr.utm_content);
}

function resolveInfluencerName(attr, lookup) {
  const content = String(attr.utm_content || '').trim();
  const fullKey = [attr.utm_source, attr.utm_medium, attr.utm_campaign, content].map(normalizeUtmToken).join('|');
  const fromFull = lookup.byFullKey.get(fullKey);
  if (fromFull) return fromFull;
  const fromContent = lookup.byContent.get(normalizeUtmToken(content));
  if (fromContent) return fromContent;
  if (normalizeUtmToken(attr.utm_medium) === 'influencer' && content) return content;
  return '';
}

async function withInfluencers(records) {
  if (!records.length) return [];
  const ids = records.map((doc) => doc._id);
  const [visits, links] = await Promise.all([
    IitCounsellingVisit.find({
      pageKey: 'mainPage',
      jeeMainMockTestLeadId: { $in: ids },
    })
      .select('jeeMainMockTestLeadId utm_source utm_medium utm_campaign utm_content visitedAt')
      .sort({ visitedAt: -1 })
      .lean(),
    IitCounsellingUtmSavedLink.find({}).select('influencerName utmLink').lean(),
  ]);
  const visitByLead = new Map();
  for (const visit of visits) {
    const key = String(visit.jeeMainMockTestLeadId);
    if (!visitByLead.has(key)) visitByLead.set(key, visit);
  }
  const lookup = buildInfluencerLookup(links);
  return records.map((doc) => {
    const fromLead = attributionOf(doc);
    const attr = hasAttribution(fromLead) ? fromLead : attributionOf(visitByLead.get(String(doc._id)));
    return mapLead(doc, {
      ...attr,
      influencerName: resolveInfluencerName(attr, lookup),
    });
  });
}

function validationMessage(err) {
  return Object.values(err.errors || {})
    .map((e) => e.message)
    .join('; ');
}

function buildDateRange(from, to) {
  const range = {};
  if (typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    range.$gte = new Date(`${from}T00:00:00+05:30`);
  }
  if (typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const start = new Date(`${to}T00:00:00+05:30`);
    range.$lte = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  return Object.keys(range).length ? range : null;
}

function buildSearchQuery(q) {
  if (!q) return null;
  const term = String(q).trim();
  if (!term) return null;
  const safe = escapeRegex(term);
  const digits = term.replace(/\D/g, '');
  const clauses = [
    { studentName: { $regex: safe, $options: 'i' } },
    { collegeName: { $regex: safe, $options: 'i' } },
    { location: { $regex: safe, $options: 'i' } },
    { currentStudying: { $regex: safe, $options: 'i' } },
    { remarks: { $regex: safe, $options: 'i' } },
    { utm_content: { $regex: safe, $options: 'i' } },
    { utm_source: { $regex: safe, $options: 'i' } },
    { utm_campaign: { $regex: safe, $options: 'i' } },
  ];
  if (digits) {
    clauses.push({ mobileNumber: { $regex: digits } });
    clauses.push({ whatsappNumber: { $regex: digits } });
  }
  return { $or: clauses };
}

function optionalUtm(body) {
  const fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  const out = {};
  for (const field of fields) {
    const value = typeof body?.[field] === 'string' ? body[field].trim().slice(0, 200) : '';
    if (value) out[field] = value;
  }
  const visitorFingerprint = typeof body?.visitorFingerprint === 'string' ? body.visitorFingerprint.trim().slice(0, 200) : '';
  if (visitorFingerprint) out.visitorFingerprint = visitorFingerprint;
  return out;
}

async function linkJeeLeadToMainPageVisit(doc, attribution) {
  try {
    const visitorFingerprint = attribution.visitorFingerprint || '';
    if (visitorFingerprint) {
      await IitCounsellingVisit.findOneAndUpdate(
        { visitorFingerprint, pageKey: 'mainPage', jeeMainMockTestLeadId: null },
        { $set: { jeeMainMockTestLeadId: doc._id } },
        { sort: { visitedAt: -1 } }
      );
      return;
    }
    if (!attribution.utm_content) return;
    const visitMatch = {
      pageKey: 'mainPage',
      jeeMainMockTestLeadId: null,
      utm_content: attribution.utm_content,
    };
    if (attribution.utm_campaign) visitMatch.utm_campaign = attribution.utm_campaign;
    if (attribution.utm_source) visitMatch.utm_source = attribution.utm_source;
    if (attribution.utm_medium) visitMatch.utm_medium = attribution.utm_medium;
    await IitCounsellingVisit.findOneAndUpdate(
      visitMatch,
      { $set: { jeeMainMockTestLeadId: doc._id } },
      { sort: { visitedAt: -1 } }
    );
  } catch (err) {
    console.error('[linkJeeLeadToMainPageVisit]', err);
  }
}

function parseLeadId(body) {
  const leadId = typeof body?.leadId === 'string' ? body.leadId.trim() : '';
  if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
    return { error: 'Valid leadId is required.' };
  }
  return { leadId };
}

/**
 * POST /api/jee-main-mock-test/section1
 */
exports.saveJeeMainMockTestSection1 = async (req, res) => {
  try {
    const body = req.body || {};
    const studentName = requiredText(body.studentName, 'Student name', 2, 100);
    if (studentName.error) return res.status(400).json({ success: false, message: studentName.error });
    const mobile = requiredMobile(body.mobileNumber, 'the mobile number');
    if (mobile.error) return res.status(400).json({ success: false, message: mobile.error });

    const verified = await isPhoneVerified(mobile.digits);
    if (!verified) {
      return res.status(400).json({
        success: false,
        message: 'Please verify your mobile number with OTP first.',
      });
    }

    const attribution = optionalUtm(body);
    const doc = await JeeMainMockTestLead.findOneAndUpdate(
      { mobileNumber: mobile.digits, formCompleted: { $ne: true } },
      {
        $set: {
          studentName: studentName.text,
          mobileNumber: mobile.digits,
          otpVerified: true,
          currentStep: 1,
          formCompleted: false,
          ...attribution,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await linkJeeLeadToMainPageVisit(doc, attribution);

    return res.status(200).json({
      success: true,
      message: 'Step 1 saved successfully.',
      data: { leadId: doc._id.toString(), currentStep: 1, formCompleted: false },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'An in-progress registration with this mobile number already exists.',
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: validationMessage(err) || 'Validation failed.' });
    }
    console.error('[saveJeeMainMockTestSection1]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

/**
 * POST /api/jee-main-mock-test/section2
 */
exports.saveJeeMainMockTestSection2 = async (req, res) => {
  try {
    const body = req.body || {};
    const idParsed = parseLeadId(body);
    if (idParsed.error) return res.status(400).json({ success: false, message: idParsed.error });

    const whatsapp = requiredMobile(body.whatsappNumber, 'the WhatsApp number');
    if (whatsapp.error) return res.status(400).json({ success: false, message: whatsapp.error });

    const currentStudying = typeof body.currentStudying === 'string' ? body.currentStudying.trim() : '';
    if (!CURRENT_STUDYING_OPTIONS.includes(currentStudying)) {
      return res.status(400).json({ success: false, message: 'Select a current studying option.' });
    }

    const collegeName = requiredText(body.collegeName, 'College name', 2, 150);
    if (collegeName.error) return res.status(400).json({ success: false, message: collegeName.error });
    const location = requiredText(body.location, 'Location', 2, 120);
    if (location.error) return res.status(400).json({ success: false, message: location.error });

    const remarksRaw = typeof body.remarks === 'string' ? body.remarks.trim() : '';
    if (remarksRaw.length > 2000) {
      return res.status(400).json({ success: false, message: 'Remarks must be at most 2000 characters.' });
    }

    const existing = await JeeMainMockTestLead.findOne({
      _id: idParsed.leadId,
      formCompleted: { $ne: true },
    }).lean();

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found or already submitted. Please start from step 1.',
      });
    }
    if (!existing.studentName || !existing.mobileNumber || !existing.otpVerified) {
      return res.status(400).json({
        success: false,
        message: 'Please complete step 1 before submitting.',
      });
    }

    const doc = await JeeMainMockTestLead.findOneAndUpdate(
      { _id: idParsed.leadId, formCompleted: { $ne: true } },
      {
        $set: {
          whatsappNumber: whatsapp.digits,
          currentStudying,
          collegeName: collegeName.text,
          location: location.text,
          remarks: remarksRaw,
          ...optionalUtm(body),
          currentStep: 2,
          formCompleted: true,
          submittedAt: new Date(),
        },
      },
      { new: true, runValidators: true }
    );

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found or already submitted. Please start from step 1.',
      });
    }

    const whatsappSubmit = await dispatchJeeMockTestWhatsApp(doc.toObject());
    if (whatsappSubmit?.attempted && whatsappSubmit.success === false) {
      console.warn(
        '[saveJeeMainMockTestSection2] registration saved; WhatsApp not sent:',
        whatsappSubmit.error || whatsappSubmit.skippedReason
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Registered successfully',
      data: mapLead(doc.toObject()),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: validationMessage(err) || 'Validation failed.' });
    }
    console.error('[saveJeeMainMockTestSection2]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

function applyLeadFilters(match, query, { includeDates = true, includeStudying = true } = {}) {
  if (includeDates) {
    const dateRange = buildDateRange(query.from, query.to);
    if (dateRange) match.createdAt = dateRange;
  }
  const searchQuery = buildSearchQuery(query.q);
  if (searchQuery) Object.assign(match, searchQuery);
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  if (status === 'completed') match.formCompleted = true;
  if (status === 'incomplete') match.formCompleted = { $ne: true };
  const studying = typeof query.currentStudying === 'string' ? query.currentStudying.trim() : '';
  if (includeStudying && CURRENT_STUDYING_OPTIONS.includes(studying)) match.currentStudying = studying;
  return match;
}

function istDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function parseMonthKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) return value;
  return istDateKey().slice(0, 7);
}

function istDayBounds(dateKey) {
  const start = new Date(`${dateKey}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { $gte: start, $lt: end };
}

function istMonthBounds(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const startKey = `${monthKey}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { start: new Date(`${startKey}T00:00:00+05:30`), end: new Date(`${next}T00:00:00+05:30`) };
}

/**
 * GET /api/admin/jee-main-mock-test
 */
exports.listJeeMainMockTestLeads = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const match = applyLeadFilters({}, req.query);

    const [records, total] = await Promise.all([
      JeeMainMockTestLead.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      JeeMainMockTestLead.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      data: await withInfluencers(records),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    console.error('[listJeeMainMockTestLeads]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * GET /api/admin/jee-main-mock-test/summary
 */
exports.getJeeMainMockTestSummary = async (req, res) => {
  try {
    const match = applyLeadFilters({}, req.query);
    const distributionMatch = applyLeadFilters({}, req.query, { includeStudying: false });
    const todayKey = istDateKey();
    const todayMatch = applyLeadFilters({}, req.query, { includeDates: false });
    todayMatch.createdAt = istDayBounds(todayKey);

    const monthKey = parseMonthKey(req.query.month);
    const { start, end } = istMonthBounds(monthKey);
    const calendarMatch = applyLeadFilters({}, req.query, { includeDates: false });
    calendarMatch.createdAt = { $gte: start, $lt: end };

    const [total, completed, incomplete, today, studyingRows, calendarRows] = await Promise.all([
      JeeMainMockTestLead.countDocuments(match),
      JeeMainMockTestLead.countDocuments({ ...match, formCompleted: true }),
      JeeMainMockTestLead.countDocuments({ ...match, formCompleted: { $ne: true } }),
      JeeMainMockTestLead.countDocuments(todayMatch),
      JeeMainMockTestLead.aggregate([
        { $match: distributionMatch },
        { $group: { _id: { $ifNull: ['$currentStudying', ''] }, count: { $sum: 1 } } },
      ]),
      JeeMainMockTestLead.aggregate([
        { $match: calendarMatch },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const byStudying = CURRENT_STUDYING_OPTIONS.map((label) => ({
      label,
      count: studyingRows.find((row) => row._id === label)?.count || 0,
    }));
    const unset = studyingRows.find((row) => !row._id)?.count || 0;
    if (unset) byStudying.push({ label: 'Not selected yet', count: unset });

    return res.status(200).json({
      success: true,
      data: {
        kpis: { total, completed, incomplete, today },
        byStudying,
        calendar: {
          month: monthKey,
          today: todayKey,
          days: calendarRows.map((row) => ({ date: row._id, count: row.count })),
        },
      },
    });
  } catch (err) {
    console.error('[getJeeMainMockTestSummary]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
