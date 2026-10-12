const mongoose = require('mongoose');
const crypto = require('crypto');
const { generateOTP, hashOTP, verifyOTP } = require('../utils/otpUtil');
const otpStore = require('../utils/otpStore');
const otpRepository = require('../utils/otpRepository');
const { sendOtp: sendOtpSms, sendOtpDirect, sendOtpViaFlow, getMsg91Diagnostics, sendSlotConfirmationSms, sendReminderSms, sendMeetLinkSms, sendReminder30MinSms } = require('../utils/msg91Service');
const { getDemoSlots } = require('../utils/demoSlots');
const { appendFormSubmission } = require('../utils/sheetsService');
const jwt = require('jsonwebtoken');
const FormSubmission = require('../models/FormSubmission');
const IitCounsellingSubmission = require('../models/IitCounsellingSubmission');
const TrainingFeedback = require('../models/TrainingFeedback');
const TrainingFormSubmission = require('../models/TrainingFormSubmission');
const TrainingFormResponse = require('../models/TrainingFormResponse');
const VerifiedPhoneSession = require('../models/VerifiedPhoneSession');
const WebsiteLogin = require('../models/WebsiteLogin');
const IitCounsellingVisit = require('../models/IitCounsellingVisit');
const SlotConfig = require('../models/SlotConfig');
const SlotDateOverride = require('../models/SlotDateOverride');
const WhatsAppRetryGroup = require('../models/WhatsAppRetryGroup');
const { getISTCalendarDateUTC } = require('../utils/dateHelpers');
const { appendRow, updateRow, markRowDeleted } = require('../utils/googleSheetsService');
const { findOrCreateCounsellorAndGetToken } = require('./counsellorAuthController');
const { isOsviConfigured } = require('../utils/osviService');
const { getOsviEnabled, getOsviAbandonedDelayMs } = require('../utils/appSettings');
const { listExams } = require('../services/rankPredictorService');
const { buildSlotNotificationVariables } = require('../utils/slotNotificationFormatters');
const { recordStudentLiveActivity } = require('./studentLiveActivityController');
const gupshupService = require('../services/gupshupService');
const { safeSendWhatsApp } = require('../utils/safeSendWhatsApp');
const { computeIitCounsellingSlotInstantUtc } = require('../utils/iitCounsellingSlotUtc');
const { getEnabledIitSlotBookings, isIitSlotBookingEnabled, getIitSlotDateOverridesInRange } = require('../utils/iitSlotAvailability');
const { buildIitCounsellingSlotOptions } = require('../utils/iitCounsellingSlotOptions');
const { isPrivilegedPhone, getPrivilegedOtp, shouldSkipSmsForPrivileged } = require('../utils/privilegedAccess');
const { resolveIitSlotBookedTemplateEnvKey } = require('../utils/iitCounsellingWhatsApp');
const { shouldSendCampaignReminderImmediately } = require('../utils/waReminderEligibility');
const {
  ensureReminderJobsForSubmission,
  dispatchDueJobsForSubmission
} = require('../services/whatsappReminderScheduler');

/** Optional body.rankPredictorLead — validated snapshot for admin follow-up. */
function parseRankPredictorLeadFromBody(body) {
  const raw = body?.rankPredictorLead;
  if (!raw || typeof raw !== 'object') return null;
  const examId = typeof raw.examId === 'string' ? raw.examId.trim() : '';
  const allowedIds = new Set(listExams().map((e) => e.id));
  if (!examId || !allowedIds.has(examId)) return null;
  const score = Number(raw.score);
  if (!Number.isFinite(score)) return null;
  let difficulty;
  if (raw.difficulty != null && typeof raw.difficulty === 'string') {
    const d = raw.difficulty.trim();
    if (d) difficulty = d.slice(0, 64);
  }
  return {
    examId,
    score,
    ...(difficulty ? { difficulty } : {}),
    capturedAt: new Date(),
  };
}

/** Optional body.studentProfile — age / studying / city from student workspace signup. */
function parseStudentProfileFromBody(body) {
  const raw = body?.studentProfile;
  if (!raw || typeof raw !== 'object') return null;
  const out = { updatedAt: new Date() };
  let has = false;
  if (raw.age != null && raw.age !== '') {
    const age = Number(raw.age);
    if (Number.isFinite(age) && age >= 10 && age <= 80) {
      out.age = age;
      has = true;
    }
  }
  if (typeof raw.currentlyStudying === 'string' && raw.currentlyStudying.trim()) {
    out.currentlyStudying = raw.currentlyStudying.trim().slice(0, 64);
    has = true;
  }
  if (typeof raw.city === 'string' && raw.city.trim()) {
    out.city = raw.city.trim().slice(0, 120);
    has = true;
  }
  return has ? out : null;
}

function parseStudentActivityFromBody(body) {
  const raw = body?.activity || body;
  if (!raw || typeof raw !== 'object') return null;
  const type = typeof raw.type === 'string' ? raw.type.trim().slice(0, 64) : '';
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  if (!type || !title) return null;
  return {
    type,
    tool: typeof raw.tool === 'string' ? raw.tool.trim().slice(0, 120) : type,
    title,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 500) : '',
    examId: typeof raw.examId === 'string' ? raw.examId.trim().slice(0, 64) : undefined,
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : undefined,
    createdAt: new Date(),
  };
}

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Sheet1';

const VALID_SLOT_ID_REGEX = /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)_(7PM|11AM|3PM|6PM)$/;
function isValidSlotId(slot) {
  return typeof slot === 'string' && VALID_SLOT_ID_REGEX.test(slot);
}

async function appendToSheetIfConfigured(submission) {
  if (!GOOGLE_SHEET_ID || !submission) {
    if (!GOOGLE_SHEET_ID) {
      console.warn('[Sheets] Append skipped: GOOGLE_SHEET_ID not set in .env');
    }
    return;
  }
  try {
    const result = await appendFormSubmission(GOOGLE_SHEET_ID, submission, GOOGLE_SHEET_RANGE);
    if (result.success) {
      console.log('[Sheets] Row appended to Google Sheet successfully');
    } else {
      console.error('[Sheets] Append failed (best-effort):', result.error);
    }
  } catch (err) {
    console.error('[Sheets] Append error (best-effort):', err.message);
  }
}

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES) || 10;
const OTP_EXPIRY_MS = OTP_EXPIRY_MINUTES * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 3;
const IIT_SUBMISSION_TYPE = 'iitCounselling';

const IIT_ALLOWED_VALUES = {
  studentOrParent: ['Student', 'Parent'],
  // Keep in sync with GuideXpert-Frontend/src/pages/IitCounsellingPage.jsx CURRENT_STUDYING_OPTIONS and IitCounsellingSubmission schema.
  classStatus: [
    'Completed 12th/Intermediate 2nd Year',
    'Studying 12th/Intermediate 2nd Year',
    'Studying 11th/Intermediate 1st Year',
    'Degree Completed',
    'Degree Studying',
    'Engineering Completed',
    'Engineering Studying',
    'Diploma',
  ],
  stream: ['MPC', 'BiPC', 'Commerce', 'Others'],
  // Keep in sync with GuideXpert-Frontend/src/utils/weekendSlots.js getAvailableSlots() values.
  slotBooking: ['Wednesday 6PM', 'Saturday 6PM', 'Sunday 11AM'],
  careerDecisionClarity: ['Very clear', 'Somewhat clear', 'Completely confused'],
  collegeDecisionStakeholder: ['Self', 'Parents', 'Both'],
  expectedBudget: ['<1L', '1-3L', '3-6L', '6L+'],
  topCollegePriority: ['Placements', 'Brand', 'Fees', 'Skills', 'Abroad opportunities', 'All the above'],
  preferredLanguage: ['Telugu', 'Hindi'],
  helpNeeded: ['Scholarship Test', 'Career Counseling with IITian', 'How to choose the right college', 'Not sure'],
  wantsOneToOneSession: ['Yes', 'Maybe', 'No'],
  biggestConfusion: ['Course', 'College', 'Placements', 'Parent pressure', 'Not sure'],
};

const IIT_SLOT_BOOKING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IIT_SLOT_TO_IST_WEEKDAY_SHORT = {
  'Wednesday 6PM': 'Wed',
  'Saturday 6PM': 'Sat',
  'Sunday 11AM': 'Sun',
};

/** Map IIT counselling booking label to GX slot-id shape for WhatsApp/SMS template time tokens. */
const IIT_BOOKING_LABEL_TO_SELECTED_SLOT_ID = {
  'Wednesday 6PM': 'WEDNESDAY_6PM',
  'Saturday 6PM': 'SATURDAY_6PM',
  'Sunday 11AM': 'SUNDAY_11AM'
};

function istWeekdayShortFromYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' }).format(d);
}

/** Optional slotBookingDate from client: YYYY-MM-DD and weekday must match slot (IST). */
function normalizeOptionalSlotBookingDate(payload, slotBookingTrimmed) {
  const raw = payload.slotBookingDate;
  if (raw == null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, message: 'slotBookingDate must be a string' };
  }
  const ymd = raw.trim();
  if (!IIT_SLOT_BOOKING_DATE_RE.test(ymd)) {
    return { ok: false, message: 'slotBookingDate must be YYYY-MM-DD' };
  }
  const expected = IIT_SLOT_TO_IST_WEEKDAY_SHORT[slotBookingTrimmed];
  if (!expected) return { ok: true, value: null };
  const actual = istWeekdayShortFromYmd(ymd);
  if (actual !== expected) {
    return { ok: false, message: 'slotBookingDate does not match slot weekday (IST)' };
  }
  return { ok: true, value: ymd };
}

function normalizePhone(phone) {
  return otpRepository.normalize(phone);
}

