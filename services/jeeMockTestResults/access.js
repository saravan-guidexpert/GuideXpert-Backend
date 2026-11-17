'use strict';

const { generateOTP, hashOTP, verifyOTP } = require('../../utils/otpUtil');
const otpRepository = require('../../utils/otpRepository');
const msg91 = require('../../utils/msg91Service');
const {
  isPrivilegedPhone,
  getPrivilegedOtp,
  shouldSkipSmsForPrivileged,
} = require('../../utils/privilegedAccess');
const JeeMainMockTestLead = require('../../models/JeeMainMockTestLead');
const JeeMockTestResult = require('../../models/JeeMockTestResult');
const JeeMockTestResultSession = require('../../models/JeeMockTestResultSession');
const { normalizeMobile } = require('./parseSheet');
const { toPublicResult, ELIGIBILITY } = require('./eligibility');
const { ensureJeeMockTestResultsImported } = require('./importResults');
const {
  SESSION_MS,
  signPending,
  tokenHash,
  newSessionToken,
} = require('./cookies');

const OTP_EXPIRY_MS = () => {
  const minutes = Number(process.env.OTP_EXPIRY_MINUTES);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 5 ? minutes : 10;
  return safeMinutes * 60 * 1000;
};
const MAX_VERIFY_ATTEMPTS = 3;

let sendSms = (phone, otp) => msg91.sendOtp(phone, otp);

function setJeeResultOtpSenderForTests(fn) {
  sendSms = typeof fn === 'function' ? fn : ((phone, otp) => msg91.sendOtp(phone, otp));
}

function maskMobile(mobile) {
  return `******${String(mobile).slice(-4)}`;
}

function noScores(body) {
  return body;
}

async function loadRecords(mobile) {
  await ensureJeeMockTestResultsImported();
  const [lead, result] = await Promise.all([
    JeeMainMockTestLead.findOne({ mobileNumber: mobile }).lean(),
    JeeMockTestResult.findOne({ mobile }).lean(),
  ]);
  return { lead, result, pub: toPublicResult(lead, result) };
}

async function requestOtp(rawMobile) {
  const mobile = normalizeMobile(rawMobile);
  if (!mobile) {
    return {
      status: 400,
      body: { success: false, code: 'INVALID_MOBILE', message: 'Enter a valid 10-digit mobile number.' },
    };
  }

  const lead = await JeeMainMockTestLead.findOne({ mobileNumber: mobile }).select('_id').lean();
  if (!lead) {
    return {
      status: 404,
      body: {
        success: false,
        code: 'NOT_REGISTERED',
        message: 'We could not find a JEE Main Mock Test registration for this mobile number.',
      },
    };
  }

  const canSend = await otpRepository.canSend(mobile);
  if (!canSend.allowed) {
    return {
      status: 429,
      body: {
        success: false,
        code: 'OTP_RATE_LIMIT',
        message: canSend.message || 'Please wait before requesting another OTP.',
        resendAfterSeconds: canSend.retryAfter || 60,
      },
    };
  }

  const privileged = isPrivilegedPhone(mobile);
  const otp = privileged ? getPrivilegedOtp() : generateOTP();
  const skipSms = shouldSkipSmsForPrivileged(mobile);
  if (!skipSms) {
    const sent = await sendSms(mobile, otp);
    if (!sent || sent.success === false) {
      return {
        status: 502,
        body: { success: false, code: 'OTP_SEND_FAILED', message: 'Unable to send OTP. Please try again.' },
      };
    }
  }

  await otpRepository.saveOtp(mobile, hashOTP(otp), Date.now() + OTP_EXPIRY_MS());
  const pending = signPending(mobile);
  return {
    status: 200,
    pendingToken: pending.token,
    body: {
      success: true,
      maskedMobile: maskMobile(mobile),
      resendAfterSeconds: 60,
    },
  };
}

async function pendingStatus(mobile) {
  if (!mobile) {
    return { status: 401, body: { success: false, code: 'PENDING_REQUIRED', message: 'Enter your mobile number to continue.' } };
  }
  const latest = await otpRepository.getLatest(mobile);
  const expiresAt = latest && latest.expiresAt ? new Date(latest.expiresAt) : null;
  const otpExpired = !expiresAt || expiresAt.getTime() <= Date.now();
  const canSend = await otpRepository.canSend(mobile);
  return {
    status: 200,
    body: {
      success: true,
      maskedMobile: maskMobile(mobile),
      resendAfterSeconds: canSend.allowed ? 0 : (canSend.retryAfter || 60),
      otpExpiresAt: expiresAt ? expiresAt.toISOString() : null,
      otpExpired,
    },
  };
}

