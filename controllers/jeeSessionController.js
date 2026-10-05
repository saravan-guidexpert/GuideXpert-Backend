const mongoose = require('mongoose');
const JeeSessionLead = require('../models/JeeSessionLead');
const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const otpRepository = require('../utils/otpRepository');
const otpStore = require('../utils/otpStore');
const VerifiedPhoneSession = require('../models/VerifiedPhoneSession');

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

function mapLead(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    fatherName: doc.fatherName,
    contactNumber: doc.contactNumber,
    whatsappNumber: doc.whatsappNumber || '',
    currentStudying: doc.currentStudying || '',
    collegeName: doc.collegeName || '',
    address: doc.address || '',
    remark: doc.remark || '',
    formCompleted: Boolean(doc.formCompleted),
    currentStep: doc.currentStep || 1,
    submittedAt: doc.submittedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function validationMessage(err) {
  return Object.values(err.errors || {})
    .map((e) => e.message)
    .join('; ');
}

function parseLeadId(body) {
  const leadId = typeof body?.leadId === 'string' ? body.leadId.trim() : '';
  if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
    return { error: 'Valid leadId is required.' };
  }
  return { leadId };
}

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
  const safe = escapeRegex(term);
  const digits = term.replace(/\D/g, '');
  const clauses = [
    { name: { $regex: safe, $options: 'i' } },
    { fatherName: { $regex: safe, $options: 'i' } },
    { currentStudying: { $regex: safe, $options: 'i' } },
    { collegeName: { $regex: safe, $options: 'i' } },
    { address: { $regex: safe, $options: 'i' } },
    { remark: { $regex: safe, $options: 'i' } },
  ];
  if (digits) {
    clauses.push({ contactNumber: { $regex: digits } });
    clauses.push({ whatsappNumber: { $regex: digits } });
  }
  return { $or: clauses };
}

/**
 * POST /api/jee-sessions/section1
 */
exports.saveJeeSessionSection1 = async (req, res) => {
  try {
    const body = req.body || {};
    const name = requiredText(body.name, 'Name', 2, 100);
    if (name.error) return res.status(400).json({ success: false, message: name.error });
    const fatherName = requiredText(body.fatherName, "Father's name", 2, 100);
    if (fatherName.error) return res.status(400).json({ success: false, message: fatherName.error });
    const contact = requiredMobile(body.contactNumber, 'the contact number');
    if (contact.error) return res.status(400).json({ success: false, message: contact.error });

    const verified = await isPhoneVerified(contact.digits);
    if (!verified) {
      return res.status(400).json({
        success: false,
        message: 'Please verify your contact number with OTP first.',
      });
    }

    const doc = await JeeSessionLead.findOneAndUpdate(
      { contactNumber: contact.digits, formCompleted: { $ne: true } },
      {
        $set: {
          name: name.text,
          fatherName: fatherName.text,
          contactNumber: contact.digits,
          otpVerified: true,
          currentStep: 1,
          formCompleted: false,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Step 1 saved successfully.',
      data: { leadId: doc._id.toString(), currentStep: 1, formCompleted: false },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'An in-progress registration with this contact number already exists.',
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: validationMessage(err) || 'Validation failed.' });
    }
    console.error('[saveJeeSessionSection1]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

/**
 * POST /api/jee-sessions/section2
 */
exports.saveJeeSessionSection2 = async (req, res) => {
  try {
    const body = req.body || {};
    const idParsed = parseLeadId(body);
    if (idParsed.error) return res.status(400).json({ success: false, message: idParsed.error });

    const whatsapp = requiredMobile(body.whatsappNumber, 'the WhatsApp / alternate number');
    if (whatsapp.error) return res.status(400).json({ success: false, message: whatsapp.error });
    const currentStudying = requiredText(body.currentStudying, 'Current studying', 2, 120);
    if (currentStudying.error) return res.status(400).json({ success: false, message: currentStudying.error });
    const collegeName = requiredText(body.collegeName, 'College name', 2, 150);
    if (collegeName.error) return res.status(400).json({ success: false, message: collegeName.error });
    const address = requiredText(body.address, 'Address', 2, 160);
    if (address.error) return res.status(400).json({ success: false, message: address.error });

    const remarkRaw = typeof body.remark === 'string' ? body.remark.trim() : '';
    if (remarkRaw.length > 2000) {
      return res.status(400).json({ success: false, message: 'Remark must be at most 2000 characters.' });
    }

    const existing = await JeeSessionLead.findOne({
      _id: idParsed.leadId,
      formCompleted: { $ne: true },
    }).lean();

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found or already submitted. Please start from step 1.',
      });
    }
    if (!existing.name || !existing.fatherName || !existing.contactNumber || !existing.otpVerified) {
      return res.status(400).json({
        success: false,
        message: 'Please complete step 1 before submitting.',
      });
    }

    const doc = await JeeSessionLead.findOneAndUpdate(
      { _id: idParsed.leadId, formCompleted: { $ne: true } },
      {
        $set: {
          whatsappNumber: whatsapp.digits,
          currentStudying: currentStudying.text,
          collegeName: collegeName.text,
          address: address.text,
          remark: remarkRaw,
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

    return res.status(200).json({
      success: true,
      message: 'Submitted successfully',
      data: mapLead(doc.toObject()),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: validationMessage(err) || 'Validation failed.' });
    }
    console.error('[saveJeeSessionSection2]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

/**
 * GET /api/admin/jee-sessions
 */
exports.listJeeSessionLeads = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    const match = {};
    const dateRange = buildDateRange(req.query.from, req.query.to);
    if (dateRange) match.createdAt = dateRange;

    const searchQuery = buildSearchQuery(req.query.q);
    if (searchQuery) Object.assign(match, searchQuery);

    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status === 'completed') match.formCompleted = true;
    if (status === 'incomplete') match.formCompleted = { $ne: true };

    const [records, total] = await Promise.all([
      JeeSessionLead.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      JeeSessionLead.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      data: records.map(mapLead),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    console.error('[listJeeSessionLeads]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
