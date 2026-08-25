const ActivationCounsellorMeetAttendance = require('../models/ActivationCounsellorMeetAttendance');
const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const otpRepository = require('../utils/otpRepository');
const { getActivationCounsellorMeetEligibility } = require('../utils/activationCounsellorMeetEligibility');

function normalizeMobile(value) {
  return otpRepository.normalize(value || '');
}

exports.activationCounsellorMeetHealth = async (req, res) => {
  try {
    await ActivationCounsellorMeetAttendance.countDocuments();
    return res.status(200).json({ status: 'ok', message: 'Activation counsellor meet API and DB connected' });
  } catch (error) {
    console.error('[activationCounsellorMeetHealth] Error:', error);
    return res.status(500).json({
      status: 'error',
      message:
        process.env.NODE_ENV !== 'production'
          ? error.message
          : 'DB or activation counsellor meet model unavailable',
    });
  }
};

exports.activationCounsellorMeetEligibility = async (req, res) => {
  try {
    const { mobileNumber } = req.body || {};
    const eligibility = await getActivationCounsellorMeetEligibility(mobileNumber);
    return res.status(200).json({
      success: true,
      data: eligibility,
    });
  } catch (error) {
    console.error('[activationCounsellorMeetEligibility] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

exports.registerForActivationCounsellorMeet = async (req, res) => {
  try {
    const { name, mobileNumber } = req.body || {};
    const rawName = typeof name === 'string' ? name.trim() : '';
    const mobile = normalizeMobile(mobileNumber || '');

    if (!rawName || rawName.length < 2) {
      return res.status(400).json({ success: false, message: 'Name is required (at least 2 characters)' });
    }
    if (rawName.length > 100) {
      return res.status(400).json({ success: false, message: 'Name must be at most 100 characters' });
    }
    if (!mobile || mobile.length !== 10) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number is required' });
    }

    const eligibility = await getActivationCounsellorMeetEligibility(mobile);
    if (eligibility.status !== 'allowed') {
      return res.status(403).json({
        success: false,
        message: eligibility.message || 'You are not allowed to register for this meet.',
        data: { status: eligibility.status },
      });
    }

    const record = await ActivationCounsellorMeetAttendance.create({
      name: rawName,
      mobileNumber: mobile,
      attendanceStatus: 'joined',
    });

    return res.status(201).json({
      success: true,
      message: 'Registered successfully',
      data: {
        id: record._id,
        name: record.name,
        mobileNumber: record.mobileNumber,
        timestamp: record.timestamp,
        attendanceStatus: record.attendanceStatus,
      },
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors).map((e) => e.message).join('; ');
      return res.status(400).json({ success: false, message: msg || 'Validation failed' });
    }
    console.error('[registerForActivationCounsellorMeet] Error:', error);
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
  const clauses = [{ name: { $regex: term, $options: 'i' } }];
  if (digits) clauses.push({ mobileNumber: { $regex: digits, $options: 'i' } });
  else clauses.push({ mobileNumber: { $regex: term, $options: 'i' } });
  return { $or: clauses };
}

function buildMatch({ from, to, q }) {
  const parts = [];
  const dateRange = buildDateRange(from, to);
  if (dateRange) parts.push({ timestamp: dateRange });
  const searchQuery = buildSearchQuery(q);
  if (searchQuery) parts.push(searchQuery);
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

exports.getActivationCounsellorMeetAttendance = async (req, res) => {
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
    });

    const statsPipeline = [
      { $match: match },
      { $group: { _id: '$mobileNumber' } },
      { $count: 'uniqueAttendees' },
    ];

    const mapRow = (r) => ({
      id: r._id,
      name: r.name,
      mobileNumber: r.mobileNumber,
      timestamp: r.timestamp,
      attendanceStatus: r.attendanceStatus,
      createdAt: r.createdAt,
    });

    if (uniqueByMobile) {
      const pipeline = [
        { $match: match },
        { $sort: { timestamp: sortDirection } },
        {
          $group: {
            _id: '$mobileNumber',
            record: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$record' } },
        { $sort: { timestamp: sortDirection } },
        { $skip: skip },
        { $limit: limit },
      ];

      const [records, totalRecords, uniqueAgg] = await Promise.all([
        ActivationCounsellorMeetAttendance.aggregate(pipeline),
        ActivationCounsellorMeetAttendance.countDocuments(match),
        ActivationCounsellorMeetAttendance.aggregate(statsPipeline),
      ]);

      const uniqueAttendees = uniqueAgg[0]?.uniqueAttendees || 0;
      const duplicateCount = Math.max(0, totalRecords - uniqueAttendees);
      const totalPages = Math.ceil(uniqueAttendees / limit) || 1;

      return res.status(200).json({
        success: true,
        data: records.map(mapRow),
        pagination: { page, limit, total: uniqueAttendees, totalPages },
        stats: { totalRecords, uniqueAttendees, duplicateCount },
      });
    }

    const [records, totalRecords, uniqueAgg] = await Promise.all([
      ActivationCounsellorMeetAttendance.find(match).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      ActivationCounsellorMeetAttendance.countDocuments(match),
      ActivationCounsellorMeetAttendance.aggregate(statsPipeline),
    ]);

    const uniqueAttendees = uniqueAgg[0]?.uniqueAttendees || 0;
    const duplicateCount = Math.max(0, totalRecords - uniqueAttendees);
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    return res.status(200).json({
      success: true,
      data: records.map(mapRow),
      pagination: { page, limit, total: totalRecords, totalPages },
      stats: { totalRecords, uniqueAttendees, duplicateCount },
    });
  } catch (error) {
    console.error('[getActivationCounsellorMeetAttendance] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
