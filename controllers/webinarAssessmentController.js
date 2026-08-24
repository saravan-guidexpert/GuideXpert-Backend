const mongoose = require('mongoose');
const WebinarAssessmentSubmission = require('../models/WebinarAssessmentSubmission');
const { getWebinarUserFromToken } = require('../utils/webinarJwtAuth');

const VALID_IDS = ['a1', 'a2', 'a3', 'a4', 'a5'];

function parseHistoryLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

/**
 * POST /submit
 * Body: { assessmentId, score, total, results, answers }
 * Optional: Authorization: Bearer <webinar JWT> to attach phone/name.
 * Stores each attempt as a new record so history can be shown.
 */
async function submitWebinarAssessment(req, res) {
  try {
    const { assessmentId, score, total, results, answers } = req.body || {};

    if (!assessmentId || !VALID_IDS.includes(assessmentId)) {
      return res.status(400).json({ success: false, message: 'Valid assessmentId (a1–a5) is required.' });
    }
    if (typeof score !== 'number' || score < 0) {
      return res.status(400).json({ success: false, message: 'score must be a non-negative number.' });
    }
    if (typeof total !== 'number' || total < 0) {
      return res.status(400).json({ success: false, message: 'total must be a non-negative number.' });
    }
    if (!Array.isArray(results)) {
      return res.status(400).json({ success: false, message: 'results must be an array.' });
    }
    const answersObj = answers && typeof answers === 'object' ? answers : {};

    let phone = null;
    let fullName = null;
    try {
      const user = await getWebinarUserFromToken(req);
      phone = user?.phone ?? null;
      fullName = user?.fullName ?? null;
    } catch (authErr) {
      console.warn('[submitWebinarAssessment] getWebinarUserFromToken', authErr?.message || authErr);
    }

    const sanitizedResults = results.map((r) => ({
      questionId: r != null && r.questionId != null ? String(r.questionId) : '',
      text: r != null && r.text != null ? String(r.text) : '',
      correct: !!(r != null && r.correct),
      userAnswer: r != null && r.userAnswer != null ? String(r.userAnswer) : '',
      correctAnswer: r != null && r.correctAnswer != null ? String(r.correctAnswer) : '',
    }));

    const payload = {
      assessmentId,
      phone: phone || undefined,
      fullName: fullName || undefined,
      score,
      total,
      results: sanitizedResults,
      answers: answersObj,
      submittedAt: new Date(),
      updatedAt: new Date(),
      trainingYear: '26-27',
    };

    const created = await WebinarAssessmentSubmission.create(payload);

    return res.status(200).json({
      success: true,
      message: 'Assessment saved.',
      data: {
        assessmentId,
        score,
        total,
        submittedAt: created.submittedAt,
      },
    });
  } catch (err) {
    console.error('[submitWebinarAssessment]', err.name, err.message, process.env.NODE_ENV === 'development' ? err.stack : '');
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid submission data.',
        ...(process.env.NODE_ENV === 'development' && { details: err.message }),
      });
    }
    const isConnectionError =
      mongoose.connection.readyState !== 1 ||
      (err.name && (err.name === 'MongoServerError' || err.name === 'MongoNetworkError' || err.name === 'MongoTimeoutError')) ||
      (err.message && typeof err.message === 'string' && (err.message.includes('connection') || err.message.includes('not open')));
    if (isConnectionError) {
      return res.status(503).json({ success: false, message: 'Service temporarily unavailable. Please try again.' });
    }
    const message = process.env.NODE_ENV === 'development' ? err.message : 'Failed to save assessment.';
    return res.status(500).json({ success: false, message });
  }
}

/**
 * GET /history?assessmentId=a1&limit=5
 * Returns latest attempts for authenticated webinar user.
 * Never throws: returns 200 with { attempts: [] } on auth/DB errors so frontend can use localStorage fallback.
 */
async function getWebinarAssessmentHistory(req, res) {
  let phone = null;
  try {
    const assessmentId = String(req.query?.assessmentId || '').trim();
    if (!VALID_IDS.includes(assessmentId)) {
      return res.status(400).json({ success: false, message: 'Valid assessmentId (a1–a5) is required.' });
    }

    try {
      const user = await getWebinarUserFromToken(req);
      phone = user?.phone ?? null;
    } catch (authErr) {
      console.warn('[getWebinarAssessmentHistory] getWebinarUserFromToken', authErr?.message || authErr);
    }
    if (!phone) {
      return res.status(200).json({ success: true, data: { attempts: [] } });
    }

    const limit = parseHistoryLimit(req.query?.limit);
    let attempts = [];
    try {
      attempts = await WebinarAssessmentSubmission.find({ assessmentId, phone, trainingYear: '26-27' })
        .sort({ submittedAt: -1, createdAt: -1 })
        .limit(limit)
        .select({ _id: 1, score: 1, total: 1, submittedAt: 1, createdAt: 1, updatedAt: 1 })
        .lean();
      if (!Array.isArray(attempts)) attempts = [];
    } catch (dbErr) {
      console.error('[getWebinarAssessmentHistory] find failed', dbErr);
    }

    return res.status(200).json({
      success: true,
      data: { attempts },
    });
  } catch (err) {
    console.error('[getWebinarAssessmentHistory]', err);
    return res.status(200).json({ success: true, data: { attempts: [] } });
  }
}

module.exports = {
  submitWebinarAssessment,
  getWebinarAssessmentHistory,
};
