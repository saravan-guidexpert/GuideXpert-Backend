const otpStore = require('../utils/otpStore');
const { isPrivilegedPhone } = require('../utils/privilegedAccess');
const otpRepository = require('../utils/otpRepository');
const AssessmentSubmission = require('../models/AssessmentSubmission');
const AssessmentSubmission2 = require('../models/AssessmentSubmission2');
const AssessmentSubmission3 = require('../models/AssessmentSubmission3');
const AssessmentSubmission4 = require('../models/AssessmentSubmission4');
const AssessmentSubmission5 = require('../models/AssessmentSubmission5');
const VerifiedPhoneSession = require('../models/VerifiedPhoneSession');
const TrainingFeedback = require('../models/TrainingFeedback');
const CertifiedCounsellor2627 = require('../models/CertifiedCounsellor2627');

const VERIFIED_TTL_MS = 15 * 60 * 1000; // 15 min

const MAX_SCORE = 5;

/** Correct answers for Assessment 1 (Session 1, q1–q5). */
const CORRECT_ANSWERS = {
  q1: 'B. Help students with honest, ethical and personalised career guidance',
  q2: 'C. Sharing facts only',
  q3: 'A. Suggesting options or recommendations',
  q4: "A. Listen to the student's needs",
  q5: 'C. Help students make informed decisions'
};

const MAX_SCORE_2 = 5;

/** Correct answers for Assessment 2 (Session 2, q1–q5). */
const CORRECT_ANSWERS_2 = {
  q1: 'c) Acknowledge',
  q2: 'c) Acknowledge both sides',
  q3: 'b) Calm and guiding',
  q4: 'B. Acknowledge → Validate → Balance → Guide',
  q5: 'B. Placements depend on student skills, companies visiting, and past records'
};

const MAX_SCORE_3 = 5;

/** Correct answers for Assessment 3 (Session 3, q1–q5). Aligned with Training workflow CSV. */
const CORRECT_ANSWERS_3 = {
  q1: 'b) Post consistently on social media',
  q2: 'd) Create curiosity and engagement',
  q3: 'a) Follow up based on their results',
  q4: 'b) Start with student problems and offer value',
  q5: 'c) Clear interest with defined goals'
};

const MAX_SCORE_4 = 5;

/** Correct answers for Assessment 4 (Session 4, q1–q5). Aligned with Training workflow CSV. */
const CORRECT_ANSWERS_4 = {
  q1: 'c) Seat-focused and fee-focused content',
  q2: 'd) Short-term enquiries and low trust',
  q3: 'a) As a career counsellor providing clarity',
  q4: 'b) Highlight helping students choose the right career path',
  q5: 'c) Trust-based enquiries and long-term referrals'
};

const MAX_SCORE_5 = 5;

/** Correct answers for Assessment 5 (Session 5, q1–q5). Aligned with Training workflow CSV. */
const CORRECT_ANSWERS_5 = {
  q1: 'a) Using mobile number and OTP',
  q2: 'b) By sharing NAT exam link through referral portal',
  q3: 'a) Application Fee',
  q4: 'b) Earn rewards by referring students and to track admission process',
  q5: 'd) Rank Predictor'
};

function normalizePhone(phone) {
  return otpRepository.normalize(phone);
}

function trimAnswer(val) {
  return typeof val === 'string' ? val.trim() : '';
}

/**
 * Score MCQ: 1 point if answer matches correct (case-insensitive trim).
 */
function scoreMcq(userAnswer, correct) {
  if (!correct) return 0;
  return trimAnswer(userAnswer).toLowerCase() === correct.toLowerCase() ? 1 : 0;
}

/**
 * Compute total score from answers object.
 */
function computeScore(answers) {
  if (!answers || typeof answers !== 'object') return { score: 0, maxScore: MAX_SCORE };
  let score = 0;
  for (const [qId, correct] of Object.entries(CORRECT_ANSWERS)) {
    if (correct) {
      score += scoreMcq(answers[qId], correct);
    }
  }
  return { score, maxScore: MAX_SCORE };
}

function computeScore2(answers) {
  if (!answers || typeof answers !== 'object') return { score: 0, maxScore: MAX_SCORE_2 };
  let score = 0;
  for (const [qId, correct] of Object.entries(CORRECT_ANSWERS_2)) {
    if (correct) {
      score += scoreMcq(answers[qId], correct);
    }
  }
  return { score, maxScore: MAX_SCORE_2 };
}

/**
 * Returns per-question results for feedback/report.
 * @param {Object} answers - User answers keyed by question id
 * @param {Object} correctAnswersMap - Map of questionId -> correct answer text
 * @returns {Array<{ questionId: string, correct: boolean, userAnswer: string, correctAnswer: string }>}
 */
