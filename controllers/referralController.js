const { generateOTP, hashOTP, verifyOTP } = require('../utils/otpUtil');
const otpRepository = require('../utils/otpRepository');
const { sendOtp: sendOtpSms } = require('../utils/msg91Service');
const { isPrivilegedPhone, getPrivilegedOtp, shouldSkipSmsForPrivileged } = require('../utils/privilegedAccess');
const ReferralLogin = require('../models/ReferralLogin');

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES) || 5;
const OTP_EXPIRY_MS = OTP_EXPIRY_MINUTES * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 3;

function normalizePhone(phone) {
  return otpRepository.normalize(phone);
}

/**
 * POST /api/referral/send-otp
 * Body: { phone } or { whatsappNumber }. Phone only; no name/occupation.
 */
exports.sendOtp = async (req, res) => {
  try {
    const phone = req.body?.phone || req.body?.whatsappNumber;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
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

    if (!skipSms) {
      const gw = await sendOtpSms(p, otp);
      if (!gw.success) {
        if (privileged) {
          console.warn('[referral/sendOtp] SMS gateway returned error for privileged phone, continuing with bypass code:', gw.error);
        } else {
          return res.status(502).json({
            success: false,
            message: 'Could not send OTP.',
            detail: gw.error || 'SMS service error'
          });
        }
      }
    } else {
      console.log('[referral/sendOtp] Privileged OTP bypass (no SMS) for phone ending', p.slice(-4));
    }

    await otpRepository.saveOtp(p, hashed, expiresAt);
    const responsePayload = { success: true, message: 'OTP sent successfully' };
    if (privileged) {
      responsePayload.isPrivileged = true;
      if (process.env.NODE_ENV !== 'production') {
        responsePayload.bypassOtp = otp;
      }
    }
    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error('[referral/sendOtp]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * POST /api/referral/verify-otp
 * Body: { phone, otp }. On success, save to ReferralLogin and return verified.
 */
exports.verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body || {};
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone required' });
    }
    if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(String(otp))) {
      return res.status(400).json({ success: false, message: 'OTP must be 6 digits' });
    }

    const rec = await otpRepository.getLatest(p);
    if (!rec) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }
    if (new Date(rec.expiresAt) < new Date()) {
      await otpRepository.deleteOtp(p);
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }
    if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
      await otpRepository.deleteOtp(p);
      return res.status(400).json({ success: false, message: 'Too many attempts.' });
    }
    if (!verifyOTP(String(otp), rec.otpHash)) {
      const updated = await otpRepository.incrementAttempts(p);
      if (updated && updated.attempts >= MAX_VERIFY_ATTEMPTS) {
        await otpRepository.deleteOtp(p);
      }
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    await otpRepository.deleteOtp(p);
    await ReferralLogin.create({ phone: p });

    return res.status(200).json({ success: true, verified: true, message: 'OTP verified' });
  } catch (err) {
    console.error('[referral/verifyOtp]', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
