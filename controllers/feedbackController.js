const TrainingFeedback = require('../models/TrainingFeedback');
const CertifiedCounsellor2627 = require('../models/CertifiedCounsellor2627');
const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const otpRepository = require('../utils/otpRepository');

function to10Digits(val) {
  return otpRepository.normalize(val);
}

/**
 * POST /api/feedback — submit training feedback (public).
 */
exports.submitTrainingFeedback = async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name && String(b.name).trim()) || '';
    const mobileNumber = to10Digits(b.mobileNumber);
    const whatsappNumber = to10Digits(b.whatsappNumber);
    const email = (b.email && String(b.email).trim().toLowerCase()) || '';
    const addressOfCommunication = (b.addressOfCommunication && String(b.addressOfCommunication).trim()) || '';
    const occupation = (b.occupation && String(b.occupation).trim()) || '';
    const dateOfBirth = b.dateOfBirth;
    const gender = b.gender;
    const educationQualification = (b.educationQualification && String(b.educationQualification).trim()) || '';
    const yearsOfExperience = b.yearsOfExperience;
    const anythingToConvey = (b.anythingToConvey && String(b.anythingToConvey).trim().slice(0, 1000)) || '';

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, message: 'Name must be 2–100 characters.' });
    }
    if (mobileNumber.length !== 10) {
      return res.status(400).json({ success: false, message: 'Mobile number must be 10 digits.' });
    }
    if (whatsappNumber.length !== 10) {
      return res.status(400).json({ success: false, message: 'WhatsApp number must be 10 digits.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Valid email is required.' });
    }
    if (addressOfCommunication.length < 10 || addressOfCommunication.length > 500) {
      return res.status(400).json({ success: false, message: 'Address must be 10–500 characters.' });
    }
    if (!occupation || occupation.length > 200) {
      return res.status(400).json({ success: false, message: 'Occupation is required.' });
    }
    const occupationOptions = [
      'Teachers',
      'Working professionals',
      'Graduation completed',
      'Housewives (graduated)',
      'Others',
    ];
    if (!occupationOptions.includes(occupation)) {
      return res.status(400).json({ success: false, message: 'Select a valid occupation.' });
    }
    const dob = dateOfBirth ? new Date(dateOfBirth) : null;
    if (!dob || Number.isNaN(dob.getTime())) {
      return res.status(400).json({ success: false, message: 'Valid date of birth is required.' });
    }
    const now = new Date();
    if (dob > now) {
      return res.status(400).json({ success: false, message: 'Date of birth must be in the past.' });
    }
    const ageYears = (now - dob) / (365.25 * 24 * 60 * 60 * 1000);
    if (ageYears < 18 || ageYears > 80) {
      return res.status(400).json({ success: false, message: 'Age must be between 18 and 80.' });
    }
    if (gender !== 'Male' && gender !== 'Female') {
      return res.status(400).json({ success: false, message: 'Gender must be Male or Female.' });
    }
    if (!educationQualification || educationQualification.length > 200) {
      return res.status(400).json({ success: false, message: 'Education qualification is required.' });
    }
    const yoe = Number(yearsOfExperience);
    if (Number.isNaN(yoe) || yoe < 0 || yoe > 50 || yoe !== Math.floor(yoe)) {
      return res.status(400).json({ success: false, message: 'Years of experience must be 0–50.' });
    }

    // One submission per phone number (mobile or WhatsApp), across both stored fields
    const submittedPhones = [...new Set([mobileNumber, whatsappNumber])];
    const existingFeedback = await CertifiedCounsellor2627.findOne({
      $or: [
        { mobileNumber: { $in: submittedPhones } },
        { whatsappNumber: { $in: submittedPhones } },
      ],
    }).lean();
    if (existingFeedback) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_SUBMITTED',
        message: 'You have already completed the feedback.'
      });
    }

    const doc = {
      name,
      mobileNumber,
      whatsappNumber,
      email,
      addressOfCommunication,
      occupation,
      dateOfBirth: dob,
      gender,
      educationQualification,
      yearsOfExperience: Math.floor(yoe)
    };
    if (anythingToConvey) doc.anythingToConvey = anythingToConvey;

    const record = await CertifiedCounsellor2627.create(doc);

    return res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data: {
        id: record._id,
        name: record.name,
        email: record.email,
        createdAt: record.createdAt
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_SUBMITTED',
        message: 'You have already completed the feedback.',
      });
    }
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map((e) => e.message).join('; ');
      return res.status(400).json({ success: false, message: msg || 'Validation failed.' });
    }
    console.error('[submitTrainingFeedback]', err.name, err.message);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong. Please try again.',
      ...(process.env.EXPOSE_API_ERROR === 'true' && { detail: err.message })
    });
  }
};