function getQuestionResults(answers, correctAnswersMap) {
  if (!answers || typeof answers !== 'object' || !correctAnswersMap) return [];
  const results = [];
  for (const [qId, correctAnswer] of Object.entries(correctAnswersMap)) {
    if (correctAnswer == null) continue;
    const userAnswer = trimAnswer(answers[qId] ?? '');
    const correct = scoreMcq(userAnswer, correctAnswer) === 1;
    results.push({
      questionId: qId,
      correct,
      userAnswer: userAnswer || '',
      correctAnswer: String(correctAnswer).trim()
    });
  }
  return results;
}

function computeScore3(answers) {
  if (!answers || typeof answers !== 'object') return { score: 0, maxScore: MAX_SCORE_3 };
  let score = 0;
  for (const [qId, correct] of Object.entries(CORRECT_ANSWERS_3)) {
    if (correct) {
      score += scoreMcq(answers[qId], correct);
    }
  }
  return { score, maxScore: MAX_SCORE_3 };
}

function computeScore4(answers) {
  if (!answers || typeof answers !== 'object') return { score: 0, maxScore: MAX_SCORE_4 };
  let score = 0;
  for (const [qId, correct] of Object.entries(CORRECT_ANSWERS_4)) {
    if (correct) {
      score += scoreMcq(answers[qId], correct);
    }
  }
  return { score, maxScore: MAX_SCORE_4 };
}

function computeScore5(answers) {
  if (!answers || typeof answers !== 'object') return { score: 0, maxScore: MAX_SCORE_5 };
  let score = 0;
  for (const [qId, correct] of Object.entries(CORRECT_ANSWERS_5)) {
    if (correct) {
      score += scoreMcq(answers[qId], correct);
    }
  }
  return { score, maxScore: MAX_SCORE_5 };
}

exports.getQuestionResults = getQuestionResults;
exports.CORRECT_ANSWERS = CORRECT_ANSWERS;
exports.CORRECT_ANSWERS_2 = CORRECT_ANSWERS_2;
exports.CORRECT_ANSWERS_3 = CORRECT_ANSWERS_3;
exports.CORRECT_ANSWERS_4 = CORRECT_ANSWERS_4;
exports.CORRECT_ANSWERS_5 = CORRECT_ANSWERS_5;