function requireAllowedValue(value, allowedValues, fieldLabel) {
  if (typeof value !== 'string' || !allowedValues.includes(value.trim())) {
    return `${fieldLabel} is invalid`;
  }
  return null;
}

function normalizeTopColleges(raw) {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 5);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  return [];
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const firstForwarded = Array.isArray(xff) ? xff[0] : (typeof xff === 'string' ? xff.split(',')[0] : '');
  return (firstForwarded || req.ip || req.socket?.remoteAddress || '').trim().slice(0, 120);
}

function dayKeyFromDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function buildVisitorFingerprint({ ip, userAgent, dayKey }) {
  const seed = `${ip || 'na'}|${userAgent || 'na'}|${dayKey || dayKeyFromDate()}`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

/** Build UTM fields from request body (only non-empty strings). */
function getUtmFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const utm = {};
  if (typeof body.utm_source === 'string' && body.utm_source.trim()) utm.utm_source = body.utm_source.trim();
  if (typeof body.utm_medium === 'string' && body.utm_medium.trim()) utm.utm_medium = body.utm_medium.trim();
  if (typeof body.utm_campaign === 'string' && body.utm_campaign.trim()) utm.utm_campaign = body.utm_campaign.trim();
  if (typeof body.utm_content === 'string' && body.utm_content.trim()) utm.utm_content = body.utm_content.trim();
  return Object.keys(utm).length ? utm : null;
}

/** Merge UTM into update set only when existing doc has no first-touch UTM yet. */
function mergeUtmIfFirstTouch(setPayload, body, existingDoc) {
  const utm = getUtmFromBody(body);
  if (!utm) return;
  const hasExisting = existingDoc && (
    (existingDoc.utm_content != null && existingDoc.utm_content !== '') ||
    (existingDoc.utm_source != null && existingDoc.utm_source !== '')
  );
  if (!hasExisting) {
    Object.assign(setPayload, utm);
  }
}

exports.sendOtp = async (req, res) => {
  try {
    const { fullName, occupation } = req.body || {};
    const phoneRaw = req.body?.phone || req.body?.whatsappNumber;

    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'fullName is required' });
    }
    if (phoneRaw == null || phoneRaw === '') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const phoneStr = typeof phoneRaw === 'string' ? phoneRaw.trim() : String(phoneRaw);
    const p = normalizePhone(phoneStr);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    if (!occupation || typeof occupation !== 'string' || !occupation.trim()) {
      return res.status(400).json({ success: false, message: 'occupation is required' });
    }

    const canSend = await otpRepository.canSend(p);
    if (!canSend.allowed) {
      return res.status(429).json({
        success: false,
        message: canSend.message || 'Too many OTP requests. Try again later.',
        retryAfter: canSend.retryAfter
      });
    }

    const privileged = isPrivilegedPhone(p);
    const otp = privileged ? getPrivilegedOtp() : generateOTP();
    const hashed = hashOTP(otp);
    const expiresAt = Date.now() + OTP_EXPIRY_MS;

    const skipSms = shouldSkipSmsForPrivileged(p) || (process.env.NODE_ENV !== 'production' && req.body?.skipSms === true);

    let gw = null;
    if (!skipSms) {
      gw = await sendOtpSms(p, otp);
      if (!gw.success) {
        if (privileged) {
          console.warn('[sendOtp] SMS gateway returned error for privileged phone, continuing with bypass code:', gw.error);
        } else {
          return res.status(502).json({
            success: false,
            message: 'Could not send OTP.',
            detail: gw.error || 'SMS service error'
          });
        }
      }
    } else {
      console.log('[sendOtp] Privileged OTP bypass (no SMS) for phone ending', p.slice(-4));
    }

    const saveResult = await otpRepository.saveOtp(p, hashed, expiresAt);
    if (saveResult.storage === 'memory') {
      console.warn(
        '[sendOtp] OTP stored in memory fallback for phone ending',
        p.slice(-4),
        saveResult.mongoError || ''
      );
    } else if (process.env.NODE_ENV !== 'production') {
      console.log('[sendOtp] OTP saved for phone ending', p.slice(-4));
    }

    // Apply abandonment flow: schedule OSVI for +10 minutes after OTP if enabled.
    const scheduleOsviForAbandonment = req.body?.scheduleOsviForAbandonment === true;
    const abandonedDelayMs = await getOsviAbandonedDelayMs();
    if (scheduleOsviForAbandonment) {
      if (!isOsviConfigured()) {
        console.warn('[sendOtp] [OSVI] Abandonment scheduling requested but OSVI not configured');
      } else {
        const osviEnabled = await getOsviEnabled();
        if (!osviEnabled) {
          console.log('[sendOtp] [OSVI] Abandonment scheduling skipped: disabled via admin toggle');
        } else {
          const dueAt = new Date(Date.now() + abandonedDelayMs);
          await FormSubmission.findOneAndUpdate(
            { phone: p },
            {
              $setOnInsert: {
                fullName: String(fullName).trim(),
                phone: p,
                occupation: String(occupation).trim(),
                createdAt: new Date(),
              },
              $set: {
                step1Data: {
                  fullName: String(fullName).trim(),
                  whatsappNumber: p,
                  occupation: String(occupation).trim(),
                  step1CompletedAt: new Date(),
                },
                osviOutboundScheduledAt: dueAt,
                osviOutboundCallStatus: 'pending',
                osviOutboundLastError: null,
                osviOutboundCompletedAt: null,
                updatedAt: new Date(),
              },
            },
            { upsert: true, new: true, runValidators: true }
          );
          console.log(
            `[sendOtp] [OSVI] Abandonment call scheduled for ***${p.slice(-4)} at ${dueAt.toISOString()}`
          );
        }
      }
    }

    const responsePayload = { success: true, message: 'OTP sent successfully' };
    if (gw?.details) {
      responsePayload.provider = gw.details;
    }
    if (privileged) {
      responsePayload.isPrivileged = true;
      if (process.env.NODE_ENV !== 'production') {
        responsePayload.bypassOtp = otp;
      }
    }
    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error('[sendOtp] Unexpected error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const phoneRaw = req.body?.phone ?? req.body?.whatsappNumber;
    const otp = req.body?.otp;
    if (phoneRaw == null || phoneRaw === '') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const phoneStr = typeof phoneRaw === 'string' ? phoneRaw.trim() : String(phoneRaw);
    const p = normalizePhone(phoneStr);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    const otpStr = otp != null ? String(otp).trim() : '';
    if (!/^\d{6}$/.test(otpStr)) {
      return res.status(400).json({ success: false, message: 'OTP must be 6 digits' });
    }

    let rec = await otpRepository.getLatest(p);
    if (!rec) {
      await new Promise((r) => setTimeout(r, 1500));
      rec = await otpRepository.getLatest(p);
    }
    if (!rec) {
      await new Promise((r) => setTimeout(r, 2000));
      rec = await otpRepository.getLatest(p);
    }
    if (!rec) {
      console.warn('[verifyOtp] No OTP found after 3 attempts for phone ending', p.slice(-4),
        '| DB state:', mongoose.connection.readyState);
      return res.status(400).json({
        success: false,
        message: 'No OTP found for this number. Request a new OTP and verify within a few minutes. Use the same number you used to request the OTP.',
      });
    }
    if (new Date(rec.expiresAt) < new Date()) {
      await otpRepository.deleteOtp(p);
      return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new OTP.' });
    }
    if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
      await otpRepository.deleteOtp(p);
      return res.status(400).json({ success: false, message: 'Too many attempts. Please request a new OTP.' });
    }
    if (!verifyOTP(otpStr, rec.otpHash)) {
      const updated = await otpRepository.incrementAttempts(p);
      if (updated && updated.attempts >= MAX_VERIFY_ATTEMPTS) {
        await otpRepository.deleteOtp(p);
      }
      return res.status(400).json({ success: false, message: 'Invalid OTP. Please check the code and try again.' });
    }

    await otpRepository.deleteOtp(p);
    otpStore.addVerified(p);
    // Persist for serverless: login-with-phone may hit another instance
    try {
      await VerifiedPhoneSession.findOneAndUpdate(
        { phone: p },
        { $set: { verifiedAt: new Date() } },
        { upsert: true }
      );
    } catch (sessionErr) {
      console.error('[verifyOtp] VerifiedPhoneSession update failed (continuing):', sessionErr.message);
    }

    // Same flow as registration: optionally complete counsellor login in this request (one verify call)
    const counsellorLogin = req.body?.counsellorLogin === true;
    if (counsellorLogin) {
      try {
        const privilegedCounsellor = isPrivilegedPhone(p);
        // Only grant counsellor access if phone is in activation form results (TrainingFeedback)
        const record = privilegedCounsellor
          ? null
          : await TrainingFeedback.findOne({ $or: [{ mobileNumber: p }, { whatsappNumber: p }] })
              .sort({ createdAt: -1 })
              .lean();
        if (!privilegedCounsellor && !record) {
          otpStore.removeVerified(p);
          return res.status(200).json({
            success: true,
            message: 'OTP verified',
            verified: true,
            allowedAccess: false,
          });
        }
        const payload = await findOrCreateCounsellorAndGetToken(p);
        otpStore.removeVerified(p);
        const accessForm = {};
        const fullName = privilegedCounsellor
          ? 'Privileged QA'
          : record.name != null
            ? String(record.name).trim()
            : '';
        if (fullName) accessForm.fullName = fullName;
        if (record?.email != null && String(record.email).trim()) {
          accessForm.email = String(record.email).trim().toLowerCase();
        }
        if (record?.occupation != null && String(record.occupation).trim()) {
          accessForm.occupation = String(record.occupation).trim();
        }
        accessForm.phone = p;
        return res.status(200).json({
          success: true,
          message: 'OTP verified',
          verified: true,
          allowedAccess: true,
          token: payload.token,
          user: payload.user,
          accessForm: Object.keys(accessForm).length ? accessForm : undefined,
        });
      } catch (err) {
        if (err.code === 'CONFIG') {
          return res.status(500).json({ success: false, message: 'Counsellor login is not configured. Please contact support.' });
        }
        console.error('[verifyOtp] counsellorLogin failed:', {
          name: err.name,
          code: err.code,
          message: err.message,
          keyPattern: err.keyPattern,
        }, err.stack);
        const safeMessage = process.env.NODE_ENV === 'production'
          ? 'Login failed. Please try again or contact support.'
          : (err.message || 'Login failed. Please try again or contact support.');
        return res.status(500).json({ success: false, message: safeMessage });
      }
    }

    // Webinar login: only grant access if phone is in training form submissions or responses (same 10-digit normalization as form save)
    const webinarLogin = req.body?.webinarLogin === true;
    if (webinarLogin) {
      const webinarSecret = process.env.WEBINAR_JWT_SECRET || process.env.COUNSELLOR_JWT_SECRET || process.env.JWT_SECRET || '';
      if (!webinarSecret || !String(webinarSecret).trim()) {
        console.error('[verifyOtp] Webinar JWT secret missing. Set WEBINAR_JWT_SECRET or COUNSELLOR_JWT_SECRET or JWT_SECRET in env.');
        otpStore.removeVerified(p);
        return res.status(500).json({ success: false, message: 'Webinar login is not configured. Please contact support.' });
      }
      try {
        const privilegedWebinar = isPrivilegedPhone(p);
        // Check both collections: live submissions use TrainingFormSubmission; seeded/legacy may use TrainingFormResponse
        let record = privilegedWebinar
          ? null
          : await TrainingFormSubmission.findOne({ mobileNumber: p }).sort({ createdAt: -1 }).lean();
        if (!record && !privilegedWebinar) {
          record = await TrainingFormResponse.findOne({ mobileNumber: p }).sort({ createdAt: -1 }).lean();
        }
        if (!privilegedWebinar && !record) {
          otpStore.removeVerified(p);
          return res.status(200).json({
            success: true,
            message: 'OTP verified',
            verified: true,
            allowedAccess: false,
          });
        }
        otpStore.removeVerified(p);
        const webinarExpiresIn = process.env.WEBINAR_JWT_EXPIRES_IN || '7d';
        const trainingFormId = record?._id?.toString() || `privileged-${p}`;
        const token = jwt.sign(
          { webinarPhone: p, trainingFormId, role: 'webinar', privileged: privilegedWebinar },
          webinarSecret.trim(),
          { expiresIn: webinarExpiresIn }
        );
        const user = {
          name: record?.fullName != null ? String(record.fullName).trim() : 'Privileged QA',
          phone: p,
          email: record?.email != null ? String(record.email).trim() : '',
        };
        return res.status(200).json({
          success: true,
          message: 'OTP verified',
          verified: true,
          allowedAccess: true,
          token,
          user,
        });
      } catch (err) {
        console.error('[verifyOtp] webinarLogin failed:', err.message, err.stack);
        otpStore.removeVerified(p);
        const safeMessage = process.env.NODE_ENV === 'production'
          ? 'Login failed. Please try again or contact support.'
          : (err.message || 'Login failed. Please try again or contact support.');
        return res.status(500).json({ success: false, message: safeMessage });
      }
    }

    return res.status(200).json({ success: true, message: 'OTP verified', verified: true });
  } catch (err) {
    console.error('[verifyOtp]', err.message, err.stack);
    const message = process.env.NODE_ENV === 'production'
      ? 'Verification failed. Please try again.'
      : (err.message || 'Something went wrong.');
    return res.status(500).json({ success: false, message });
  }
};