async function verifyOtp(mobile, rawOtp) {
  if (!mobile) {
    return {
      status: 401,
      body: { success: false, code: 'PENDING_REQUIRED', message: 'Request a new OTP to continue.' },
    };
  }
  const otp = rawOtp == null ? '' : String(rawOtp).trim();
  if (!/^\d{6}$/.test(otp)) {
    return { status: 400, body: { success: false, code: 'OTP_INVALID', message: 'Enter the 6-digit code.' } };
  }

  const record = await otpRepository.getLatest(mobile);
  const recordUsable = record && new Date(record.expiresAt).getTime() > Date.now();
  if (!recordUsable) {
    const provider = await msg91.verifySentOtp(mobile, otp);
    if (provider === 'valid') {
      return finishVerified(mobile);
    }
    return {
      status: 400,
      body: {
        success: false,
        code: 'OTP_EXPIRED',
        message: 'This code has expired. Request a new one.',
        resendAfterSeconds: 0,
      },
    };
  }
  if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    await otpRepository.deleteOtp(mobile);
    return {
      status: 400,
      body: { success: false, code: 'OTP_LOCKED', message: 'Too many attempts. Request a new code.' },
    };
  }
  if (!verifyOTP(otp, record.otpHash)) {
    const updated = await otpRepository.incrementAttempts(mobile);
    if (updated && updated.attempts >= MAX_VERIFY_ATTEMPTS) {
      await otpRepository.deleteOtp(mobile);
      return {
        status: 400,
        body: { success: false, code: 'OTP_LOCKED', message: 'Too many attempts. Request a new code.' },
      };
    }
    return {
      status: 400,
      body: { success: false, code: 'OTP_INVALID', message: 'That code is incorrect. Check the SMS and try again.' },
    };
  }

  return finishVerified(mobile);
}

async function finishVerified(mobile) {
  const { pub } = await loadRecords(mobile);
  if (pub.eligibility === ELIGIBILITY.FORM_INCOMPLETE) {
    await otpRepository.deleteOtp(mobile);
    return {
      status: 200,
      clearPending: true,
      body: noScores({
        success: true,
        eligible: false,
        eligibility: ELIGIBILITY.FORM_INCOMPLETE,
        message: 'Your JEE Main Mock Test registration is not complete, so result access is not available. Finish the registration form first.',
      }),
    };
  }

  const sessionToken = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await JeeMockTestResultSession.updateMany(
    { mobile, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  await JeeMockTestResultSession.create({
    tokenHash: tokenHash(sessionToken),
    mobile,
    expiresAt,
  });
  await otpRepository.deleteOtp(mobile);

  return {
    status: 200,
    clearPending: true,
    sessionToken,
    body: { success: true, eligible: true },
  };
}

async function readSession(token) {
  if (!token) {
    return { ok: false, status: 401, body: { success: false, code: 'SESSION_REQUIRED', message: 'Verify your mobile number to view this result.' } };
  }
  const session = await JeeMockTestResultSession.findOne({ tokenHash: tokenHash(token) }).lean();
  if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
    return { ok: false, status: 401, body: { success: false, code: 'SESSION_EXPIRED', message: 'Your result session has expired. Verify your mobile number again.' } };
  }
  return { ok: true, mobile: session.mobile };
}

async function currentResult(token) {
  const session = await readSession(token);
  if (!session.ok) return session;
  const { pub } = await loadRecords(session.mobile);
  if (pub.eligibility === ELIGIBILITY.FORM_INCOMPLETE) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        code: 'FORM_INCOMPLETE',
        eligibility: ELIGIBILITY.FORM_INCOMPLETE,
        message: 'Your JEE Main Mock Test registration is not complete, so result access is not available.',
      },
    };
  }
  return { ok: true, status: 200, mobile: session.mobile, body: { success: true, result: pub } };
}

async function resultPdf(token) {
  const current = await currentResult(token);
  if (!current.ok) return current;
  if (!current.body.result || current.body.result.eligibility !== ELIGIBILITY.REGISTERED_ATTEMPTED) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        code: 'PDF_UNAVAILABLE',
        message: 'A result PDF is available only after the mock test has been attempted.',
      },
    };
  }
  return { ok: true, mobile: current.mobile, body: current.body, result: current.body.result };
}

async function logout(token) {
  if (token) {
    await JeeMockTestResultSession.updateOne(
      { tokenHash: tokenHash(token) },
      { $set: { revokedAt: new Date() } }
    );
  }
  return { status: 200, body: { success: true } };
}

module.exports = {
  setJeeResultOtpSenderForTests,
  maskMobile,
  requestOtp,
  pendingStatus,
  verifyOtp,
  currentResult,
  resultPdf,
  logout,
};