exports.submitAssessment = async (req, res) => {
  try {
    const { name, phone, answers } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const fullName = name.trim();
    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'name must be at least 2 characters' });
    }

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const inMemoryVerified = otpStore.isVerified(p);
    if (!inMemoryVerified) {
      const since = new Date(Date.now() - VERIFIED_TTL_MS);
      const session = await VerifiedPhoneSession.findOne({ phone: p, verifiedAt: { $gte: since } }).lean();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
      }
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, message: 'answers object is required' });
    }

    const { score, maxScore } = computeScore(answers);
    const questionResults = getQuestionResults(answers, CORRECT_ANSWERS);

    const payload = {
      fullName,
      phone: p,
      answers,
      score,
      maxScore,
      submittedAt: new Date(),
      updatedAt: new Date()
    };

    const doc = await AssessmentSubmission.findOneAndUpdate(
      { phone: p },
      { $set: payload },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Assessment submitted successfully.',
      score: doc.score,
      maxScore: doc.maxScore,
      questionResults
    });
  } catch (err) {
    console.error('[submitAssessment]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.submitAssessment2 = async (req, res) => {
  try {
    const { name, phone, answers } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const fullName = name.trim();
    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'name must be at least 2 characters' });
    }

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const inMemoryVerified = otpStore.isVerified(p);
    if (!inMemoryVerified) {
      const since = new Date(Date.now() - VERIFIED_TTL_MS);
      const session = await VerifiedPhoneSession.findOne({ phone: p, verifiedAt: { $gte: since } }).lean();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
      }
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, message: 'answers object is required' });
    }

    const { score, maxScore } = computeScore2(answers);
    const questionResults = getQuestionResults(answers, CORRECT_ANSWERS_2);

    const payload = {
      fullName,
      phone: p,
      answers,
      score,
      maxScore,
      submittedAt: new Date(),
      updatedAt: new Date()
    };

    const doc = await AssessmentSubmission2.findOneAndUpdate(
      { phone: p },
      { $set: payload },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Assessment 2 submitted successfully.',
      score: doc.score,
      maxScore: doc.maxScore,
      questionResults
    });
  } catch (err) {
    console.error('[submitAssessment2]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.submitAssessment3 = async (req, res) => {
  try {
    const { name, phone, answers } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const fullName = name.trim();
    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'name must be at least 2 characters' });
    }

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const inMemoryVerified = otpStore.isVerified(p);
    if (!inMemoryVerified) {
      const since = new Date(Date.now() - VERIFIED_TTL_MS);
      const session = await VerifiedPhoneSession.findOne({ phone: p, verifiedAt: { $gte: since } }).lean();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
      }
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, message: 'answers object is required' });
    }

    const { score, maxScore } = computeScore3(answers);
    const questionResults = getQuestionResults(answers, CORRECT_ANSWERS_3);

    const payload = {
      fullName,
      phone: p,
      answers,
      score,
      maxScore,
      submittedAt: new Date(),
      updatedAt: new Date()
    };

    const doc = await AssessmentSubmission3.findOneAndUpdate(
      { phone: p },
      { $set: payload },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Assessment 3 submitted successfully.',
      score: doc.score,
      maxScore: doc.maxScore,
      questionResults
    });
  } catch (err) {
    console.error('[submitAssessment3]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * GET /api/assessment-3/check?phone=XXXXXXXXXX
 * Public lightweight eligibility check for poster/download flows.
 */
exports.checkAssessment3Eligibility = async (req, res) => {
  try {
    const rawPhone = req.query?.phone ?? req.body?.phone ?? req.body?.mobileNumber;
    const p = normalizePhone(rawPhone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 10-digit Indian phone required',
      });
    }

    const exists = isPrivilegedPhone(p) || !!(await AssessmentSubmission3.exists({ phone: p }));
    return res.status(200).json({
      success: true,
      eligible: exists,
      data: { exists, phone: p },
    });
  } catch (err) {
    console.error('[checkAssessment3Eligibility]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.checkActivationEligibility = async (req, res) => {
  try {
    const rawPhone = req.query?.phone ?? req.body?.phone ?? req.body?.mobileNumber;
    const p = normalizePhone(rawPhone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
    }
    const phoneMatch = { $or: [{ mobileNumber: p }, { whatsappNumber: p }] };
    const exists =
      isPrivilegedPhone(p) ||
      !!(await CertifiedCounsellor2627.exists(phoneMatch)) ||
      !!(await TrainingFeedback.exists(phoneMatch));
    return res.status(200).json({ success: true, eligible: exists, data: { exists, phone: p } });
  } catch (err) {
    console.error('[checkActivationEligibility]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.submitAssessment4 = async (req, res) => {
  try {
    const { name, phone, answers } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const fullName = name.trim();
    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'name must be at least 2 characters' });
    }

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const inMemoryVerified = otpStore.isVerified(p);
    if (!inMemoryVerified) {
      const since = new Date(Date.now() - VERIFIED_TTL_MS);
      const session = await VerifiedPhoneSession.findOne({ phone: p, verifiedAt: { $gte: since } }).lean();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
      }
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, message: 'answers object is required' });
    }

    const { score, maxScore } = computeScore4(answers);
    const questionResults = getQuestionResults(answers, CORRECT_ANSWERS_4);

    const payload = {
      fullName,
      phone: p,
      answers,
      score,
      maxScore,
      submittedAt: new Date(),
      updatedAt: new Date()
    };

    const doc = await AssessmentSubmission4.findOneAndUpdate(
      { phone: p },
      { $set: payload },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Assessment 4 submitted successfully.',
      score: doc.score,
      maxScore: doc.maxScore,
      questionResults
    });
  } catch (err) {
    console.error('[submitAssessment4]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.submitAssessment5 = async (req, res) => {
  try {
    const { name, phone, answers } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const fullName = name.trim();
    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'name must be at least 2 characters' });
    }

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const inMemoryVerified = otpStore.isVerified(p);
    if (!inMemoryVerified) {
      const since = new Date(Date.now() - VERIFIED_TTL_MS);
      const session = await VerifiedPhoneSession.findOne({ phone: p, verifiedAt: { $gte: since } }).lean();
      if (!session) {
        return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
      }
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ success: false, message: 'answers object is required' });
    }

    const { score, maxScore } = computeScore5(answers);
    const questionResults = getQuestionResults(answers, CORRECT_ANSWERS_5);

    const payload = {
      fullName,
      phone: p,
      answers,
      score,
      maxScore,
      submittedAt: new Date(),
      updatedAt: new Date()
    };

    const doc = await AssessmentSubmission5.findOneAndUpdate(
      { phone: p },
      { $set: payload },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Assessment 5 submitted successfully.',
      score: doc.score,
      maxScore: doc.maxScore,
      questionResults
    });
  } catch (err) {
    console.error('[submitAssessment5]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