/**
 * POST body: { phone } only.
 * Saves the phone number to DB as a "website login" (for external sites that only send phone).
 */
exports.logPhone = async (req, res) => {
  try {
    const phone = req.body?.phone || req.body?.whatsappNumber;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    await WebsiteLogin.create({ phone: p });
    return res.status(200).json({ success: true, message: 'Phone logged' });
  } catch (err) {
    console.error('[logPhone]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.getDemoSlots = async (req, res) => {
  try {
    const result = await getDemoSlots();
    return res.status(200).json(result);
  } catch (err) {
    console.error('[getDemoSlots] Error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.getIitCounsellingSlots = async (req, res) => {
  try {
    const enabledSlotBookings = await getEnabledIitSlotBookings();
    const now = new Date();
    const fromYmd = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const toDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const toYmd = toDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const dateOverrides = await getIitSlotDateOverridesInRange(fromYmd, toYmd);
    const slotOptions = buildIitCounsellingSlotOptions(now, enabledSlotBookings, dateOverrides);
    return res.status(200).json({
      success: true,
      enabledSlotBookings,
      dateOverrides,
      slotOptions,
      data: { enabledSlotBookings, dateOverrides, slotOptions },
    });
  } catch (err) {
    console.error('[getIitCounsellingSlots] Error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.saveStep1 = async (req, res) => {
  try {
    const { fullName, occupation } = req.body || {};
    const phone = req.body?.phone || req.body?.whatsappNumber;

    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'fullName is required' });
    }
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    if (!occupation || typeof occupation !== 'string' || !occupation.trim()) {
      return res.status(400).json({ success: false, message: 'occupation is required' });
    }

    const step1Data = {
      fullName: fullName.trim(),
      whatsappNumber: p,
      occupation: occupation.trim(),
      step1CompletedAt: new Date()
    };

    const setPayload = {
      fullName: fullName.trim(),
      phone: p,
      occupation: occupation.trim(),
      step1Data,
      currentStep: 1,
      applicationStatus: 'in_progress',
      updatedAt: new Date()
    };
    const utm = getUtmFromBody(req.body);
    if (utm) {
      // Student workspace auth always owns the lead tag so logins/actions show under Student workspace leads
      if (utm.utm_content === 'student_workspace_login') {
        Object.assign(setPayload, utm);
      } else {
        const existingForUtm = await FormSubmission.findOne({ phone: p })
          .select('utm_source utm_content')
          .lean();
        mergeUtmIfFirstTouch(setPayload, req.body, existingForUtm);
      }
    }

    const rankPredictorLead = parseRankPredictorLeadFromBody(req.body);
    if (rankPredictorLead) {
      setPayload.rankPredictorLead = rankPredictorLead;
    }

    const studentProfile = parseStudentProfileFromBody(req.body);
    if (studentProfile) {
      setPayload.studentProfile = studentProfile;
    }

    const loginOnly = req.body?.loginOnly === true;
    const existing = loginOnly ? await FormSubmission.findOne({ phone: p }).lean() : null;
    if (existing) {
      // Login OTP path: keep a real signup name; replace placeholder "Student" with the name they enter
      const existingName = String(existing.fullName || '').trim();
      const incomingName = String(fullName || '').trim();
      const isPlaceholder = (n) => {
        const v = String(n || '').trim().toLowerCase();
        return !v || v === 'student' || v === 'a student' || v === 'user';
      };
      if (!isPlaceholder(existingName)) {
        setPayload.fullName = existingName;
      } else if (!isPlaceholder(incomingName)) {
        setPayload.fullName = incomingName;
      }
      if (existing.occupation) setPayload.occupation = existing.occupation;
      if (existing.step1Data && typeof existing.step1Data === 'object') {
        setPayload.step1Data = {
          ...existing.step1Data,
          fullName: setPayload.fullName,
          whatsappNumber: p,
          step1CompletedAt: existing.step1Data.step1CompletedAt || new Date(),
        };
      }
      if (!studentProfile && existing.studentProfile) {
        delete setPayload.studentProfile;
      }
      if (existing.applicationStatus) {
        setPayload.applicationStatus = existing.applicationStatus;
      }
      if (existing.currentStep) {
        setPayload.currentStep = Math.max(existing.currentStep, 1);
      }
    }

    console.log('[saveStep1] Attempting to save:', { phone: p, fullName: setPayload.fullName, occupation: setPayload.occupation });

    const result = await FormSubmission.findOneAndUpdate(
      { phone: p },
      { $set: setPayload },
      { upsert: true, new: true, runValidators: true }
    );

    console.log('[saveStep1] Save result:', {
      success: !!result,
      id: result?._id,
      phone: result?.phone,
      fullName: result?.fullName
    });

    // Verify the save by querying the database
    const verification = await FormSubmission.findOne({ phone: p });
    if (!verification) {
      console.error('[saveStep1] WARNING: Document not found after save!');
      return res.status(500).json({ success: false, message: 'Data was not saved. Please try again.' });
    }

    console.log('[saveStep1] Verification successful. Document ID:', verification._id);

    await appendToSheetIfConfigured(verification);

    return res.status(200).json({ success: true, message: 'Step 1 data saved successfully.' });
  } catch (error) {
    console.error('[saveStep1] Error:', error);
    console.error('[saveStep1] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      keyPattern: error.keyPattern,
      keyValue: error.keyValue,
      errors: error.errors,
      stack: error.stack
    });
    
    // Handle specific MongoDB errors
    if (error.code === 11000) {
      // Duplicate key error
      return res.status(400).json({ 
        success: false, 
        message: 'A submission with this phone number already exists.' 
      });
    }
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(e => e.message).join(', ');
      return res.status(400).json({ 
        success: false, 
        message: `Validation error: ${validationErrors}` 
      });
    }
    
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.saveStep2 = async (req, res) => {
  try {
    const { phone } = req.body || {};

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    if (!otpStore.isVerified(p)) {
      return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
    }

    const step2Data = {
      otpVerified: true,
      step2CompletedAt: new Date()
    };

    const setPayload = {
      step2Data,
      currentStep: 2,
      applicationStatus: 'in_progress',
      updatedAt: new Date()
    };
    const existing = await FormSubmission.findOne({ phone: p }).lean();
    mergeUtmIfFirstTouch(setPayload, req.body, existing);

    console.log('[saveStep2] Attempting to save:', { phone: p });

    const result = await FormSubmission.findOneAndUpdate(
      { phone: p },
      { $set: setPayload },
      { upsert: false, new: true, runValidators: true }
    );

    if (!result) {
      console.error('[saveStep2] Document not found for phone:', p);
      return res.status(404).json({ success: false, message: 'Step 1 data not found. Please complete Step 1 first.' });
    }

    console.log('[saveStep2] Save successful. Document ID:', result._id);

    await appendToSheetIfConfigured(result);

    return res.status(200).json({ success: true, message: 'Step 2 data saved successfully.' });
  } catch (error) {
    console.error('[saveStep2] Error:', error);
    console.error('[saveStep2] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.saveStep3 = async (req, res) => {
  try {
    const { phone, selectedSlot, slotDate } = req.body || {};

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    if (!selectedSlot || !isValidSlotId(selectedSlot)) {
      return res.status(400).json({ success: false, message: 'selectedSlot must be a valid slot ID (e.g. FRIDAY_7PM, SUNDAY_11AM)' });
    }
    if (!slotDate || isNaN(new Date(slotDate).getTime())) {
      return res.status(400).json({ success: false, message: 'Valid slotDate is required' });
    }

    if (!otpStore.isVerified(p)) {
      return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
    }

    const slotConfig = await SlotConfig.findOne({ slotId: selectedSlot }).lean();
    if (slotConfig && slotConfig.enabled === false) {
      return res.status(400).json({ success: false, message: 'This slot is no longer available. Please choose another.' });
    }

    const slotDateTime = new Date(slotDate);
    const calendarDate = getISTCalendarDateUTC(slotDateTime);
    const istDateStr = calendarDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const utcMidnightSameDay = new Date(istDateStr + 'T00:00:00.000Z');
    const dateOverride = await SlotDateOverride.findOne({
      slotId: selectedSlot,
      $or: [{ date: calendarDate }, { date: utcMidnightSameDay }]
    }).lean();
    if (dateOverride && dateOverride.enabled === false) {
      return res.status(400).json({ success: false, message: 'This slot is not available for this date. Please choose another.' });
    }

    const step3Data = {
      selectedSlot,
      slotDate: new Date(slotDate),
      step3CompletedAt: new Date()
    };

    console.log('[saveStep3] Attempting to save:', { phone: p, selectedSlot, slotDate });

    // Immediate reminder / pre4hr WA: strict deadline-backward — eligible only when now >= slot−offset
    // and now < slot (Case B catch-up after cron missed; Case C never after slot).
    const now = new Date();
    const hoursUntilSlot = (slotDateTime - now) / (1000 * 60 * 60);

    const shouldSendReminderImmediately =
      hoursUntilSlot > 0 && shouldSendCampaignReminderImmediately('pre4hr', slotDateTime, now);
    const shouldSendMeetLinkImmediately =
      hoursUntilSlot > 0 && shouldSendCampaignReminderImmediately('meet', slotDateTime, now);
    const shouldSendReminder30MinImmediately =
      hoursUntilSlot > 0 && shouldSendCampaignReminderImmediately('30min', slotDateTime, now);

    console.log(
      '[saveStep3] Hours until slot:',
      hoursUntilSlot.toFixed(2),
      'pre4hr immediate (>= T−4h & before slot):',
      shouldSendReminderImmediately,
      'meet immediate:',
      shouldSendMeetLinkImmediately,
      '30min immediate:',
      shouldSendReminder30MinImmediately
    );
    if (!shouldSendReminderImmediately) {
      console.log(
        '[saveStep3] pre4hr immediate path skipped (before T−4h or after slot, or already sent):',
        `hoursUntilSlot=${hoursUntilSlot.toFixed(2)}`
      );
    }

    const setPayload = {
      selectedSlot,
      step3Data,
      currentStep: 3,
      applicationStatus: 'registered',
      isRegistered: true,
      registeredAt: new Date(),
      updatedAt: new Date()
    };
    // Slot booked: cancel any pending abandoned-apply OSVI call for this phone.
    Object.assign(setPayload, {
      osviOutboundCallStatus: 'cancelled',
      osviOutboundLastError: 'cancelled_due_to_slot_booking',
      osviOutboundScheduledAt: null,
      osviOutboundCompletedAt: null,
    });
    const existingStep3 = await FormSubmission.findOne({ phone: p }).lean();
    mergeUtmIfFirstTouch(setPayload, req.body, existingStep3);

    const submission = await FormSubmission.findOneAndUpdate(
      { phone: p },
      { $set: setPayload },
      { upsert: false, new: true, runValidators: true }
    );

    if (!submission) {
      console.error('[saveStep3] Document not found for phone:', p);
      return res.status(404).json({ success: false, message: 'Application not found. Please start from Step 1.' });
    }

    console.log('[saveStep3] Save successful. Document ID:', submission._id, 'Registered:', submission.isRegistered);

    await appendToSheetIfConfigured(submission);

    // Send slot confirmation SMS (non-blocking - don't fail the request if SMS fails)
    let smsStatus = { sent: false, error: null };
    let reminderStatus = { sent: false, error: null, immediate: false };
    let meetLinkStatus = { sent: false, error: null, immediate: false };
    let reminder30MinStatus = { sent: false, error: null, immediate: false };
    
    try {
      const smsVariables = buildSlotNotificationVariables(submission);
      
      console.log('[saveStep3] Sending slot confirmation SMS:', { phone: p, variables: smsVariables });
      
      const smsResult = await sendSlotConfirmationSms(p, smsVariables);
      
      if (!smsResult.success) {
        console.warn('[saveStep3] Slot confirmation SMS failed:', smsResult.error);
        smsStatus = { sent: false, error: smsResult.error };
      } else {
        console.log('[saveStep3] Slot confirmation SMS sent successfully');
        smsStatus = { sent: true, error: null };
      }

      // If booking within 4 hours, also send reminder SMS immediately
      if (shouldSendReminderImmediately) {
        console.log('[saveStep3] Slot is within 4 hours - sending reminder SMS immediately');
        
        const reminderResult = await sendReminderSms(p, smsVariables);
        
        if (!reminderResult.success) {
          console.warn('[saveStep3] Immediate reminder SMS failed:', reminderResult.error);
          reminderStatus = { sent: false, error: reminderResult.error, immediate: true };
          // Update reminderSent to false since it failed
          await FormSubmission.updateOne(
            { phone: p },
            { $set: { reminderSent: false, reminderSentAt: null } }
          );
        } else {
          console.log('[saveStep3] Immediate reminder SMS sent successfully');
          reminderStatus = { sent: true, error: null, immediate: true };
        }
      }

      // If booking within 1 hour, also send meet link SMS immediately
      if (shouldSendMeetLinkImmediately) {
        console.log('[saveStep3] Slot is within 1 hour - sending meet link SMS immediately');
        
        const meetLinkVariables = buildSlotNotificationVariables(submission, { withMeetingLink: true });
        
        const meetLinkResult = await sendMeetLinkSms(p, meetLinkVariables);
        
        if (!meetLinkResult.success) {
          console.warn('[saveStep3] Immediate meet link SMS failed:', meetLinkResult.error);
          meetLinkStatus = { sent: false, error: meetLinkResult.error, immediate: true };
          // Update meetLinkSent to false since it failed
          await FormSubmission.updateOne(
            { phone: p },
            { $set: { meetLinkSent: false, meetLinkSentAt: null } }
          );
        } else {
          console.log('[saveStep3] Immediate meet link SMS sent successfully');
          meetLinkStatus = { sent: true, error: null, immediate: true };
        }
      }

      // If booking within 30 minutes, also send 30-min live reminder SMS immediately
      if (shouldSendReminder30MinImmediately) {
        console.log('[saveStep3] Slot is within 30 min - sending 30-min live reminder SMS immediately');
        
        const reminder30MinVariables = buildSlotNotificationVariables(submission, { withMeetingLink: true });
        
        const reminder30MinResult = await sendReminder30MinSms(p, reminder30MinVariables);
        
        if (!reminder30MinResult.success) {
          console.warn('[saveStep3] Immediate 30-min reminder SMS failed:', reminder30MinResult.error);
          reminder30MinStatus = { sent: false, error: reminder30MinResult.error, immediate: true };
          // Update reminder30MinSent to false since it failed
          await FormSubmission.updateOne(
            { phone: p },
            { $set: { reminder30MinSent: false, reminder30MinSentAt: null } }
          );
        } else {
          console.log('[saveStep3] Immediate 30-min reminder SMS sent successfully');
          reminder30MinStatus = { sent: true, error: null, immediate: true };
        }
      }
    } catch (smsError) {
      console.error('[saveStep3] Error sending SMS:', smsError.message);
      smsStatus = { sent: false, error: smsError.message };
    }

    const slotBookedGroup = await WhatsAppRetryGroup.create({
      messageKind: 'slot_booked',
      cronRunId: null,
      trigger: 'save_step3',
      status: 'open'
    });
    await safeSendWhatsApp({
      phone10: p,
      formSubmissionId: submission._id,
      vars: buildSlotNotificationVariables(submission),
      retryKind: 'slot_booked',
      source: 'save_step3',
      cronRunId: null,
      cronJobKey: null,
      sendFn: gupshupService.sendSlotBookedWhatsApp,
      retryGroupId: slotBookedGroup._id,
      attemptNumber: 1
    });

    let reminderJobStatus = { scheduled: [], dispatch: null };
    try {
      const ensureResult = await ensureReminderJobsForSubmission(submission, { now });
      reminderJobStatus.scheduled = ensureResult.jobs || [];
      reminderJobStatus.dispatch = await dispatchDueJobsForSubmission(submission._id, {
        now,
        cronJobKey: 'save_step3_catchup'
      });
    } catch (jobErr) {
      console.error('[saveStep3] reminder job scheduling:', jobErr.message);
      reminderJobStatus.error = jobErr.message;
    }

    otpStore.removeVerified(p);

    return res.status(200).json({
      success: true,
      message: 'Step 3 data saved successfully.',
      data: {
        selectedSlot,
        slotDate: step3Data.slotDate
      },
      smsStatus, // Slot confirmation SMS status
      reminderStatus, // Immediate reminder SMS status (only if slot within 4 hours)
      meetLinkStatus, // Immediate meet link SMS status (only if slot within 1 hour)
      reminder30MinStatus, // Immediate 30-min live reminder SMS status (only if slot within 30 min)
      reminderJobStatus // P3 durable scheduled reminder jobs + catch-up dispatch
    });
  } catch (error) {
    console.error('[saveStep3] Error:', error);
    console.error('[saveStep3] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.checkRegistrationStatus = async (req, res) => {
  try {
    const phone = req.params.phone || req.query.phone;
    
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const submission = await FormSubmission.findOne({ phone: p });

    if (!submission) {
      return res.status(200).json({
        success: true,
        isRegistered: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      isRegistered: submission.isRegistered || false,
      registeredAt: submission.registeredAt,
      slotInfo: submission.step3Data ? {
        selectedSlot: submission.step3Data.selectedSlot,
        slotDate: submission.step3Data.slotDate
      } : null,
      postRegistrationCompleted: !!submission.postRegistrationData?.completedAt,
      applicationStatus: submission.applicationStatus
    });
  } catch (error) {
    console.error('[checkRegistrationStatus] Error:', error);
    console.error('[checkRegistrationStatus] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.savePostRegistrationData = async (req, res) => {
  try {
    const { phone, interestLevel, email } = req.body || {};

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    const interestNum = Number(interestLevel);
    if (!Number.isInteger(interestNum) || interestNum < 1 || interestNum > 5) {
      return res.status(400).json({ success: false, message: 'interestLevel must be a number from 1 to 5' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ success: false, message: 'email is required' });
    }
    
    // Basic email validation
    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address' });
    }

    const submission = await FormSubmission.findOne({ phone: p });

    if (!submission) {
      return res.status(404).json({ success: false, message: 'Registration not found. Please complete slot booking first.' });
    }

    if (!submission.isRegistered) {
      return res.status(400).json({ success: false, message: 'User must be registered first.' });
    }

    const postRegistrationData = {
      interestLevel: interestNum,
      email: email.trim().toLowerCase(),
      completedAt: new Date()
    };

    const setPayload = {
      email: email.trim().toLowerCase(),
      interestLevel: interestNum,
      postRegistrationData,
      currentStep: 4,
      applicationStatus: 'completed',
      updatedAt: new Date()
    };
    mergeUtmIfFirstTouch(setPayload, req.body, submission);

    console.log('[savePostRegistrationData] Attempting to save:', { phone: p, interestLevel: interestNum, email: email.trim().toLowerCase() });

    const result = await FormSubmission.findOneAndUpdate(
      { phone: p },
      { $set: setPayload },
      { new: true, runValidators: true }
    );

    if (!result) {
      console.error('[savePostRegistrationData] Document not found for phone:', p);
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }

    console.log('[savePostRegistrationData] Save successful. Document ID:', result._id);

    await appendToSheetIfConfigured(result);

    return res.status(200).json({
      success: true,
      message: 'Post-registration data saved successfully.'
    });
  } catch (error) {
    console.error('[savePostRegistrationData] Error:', error);
    console.error('[savePostRegistrationData] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.saveIitSection1 = async (req, res) => {
  try {
    const payload = req.body || {};
    const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
    const mobileRaw = payload.mobileNumber ?? payload.phone ?? payload.whatsappNumber;
    const mobileString = typeof mobileRaw === 'string' ? mobileRaw.trim() : String(mobileRaw || '');
    const phone = normalizePhone(mobileString);
    const city = typeof payload.city === 'string' ? payload.city.trim() : '';
    const top5Colleges = normalizeTopColleges(payload.top5Colleges);

    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'fullName is required' });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobileNumber is required' });
    }
    if (!city) {
      return res.status(400).json({ success: false, message: 'city is required' });
    }
    for (const [key, allowed] of [
      ['studentOrParent', IIT_ALLOWED_VALUES.studentOrParent],
      ['classStatus', IIT_ALLOWED_VALUES.classStatus],
      ['stream', IIT_ALLOWED_VALUES.stream],
      ['slotBooking', IIT_ALLOWED_VALUES.slotBooking],
    ]) {
      const err = requireAllowedValue(payload[key], allowed, key);
      if (err) return res.status(400).json({ success: false, message: err });
    }
    if (top5Colleges.length === 0) {
      return res.status(400).json({ success: false, message: 'top5Colleges is required' });
    }

    const slotBookingTrimmed = payload.slotBooking.trim();
    const slotDateNorm = normalizeOptionalSlotBookingDate(payload, slotBookingTrimmed);
    if (!slotDateNorm.ok) {
      return res.status(400).json({ success: false, message: slotDateNorm.message });
    }
    if (!(await isIitSlotBookingEnabled(slotBookingTrimmed, slotDateNorm.value || undefined))) {
      return res.status(400).json({ success: false, message: 'Selected demo slot is not available' });
    }

    const now = new Date();
    const slotUtc =
      slotDateNorm.value ? computeIitCounsellingSlotInstantUtc(slotBookingTrimmed, slotDateNorm.value) : null;

    const section1Data = {
      fullName,
      mobileNumber: phone,
      studentOrParent: payload.studentOrParent.trim(),
      classStatus: payload.classStatus.trim(),
      stream: payload.stream.trim(),
      city,
      slotBooking: slotBookingTrimmed,
      ...(slotDateNorm.value ? { slotBookingDate: slotDateNorm.value } : {}),
      top5Colleges,
      submittedAt: now,
    };

    const submission = await IitCounsellingSubmission.findOneAndUpdate(
      { phone },
      {
        $setOnInsert: {
          createdAt: now,
        },
        $set: {
          submissionType: IIT_SUBMISSION_TYPE,
          fullName,
          phone,
          occupation: payload.studentOrParent.trim(),
          isCompleted: false,
          currentStep: 1,
          applicationStatus: 'in_progress',
          counsellingSlotInstantUtc: slotUtc || null,
          'iitCounselling.currentStep': 1,
          'iitCounselling.isCompleted': false,
          'iitCounselling.section1Data': section1Data,
          'iitCounselling.lastUpdatedAt': now,
          updatedAt: now,
        },
      },
      { upsert: true, new: true, runValidators: true, validateModifiedOnly: true }
    );

    const visitorFingerprint =
      (typeof payload.visitorFingerprint === 'string' && payload.visitorFingerprint.trim()) ||
      null;
    if (visitorFingerprint) {
      await IitCounsellingVisit.findOneAndUpdate(
        { visitorFingerprint, submissionId: null },
        { $set: { submissionId: submission._id, phone } },
        { sort: { visitedAt: -1 } }
      );
    }

    /** @type {{ attempted: boolean, success?: boolean, skippedReason?: string, error?: string, idempotent?: boolean }|null} */
    let whatsappSlotBooked = null;

    if (!slotUtc) {
      whatsappSlotBooked = { attempted: false, skippedReason: 'no_slot_calendar_date' };
      console.info(
        '[saveIitSection1] WhatsApp skipped: no counselling slot instant (send slotBookingDate YYYY-MM-DD with IST weekday matching slotBooking)'
      );
    } else {
      try {
        const slotIdForTpl = IIT_BOOKING_LABEL_TO_SELECTED_SLOT_ID[slotBookingTrimmed];
        const iitTplKey = resolveIitSlotBookedTemplateEnvKey(slotBookingTrimmed);
        console.log(
          JSON.stringify({
            event: 'iit_wa_send_trace',
            stage: 'saveIitSection1_before_safeSendWhatsApp',
            slotBooking: slotBookingTrimmed,
            resolvedIitTemplateEnvKey: iitTplKey,
            explicitTemplateEnvKey: iitTplKey || null,
            willFallBackToReminder: !iitTplKey,
            envWedSet: Boolean(process.env.GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED_WEDNESDAY),
            envSatSet: Boolean(process.env.GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED_SATURDAY),
            envSunSet: Boolean(process.env.GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED_SUNDAY),
            envHeaderImageSet: Boolean(process.env.GUPSHUP_IIT_SLOT_BOOKED_HEADER_IMAGE_URL),
            envReminderSet: Boolean(process.env.GUPSHUP_TEMPLATE_REMINDER)
          })
        );

        if (!iitTplKey) {
          whatsappSlotBooked = {
            attempted: false,
            skippedReason: 'iit_template_env_missing',
            error: 'IIT slot_booked Gupshup template env not configured for this slot',
          };
          console.warn(
            '[saveIitSection1] WhatsApp skipped: IIT template env missing for slot',
            slotBookingTrimmed
          );
        } else {
        const slotBookedGroup = await WhatsAppRetryGroup.create({
          messageKind: 'slot_booked',
          cronRunId: null,
          trigger: 'save_step3',
          status: 'open'
        });
        const waResult = await safeSendWhatsApp({
          phone10: phone,
          formSubmissionId: null,
          vars: buildSlotNotificationVariables({
            fullName,
            step3Data: {
              slotDate: slotUtc,
              selectedSlot: slotIdForTpl
            }
          }),
          retryKind: 'slot_booked',
          source: 'save_step3',
          cronRunId: null,
          cronJobKey: null,
          sendFn: gupshupService.sendSlotBookedWhatsApp,
          retryGroupId: slotBookedGroup._id,
          attemptNumber: 1,
          opsProduct: 'iit_counselling',
          cohortSlotInstantUtc: slotUtc,
          iitCounsellingSubmissionId: submission._id,
          ...(iitTplKey ? { explicitTemplateEnvKey: iitTplKey } : {}),
        });

        if (waResult && waResult.success) {
          whatsappSlotBooked = {
            attempted: true,
            success: true,
            ...(waResult.idempotent ? { idempotent: true } : {}),
          };
        } else {
          const errText = (waResult && waResult.error) ? String(waResult.error).slice(0, 240) : 'send_failed';
          const skippedReason = waResult?.duplicateInFlight
            ? 'duplicate_in_flight'
            : waResult?.skippedOutsideWindow
              ? 'outside_reminder_window'
              : undefined;
          whatsappSlotBooked = {
            attempted: true,
            success: false,
            error: errText,
            ...(skippedReason ? { skippedReason } : {}),
          };
          console.warn('[saveIitSection1] WhatsApp slot_booked unsuccessful:', errText);
        }
        }
      } catch (waErr) {
        const msg = String(waErr?.message || waErr || 'exception').slice(0, 240);
        whatsappSlotBooked = { attempted: true, success: false, error: msg };
        console.error('[saveIitSection1] WhatsApp slot_booked dispatch error:', msg);
      }
    }

    if (slotUtc) {
      try {
        const { createPendingReminder } = require('../services/aiCallReminderService');
        createPendingReminder(submission.toObject ? submission.toObject() : submission).catch((aiErr) => {
          console.error('[saveIitSection1] AI call reminder create failed:', aiErr?.message || aiErr);
        });
      } catch (aiHookErr) {
        console.error('[saveIitSection1] AI call reminder hook error:', aiHookErr?.message || aiHookErr);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Section 1 saved successfully.',
      data: {
        submissionId: submission._id.toString(),
        currentStep: 1,
        whatsappSlotBooked,
      },
    });
  } catch (error) {
    console.error('[saveIitSection1] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.trackIitCounsellingVisit = async (req, res) => {
  try {
    const body = req.body || {};
    const userAgent = String(req.headers['user-agent'] || '').trim().slice(0, 1000);
    const referrer = String(body.referrer || req.get('referer') || '').trim().slice(0, 1000);
    const path = String(body.path || req.originalUrl || '/iit-counselling').trim().slice(0, 500);
    const query = String(body.query || '').trim().slice(0, 1000);
    const ip = getClientIp(req);
    const dayKey = dayKeyFromDate();
    const visitorFingerprint = buildVisitorFingerprint({ ip, userAgent, dayKey });

    const pageKeyRaw = typeof body.pageKey === 'string' ? body.pageKey.trim() : '';
    let pageKey = 'iitCounselling';
    if (pageKeyRaw === 'oneOnOneSession') pageKey = 'oneOnOneSession';
    else if (pageKeyRaw === 'guidanceBookingConfirmation') pageKey = 'guidanceBookingConfirmation';

    const doc = await IitCounsellingVisit.create({
      pageKey,
      visitedAt: new Date(),
      visitorFingerprint,
      ip,
      userAgent,
      referrer,
      path,
      query,
      utm_source: typeof body.utm_source === 'string' ? body.utm_source.trim().slice(0, 200) : undefined,
      utm_medium: typeof body.utm_medium === 'string' ? body.utm_medium.trim().slice(0, 200) : undefined,
      utm_campaign: typeof body.utm_campaign === 'string' ? body.utm_campaign.trim().slice(0, 200) : undefined,
      utm_content: typeof body.utm_content === 'string' ? body.utm_content.trim().slice(0, 200) : undefined,
    });

    return res.status(200).json({
      success: true,
      message: 'Visit tracked',
      data: {
        visitId: doc._id.toString(),
        visitorFingerprint,
        visitedAt: doc.visitedAt,
      },
    });
  } catch (error) {
    console.error('[trackIitCounsellingVisit] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

function buildIitReminderScheduleWarnings(scheduleResult) {
  const warnings = [];
  if (!scheduleResult) return warnings;

  if (scheduleResult.error) {
    warnings.push({
      code: scheduleResult.error,
      message:
        scheduleResult.detail ||
        `Reminder scheduling failed (${scheduleResult.error})`,
      messageKind: scheduleResult.messageKind || null,
    });
  }

  const jobs = scheduleResult.jobs || [];
  const missingTemplate = jobs.filter((j) => j.state === 'skipped' && !j.templateIdEnvKey);
  if (missingTemplate.length) {
    warnings.push({
      code: 'iit_template_env_missing',
      message: `Gupshup template env missing for: ${missingTemplate.map((j) => j.messageKind).join(', ')}`,
      messageKinds: missingTemplate.map((j) => j.messageKind),
    });
  }

  const pendingCount = jobs.filter((j) => j.state === 'pending').length;
  if (!scheduleResult.error && jobs.length > 0 && pendingCount === 0) {
    warnings.push({
      code: 'no_pending_reminder_jobs',
      message:
        'All IIT reminder jobs were skipped; WhatsApp reminders will not be sent for this submission.',
    });
  }

  return warnings;
}

function buildIitTeluguSmsScheduleWarnings(scheduleResult) {
  const warnings = [];
  if (!scheduleResult) return warnings;

  if (scheduleResult.error) {
    warnings.push({
      code: scheduleResult.error,
      message:
        scheduleResult.detail ||
        `Telugu SMS scheduling failed (${scheduleResult.error})`,
      messageKind: scheduleResult.messageKind || null,
    });
  }

  if (scheduleResult.skipped && scheduleResult.reason === 'language_not_telugu') {
    return warnings;
  }

  const jobs = scheduleResult.jobs || [];
  const missingTemplate = jobs.filter(
    (j) => j.state === 'skipped' && j.msg91TemplateId === 'missing'
  );
  if (missingTemplate.length) {
    warnings.push({
      code: 'telugu_sms_template_missing',
      message: `MSG91 template id missing for: ${missingTemplate.map((j) => j.messageKind).join(', ')}`,
      messageKinds: missingTemplate.map((j) => j.messageKind),
    });
  }

  const missed = jobs.filter((j) => j.state === 'skipped');
  if (missed.length && !scheduleResult.error) {
    warnings.push({
      code: 'telugu_sms_jobs_skipped',
      message: `${missed.length} Telugu SMS trigger(s) skipped (missed window or slot passed).`,
      messageKinds: missed.map((j) => j.messageKind),
    });
  }

  return warnings;
}

exports.saveIitSection2 = async (req, res) => {
  try {
    const payload = req.body || {};
    const submissionId = typeof payload.submissionId === 'string' ? payload.submissionId.trim() : '';
    if (!submissionId || !mongoose.Types.ObjectId.isValid(submissionId)) {
      return res.status(400).json({ success: false, message: 'Valid submissionId is required' });
    }

    for (const [key, allowed] of [
      ['careerDecisionClarity', IIT_ALLOWED_VALUES.careerDecisionClarity],
      ['collegeDecisionStakeholder', IIT_ALLOWED_VALUES.collegeDecisionStakeholder],
      ['expectedBudget', IIT_ALLOWED_VALUES.expectedBudget],
      ['topCollegePriority', IIT_ALLOWED_VALUES.topCollegePriority],
      ['preferredLanguage', IIT_ALLOWED_VALUES.preferredLanguage],
    ]) {
      const err = requireAllowedValue(payload[key], allowed, key);
      if (err) return res.status(400).json({ success: false, message: err });
    }

    const now = new Date();
    const section2Data = {
      careerDecisionClarity: payload.careerDecisionClarity.trim(),
      collegeDecisionStakeholder: payload.collegeDecisionStakeholder.trim(),
      expectedBudget: payload.expectedBudget.trim(),
      topCollegePriority: payload.topCollegePriority.trim(),
      preferredLanguage: payload.preferredLanguage.trim(),
      submittedAt: now,
    };

    const updated = await IitCounsellingSubmission.findOneAndUpdate(
      { _id: submissionId, submissionType: IIT_SUBMISSION_TYPE },
      {
        $set: {
          'iitCounselling.section2Data': section2Data,
          'iitCounselling.currentStep': 2,
          'iitCounselling.lastUpdatedAt': now,
          currentStep: 2,
          isCompleted: false,
          applicationStatus: 'in_progress',
          updatedAt: now,
        },
      },
      { new: true, runValidators: true, validateModifiedOnly: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'IIT counselling submission not found' });
    }

    let scheduleResult = { jobs: [] };
    let reminderScheduleWarnings = [];
    let reminderDispatch = null;
    try {
      const {
        ensureIitReminderJobsForSubmission,
        dispatchDueJobsForIitSubmission,
      } = require('../services/iitReminderScheduler');
      scheduleResult = await ensureIitReminderJobsForSubmission(updated);
      reminderScheduleWarnings = buildIitReminderScheduleWarnings(scheduleResult);
      if (scheduleResult.error) {
        console.warn(
          '[saveIitSection2] IIT reminder scheduling:',
          scheduleResult.error,
          scheduleResult.detail || ''
        );
      } else if (reminderScheduleWarnings.length) {
        console.warn('[saveIitSection2] IIT reminder scheduling warnings:', reminderScheduleWarnings);
      }

      try {
        reminderDispatch = await dispatchDueJobsForIitSubmission(updated._id, {
          now: new Date(),
          cronJobKey: 'save_iit_section2_catchup',
        });
      } catch (dispatchErr) {
        console.warn('[saveIitSection2] IIT reminder dispatch:', dispatchErr.message);
        reminderScheduleWarnings.push({
          code: 'reminder_dispatch_failed',
          message: dispatchErr.message || 'Reminder dispatch failed',
        });
      }
    } catch (scheduleErr) {
      console.error('[saveIitSection2] IIT reminder scheduling failed:', scheduleErr);
      reminderScheduleWarnings.push({
        code: 'reminder_schedule_failed',
        message: scheduleErr.message || 'Reminder scheduling failed',
      });
    }

    let teluguSmsScheduleResult = { jobs: [] };
    let teluguSmsScheduleWarnings = [];
    let teluguSmsDispatch = null;
    if (section2Data.preferredLanguage === 'Telugu') {
      try {
        const {
          ensureIitTeluguSmsJobsForSubmission,
          dispatchDueJobsForIitTeluguSmsSubmission,
        } = require('../services/iitTeluguSmsReminderScheduler');
        teluguSmsScheduleResult = await ensureIitTeluguSmsJobsForSubmission(updated);
        teluguSmsScheduleWarnings = buildIitTeluguSmsScheduleWarnings(teluguSmsScheduleResult);
        if (teluguSmsScheduleResult.error) {
          console.warn(
            '[saveIitSection2] IIT Telugu SMS scheduling:',
            teluguSmsScheduleResult.error,
            teluguSmsScheduleResult.detail || ''
          );
        } else if (teluguSmsScheduleWarnings.length) {
          console.warn('[saveIitSection2] IIT Telugu SMS warnings:', teluguSmsScheduleWarnings);
        }
        try {
          teluguSmsDispatch = await dispatchDueJobsForIitTeluguSmsSubmission(updated._id, {
            now: new Date(),
            cronJobKey: 'save_iit_section2_sms_catchup',
          });
        } catch (smsDispatchErr) {
          console.warn('[saveIitSection2] IIT Telugu SMS dispatch:', smsDispatchErr.message);
          teluguSmsScheduleWarnings.push({
            code: 'telugu_sms_dispatch_failed',
            message: smsDispatchErr.message || 'Telugu SMS dispatch failed',
          });
        }
      } catch (smsScheduleErr) {
        console.error('[saveIitSection2] IIT Telugu SMS scheduling failed:', smsScheduleErr);
        teluguSmsScheduleWarnings.push({
          code: 'telugu_sms_schedule_failed',
          message: smsScheduleErr.message || 'Telugu SMS scheduling failed',
        });
      }
    } else {
      try {
        const { cancelPendingTeluguSmsJobsForSubmission } = require('../services/iitTeluguSmsReminderScheduler');
        await cancelPendingTeluguSmsJobsForSubmission(updated._id, 'language_not_telugu', new Date());
      } catch (cancelErr) {
        console.warn('[saveIitSection2] cancel Telugu SMS jobs:', cancelErr.message);
      }
    }

    try {
      const { enrichReminderFromSubmission } = require('../services/aiCallReminderService');
      enrichReminderFromSubmission(updated.toObject ? updated.toObject() : updated).catch((aiErr) => {
        console.warn('[saveIitSection2] AI call reminder enrich failed:', aiErr?.message || aiErr);
      });
    } catch (aiHookErr) {
      console.warn('[saveIitSection2] AI call reminder enrich hook error:', aiHookErr?.message || aiHookErr);
    }

    return res.status(200).json({
      success: true,
      message: 'Section 2 saved successfully.',
      data: {
        submissionId: updated._id.toString(),
        currentStep: 2,
        reminderJobs: scheduleResult.jobs || [],
        ...(reminderDispatch ? { reminderDispatch } : {}),
        ...(reminderScheduleWarnings.length ? { reminderScheduleWarnings } : {}),
        teluguSmsJobs: teluguSmsScheduleResult.jobs || [],
        ...(teluguSmsDispatch ? { teluguSmsDispatch } : {}),
        ...(teluguSmsScheduleWarnings.length ? { teluguSmsScheduleWarnings } : {}),
      },
    });
  } catch (error) {
    console.error('[saveIitSection2] Error:', error);
    if (error?.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: error.message || 'Validation failed.',
      });
    }
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.saveIitSection3 = async (req, res) => {
  try {
    const payload = req.body || {};
    const submissionId = typeof payload.submissionId === 'string' ? payload.submissionId.trim() : '';
    if (!submissionId || !mongoose.Types.ObjectId.isValid(submissionId)) {
      return res.status(400).json({ success: false, message: 'Valid submissionId is required' });
    }

    for (const [key, allowed] of [
      ['helpNeeded', IIT_ALLOWED_VALUES.helpNeeded],
      ['wantsOneToOneSession', IIT_ALLOWED_VALUES.wantsOneToOneSession],
      ['biggestConfusion', IIT_ALLOWED_VALUES.biggestConfusion],
    ]) {
      const err = requireAllowedValue(payload[key], allowed, key);
      if (err) return res.status(400).json({ success: false, message: err });
    }

    const now = new Date();
    const section3Data = {
      helpNeeded: payload.helpNeeded.trim(),
      wantsOneToOneSession: payload.wantsOneToOneSession.trim(),
      biggestConfusion: payload.biggestConfusion.trim(),
      submittedAt: now,
    };

    const updated = await IitCounsellingSubmission.findOneAndUpdate(
      { _id: submissionId, submissionType: IIT_SUBMISSION_TYPE },
      {
        $set: {
          'iitCounselling.section3Data': section3Data,
          'iitCounselling.currentStep': 3,
          'iitCounselling.isCompleted': true,
          'iitCounselling.lastUpdatedAt': now,
          currentStep: 3,
          isCompleted: true,
          applicationStatus: 'completed',
          updatedAt: now,
        },
      },
      { new: true, runValidators: true, validateModifiedOnly: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'IIT counselling submission not found' });
    }

    try {
      const { enrichReminderFromSubmission } = require('../services/aiCallReminderService');
      enrichReminderFromSubmission(updated.toObject ? updated.toObject() : updated).catch((aiErr) => {
        console.warn('[saveIitSection3] AI call reminder enrich failed:', aiErr?.message || aiErr);
      });
    } catch (aiHookErr) {
      console.warn('[saveIitSection3] AI call reminder enrich hook error:', aiHookErr?.message || aiHookErr);
    }

    return res.status(200).json({
      success: true,
      message: 'Section 3 saved successfully.',
      data: { submissionId: updated._id.toString(), currentStep: 3, isCompleted: true },
    });
  } catch (error) {
    console.error('[saveIitSection3] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/** Parse rank API range strings like "1 - 5", "150000+", "1" into numeric bounds for admin. */
function parseRankRangeBoundsFromString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.replace(/,/g, '').trim();
  const plus = /^(\d+)\+$/.exec(s);
  if (plus) {
    const n = Number(plus[1]);
    return Number.isFinite(n) ? { low: n, high: n } : null;
  }
  const dash = /(\d+)\s*[-–]\s*(\d+)/.exec(s);
  if (dash) {
    const low = Number(dash[1]);
    const high = Number(dash[2]);
    return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : null;
  }
  const single = /^(\d+)$/.exec(s);
  if (single) {
    const n = Number(single[1]);
    return Number.isFinite(n) ? { low: n, high: n } : null;
  }
  return null;
}

/**
 * POST body: { phone, examId, predictedValue?, range?: { low, high } | string, metricLabel?, message? }
 * Merges prediction output into rankPredictorLead for organic student rank predictor leads only.
 */
exports.saveRankPredictorPrediction = async (req, res) => {
  try {
    const phoneRaw = req.body?.phone || req.body?.whatsappNumber;
    const { examId, predictedValue, range, metricLabel, message } = req.body || {};
    if (!phoneRaw || typeof phoneRaw !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phoneRaw);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    const examIdStr = typeof examId === 'string' ? examId.trim() : '';
    const allowedIds = new Set(listExams().map((e) => e.id));
    if (!examIdStr || !allowedIds.has(examIdStr)) {
      return res.status(400).json({ success: false, message: 'Invalid examId' });
    }

    const sub = await FormSubmission.findOne({ phone: p }).lean();
    if (!sub) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }

    const utm = sub.utm_content || '';
    const occ = sub.occupation || '';
    const isOrganicRank =
      utm === 'organic_rank_predictor' ||
      (typeof occ === 'string' && occ.includes('Rank predictor'));
    const isStudentWorkspace =
      utm === 'student_workspace_login' ||
      (typeof occ === 'string' && occ.includes('GuideXpert tools'));
    if (!isOrganicRank && !isStudentWorkspace) {
      return res.status(403).json({ success: false, message: 'Not a rank predictor or student workspace lead' });
    }

    const existing =
      sub.rankPredictorLead && typeof sub.rankPredictorLead === 'object' ? { ...sub.rankPredictorLead } : {};
    if (existing.examId && String(existing.examId) !== examIdStr) {
      return res.status(400).json({ success: false, message: 'examId does not match stored lead' });
    }

    const next = {
      ...existing,
      examId: examIdStr,
      predictedAt: new Date(),
    };

    if (predictedValue !== undefined && predictedValue !== null) {
      if (typeof predictedValue === 'string') {
        next.predictedValue = predictedValue.trim().slice(0, 200);
      } else if (typeof predictedValue === 'number' && Number.isFinite(predictedValue)) {
        next.predictedValue = predictedValue;
      } else {
        next.predictedValue = String(predictedValue).slice(0, 200);
      }
    }
    if (range && typeof range === 'object' && !Array.isArray(range)) {
      const low = Number(range.low);
      const high = Number(range.high);
      if (Number.isFinite(low)) next.rangeLow = low;
      if (Number.isFinite(high)) next.rangeHigh = high;
    } else if (typeof range === 'string' && range.trim()) {
      const parsed = parseRankRangeBoundsFromString(range.trim());
      if (parsed) {
        next.rangeLow = parsed.low;
        next.rangeHigh = parsed.high;
      }
    }
    if (typeof metricLabel === 'string' && metricLabel.trim()) {
      next.metricLabel = metricLabel.trim().slice(0, 120);
    }
    if (typeof message === 'string' && message.trim()) {
      next.predictionMessage = message.trim().slice(0, 500);
    }

    await FormSubmission.updateOne(
      { phone: p },
      { $set: { rankPredictorLead: next, updatedAt: new Date() } }
    );

    recordStudentLiveActivity({
      fullName: sub.fullName,
      activity: {
        type: 'rank_predictor',
        tool: 'Rank Predictor',
        title: 'Used Rank Predictor',
        examId: examIdStr,
      },
    }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Prediction saved' });
  } catch (err) {
    console.error('[saveRankPredictorPrediction]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * Append student workspace tool activity for admin lead tracking.
 * Body: { phone, activity: { type, tool, title, summary?, examId?, payload? }, studentProfile? }
 */
exports.saveStudentActivity = async (req, res) => {
  try {
    const phone = req.body?.phone || req.body?.whatsappNumber;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }

    const activity = parseStudentActivityFromBody(req.body);
    if (!activity) {
      return res.status(400).json({ success: false, message: 'activity type and title are required' });
    }

    const sub = await FormSubmission.findOne({ phone: p });
    if (!sub) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found. Complete signup / OTP first.',
      });
    }

    const update = {
      $push: {
        studentActivityHistory: {
          $each: [activity],
          $position: 0,
          $slice: 100,
        },
      },
      $set: { updatedAt: new Date() },
    };

    const studentProfile = parseStudentProfileFromBody(req.body);
    if (studentProfile) {
      update.$set.studentProfile = {
        ...(sub.studentProfile && typeof sub.studentProfile === 'object'
          ? {
              age: sub.studentProfile.age,
              currentlyStudying: sub.studentProfile.currentlyStudying,
              city: sub.studentProfile.city,
            }
          : {}),
        ...studentProfile,
      };
    }

    await FormSubmission.updateOne({ phone: p }, update);

    // Public hero live toast (name + tool only — no results)
    recordStudentLiveActivity({
      fullName: sub.fullName,
      activity,
    }).catch(() => {});

    return res.status(200).json({ success: true, message: 'Activity saved' });
  } catch (err) {
    console.error('[saveStudentActivity]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.getAllSubmissions = async (req, res) => {
  try {
    const submissions = await FormSubmission.find({}).sort({ createdAt: -1 }).limit(100);
    const count = await FormSubmission.countDocuments({});
    
    console.log(`[getAllSubmissions] Found ${count} total submissions, returning ${submissions.length}`);
    console.log(`[getAllSubmissions] Collection name: ${FormSubmission.collection.name}`);
    console.log(`[getAllSubmissions] Database name: ${FormSubmission.db.databaseName}`);
    
    return res.status(200).json({
      success: true,
      count,
      collection: FormSubmission.collection.name,
      database: FormSubmission.db.databaseName,
      data: submissions.map(sub => ({
        id: sub._id,
        phone: sub.phone,
        fullName: sub.fullName,
        occupation: sub.occupation,
        currentStep: sub.currentStep,
        applicationStatus: sub.applicationStatus,
        isRegistered: sub.isRegistered,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt
      }))
    });
  } catch (error) {
    console.error('[getAllSubmissions] Error:', error);
    console.error('[getAllSubmissions] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.submitApplication = async (req, res) => {
  try {
    const { fullName, occupation, demoInterest, selectedSlot } = req.body || {};
    const phone = req.body?.phone || req.body?.whatsappNumber;

    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'fullName is required' });
    }
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    if (!occupation || typeof occupation !== 'string' || !occupation.trim()) {
      return res.status(400).json({ success: false, message: 'occupation is required' });
    }
    if (!demoInterest || !['YES_SOON', 'MAYBE_LATER'].includes(demoInterest)) {
      return res.status(400).json({ success: false, message: 'demoInterest must be YES_SOON or MAYBE_LATER' });
    }
    if (demoInterest === 'YES_SOON' && !isValidSlotId(selectedSlot)) {
      return res.status(400).json({ success: false, message: 'selectedSlot is required and must be a valid slot ID when demoInterest is YES_SOON' });
    }

    if (!otpStore.isVerified(p)) {
      return res.status(400).json({ success: false, message: 'Phone number must be verified first.' });
    }

    const doc = {
      fullName: fullName.trim(),
      phone: p,
      occupation: occupation.trim(),
      demoInterest
    };
    if (demoInterest === 'YES_SOON') doc.selectedSlot = selectedSlot;
    const utm = getUtmFromBody(req.body);
    if (utm) Object.assign(doc, utm);

    const created = await FormSubmission.create(doc);
    otpStore.removeVerified(p);

    await appendToSheetIfConfigured(created);

    return res.status(201).json({ success: true, message: 'Application submitted successfully.' });
  } catch (error) {
    console.error('[submitApplication] Error:', error);
    console.error('[submitApplication] Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.updateApplication = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, occupation, demoInterest, selectedSlot } = req.body || {};
    const phone = req.body?.phone || req.body?.whatsappNumber;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Application ID is required' });
    }

    // Find the document
    const submission = await FormSubmission.findById(id);
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    // Validate input
    if (fullName !== undefined) {
      if (typeof fullName !== 'string' || fullName.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'fullName must be at least 2 characters' });
      }
      submission.fullName = fullName.trim();
    }

    if (phone !== undefined) {
      const p = normalizePhone(phone);
      if (!/^\d{10}$/.test(p)) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
      }
      submission.phone = p;
    }

    if (occupation !== undefined) {
      if (typeof occupation !== 'string' || !occupation.trim()) {
        return res.status(400).json({ success: false, message: 'occupation is required' });
      }
      submission.occupation = occupation.trim();
    }

    if (demoInterest !== undefined) {
      if (!['YES_SOON', 'MAYBE_LATER'].includes(demoInterest)) {
        return res.status(400).json({ success: false, message: 'demoInterest must be YES_SOON or MAYBE_LATER' });
      }
      submission.demoInterest = demoInterest;
    }

    if (selectedSlot !== undefined) {
      if (submission.demoInterest === 'YES_SOON' && !isValidSlotId(selectedSlot)) {
        return res.status(400).json({ success: false, message: 'selectedSlot must be a valid slot ID when demoInterest is YES_SOON' });
      }
      submission.selectedSlot = selectedSlot;
    }

    // Update MongoDB document
    await submission.save();

    // After DB update succeeds, sync to Google Sheets
    if (submission.sheetRow) {
      try {
        const success = await updateRow(submission.sheetRow, submission);
        if (success) {
          console.log(`[FormController] Updated Google Sheets row ${submission.sheetRow} for submission ${submission._id}`);
        } else {
          console.error(`[FormController] Failed to update Google Sheets row ${submission.sheetRow} for submission ${submission._id}`);
        }
      } catch (sheetError) {
        // Log error but don't fail the API response
        console.error(`[FormController] Google Sheets sync error for submission ${submission._id}:`, sheetError.message);
      }
    } else {
      console.error(`[FormController] Cannot update Google Sheets for submission ${submission._id}: sheetRow is missing`);
    }

    return res.status(200).json({ success: true, message: 'Application updated successfully.', data: submission });
  } catch (error) {
    console.error('[FormController] Update error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.deleteApplication = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Application ID is required' });
    }

    // Find the document and get sheetRow before deletion
    const submission = await FormSubmission.findById(id);
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    const sheetRow = submission.sheetRow;

    // Delete from MongoDB
    await FormSubmission.findByIdAndDelete(id);

    // After DB delete succeeds, mark row as DELETED in Google Sheets
    if (sheetRow) {
      try {
        const success = await markRowDeleted(sheetRow);
        if (success) {
          console.log(`[FormController] Marked Google Sheets row ${sheetRow} as DELETED for submission ${id}`);
        } else {
          console.error(`[FormController] Failed to mark Google Sheets row ${sheetRow} as DELETED for submission ${id}`);
        }
      } catch (sheetError) {
        // Log error but don't fail the API response
        console.error(`[FormController] Google Sheets sync error for submission ${id}:`, sheetError.message);
      }
    } else {
      console.warn(`[FormController] Cannot mark Google Sheets row as DELETED for submission ${id}: sheetRow was missing`);
    }

    return res.status(200).json({ success: true, message: 'Application deleted successfully.' });
  } catch (error) {
    console.error('[FormController] Delete error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.getMsg91DiagnosticsController = async (req, res) => {
  try {
    const key = req.query.key || req.headers['x-diag-key'];
    if (key !== 'gx-diag-otp' && key !== process.env.OTP_SECRET && process.env.NODE_ENV === 'production' && req.query.secret !== process.env.OTP_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const phoneFilter = req.query.phone || '';
    const diag = await getMsg91Diagnostics(phoneFilter);
    return res.status(200).json({ success: true, diagnostics: diag });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.testOtpFlowController = async (req, res) => {
  try {
    const key = req.query.key || req.body?.key;
    if (key !== 'gx-diag-otp' && key !== process.env.OTP_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { phone, otp, mode } = req.body || {};
    const testOtp = otp || '123456';
    const testPhone = phone || '9347763131';

    let result;
    if (mode === 'flow') {
      result = await sendOtpViaFlow(testPhone, testOtp);
    } else if (mode === 'direct') {
      result = await sendOtpDirect(testPhone, testOtp);
    } else {
      result = await sendOtpSms(testPhone, testOtp);
    }

    return res.status(200).json({ success: true, mode: mode || 'otp', result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