// ----- Admin: get training feedback list -----

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
    { email: { $regex: term, $options: 'i' } }
  ];
  if (digits) {
    clauses.push({ mobileNumber: { $regex: digits, $options: 'i' } });
    clauses.push({ whatsappNumber: { $regex: digits, $options: 'i' } });
  } else {
    clauses.push({ mobileNumber: { $regex: term, $options: 'i' } });
    clauses.push({ whatsappNumber: { $regex: term, $options: 'i' } });
  }
  return { $or: clauses };
}

async function listActivationSubmissions(Model, req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip = (page - 1) * limit;
  const dateRange = buildDateRange(req.query.from, req.query.to);
  const searchQuery = buildSearchQuery(req.query.q);
  const gender = req.query.gender;
  const occupation = req.query.occupation;

  const match = {};
  if (dateRange) match.createdAt = dateRange;
  if (searchQuery) Object.assign(match, searchQuery);
  if (gender === 'Male' || gender === 'Female') match.gender = gender;
  if (occupation && String(occupation).trim()) {
    match.occupation = { $regex: String(occupation).trim(), $options: 'i' };
  }

  const rawTotal = await Model.countDocuments(match);

  const pipeline = [
    { $match: match },
    { $addFields: { normalizedMobile: '$mobileNumber' } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$normalizedMobile', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    {
      $facet: {
        totalUnique: [{ $count: 'total' }],
        genderStats: [{ $group: { _id: '$gender', count: { $sum: 1 } } }],
        paginated: [
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              id: '$_id',
              name: 1,
              mobileNumber: 1,
              whatsappNumber: 1,
              email: 1,
              addressOfCommunication: 1,
              occupation: 1,
              dateOfBirth: 1,
              gender: 1,
              educationQualification: 1,
              yearsOfExperience: 1,
              anythingToConvey: 1,
              createdAt: 1,
              updatedAt: 1
            }
          }
        ]
      }
    }
  ];

  const aggResult = await Model.aggregate(pipeline);
  const first = Array.isArray(aggResult) && aggResult[0] ? aggResult[0] : {};
  const uniqueCount = first?.totalUnique?.[0]?.total ?? 0;
  const duplicateCount = Math.max(0, rawTotal - uniqueCount);
  const genderStats = first?.genderStats ?? [];
  const byGender = genderStats.reduce((acc, g) => {
    if (g._id) acc[g._id] = g.count;
    return acc;
  }, {});
  const rawPaginated = first?.paginated ?? [];
  const data = rawPaginated.map((r) => ({
    id: r.id || r._id,
    name: r.name,
    mobileNumber: r.mobileNumber,
    whatsappNumber: r.whatsappNumber,
    email: r.email,
    addressOfCommunication: r.addressOfCommunication,
    occupation: r.occupation,
    dateOfBirth: r.dateOfBirth,
    gender: r.gender,
    educationQualification: r.educationQualification,
    yearsOfExperience: r.yearsOfExperience,
    anythingToConvey: r.anythingToConvey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }));

  const totalPages = Math.ceil(uniqueCount / limit) || 1;
  const stats = {
    totalSubmissions: rawTotal,
    uniqueCount,
    duplicateCount,
    byGender
  };

  return res.status(200).json({
    success: true,
    data,
    pagination: { page, limit, total: uniqueCount, totalPages },
    stats
  });
}

exports.getTrainingFeedback = async (req, res) => {
  try {
    return await listActivationSubmissions(TrainingFeedback, req, res);
  } catch (err) {
    console.error('[getTrainingFeedback]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.getCertifiedCounsellors2627 = async (req, res) => {
  try {
    return await listActivationSubmissions(CertifiedCounsellor2627, req, res);
  } catch (err) {
    console.error('[getCertifiedCounsellors2627]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
