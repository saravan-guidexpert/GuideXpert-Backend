/**
 * MongoDB-backed OTP storage with resend cooldown and rate limiting.
 * Keys use normalized 10-digit Indian phone (no 91 prefix).
 */

const mongoose = require('mongoose');
const OtpVerification = require('../models/OtpVerification');
const otpMemoryFallback = require('./otpMemoryFallback');

const RESEND_COOLDOWN_MS = 60 * 1000;       // 60 seconds
const RATE_WINDOW_MS = 15 * 60 * 1000;     // 15 minutes
const MAX_OTP_PER_WINDOW = 3;

function normalize(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

async function ensureDbReady() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connection.asPromise();
}

/**
 * Check if we can send a new OTP: resend cooldown (60s) and rate limit (3 per 15 min).
 * @returns {{ allowed: boolean, retryAfter?: number, message?: string }}
 */
async function canSend(phone) {
  const p = normalize(phone);
  if (!p || p.length !== 10) return { allowed: false, message: 'Invalid phone' };

  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - RESEND_COOLDOWN_MS);
  const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);

  const memLatest = otpMemoryFallback.get(p);
  if (memLatest?.createdAt && new Date(memLatest.createdAt) > cooldownCutoff) {
    const waitSec = Math.ceil(
      (new Date(memLatest.createdAt).getTime() + RESEND_COOLDOWN_MS - now.getTime()) / 1000
    );
    return { allowed: false, retryAfter: waitSec, message: 'Please wait before requesting another OTP.' };
  }

  // Resend cooldown: latest OTP for this phone must be older than 60s.
  // An already-expired code must not keep the student waiting.
  const latest = await OtpVerification.findOne({ phoneNumber: p })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  const latestStillValid = latest && latest.expiresAt && new Date(latest.expiresAt).getTime() > now.getTime();
  if (latestStillValid && latest.createdAt && new Date(latest.createdAt) > cooldownCutoff) {
    const waitSec = Math.ceil((new Date(latest.createdAt).getTime() + RESEND_COOLDOWN_MS - now.getTime()) / 1000);
    return { allowed: false, retryAfter: waitSec, message: 'Please wait before requesting another OTP.' };
  }

  // Rate limit: count OTPs for this phone in last 15 min
  const count = await OtpVerification.countDocuments({
    phoneNumber: p,
    createdAt: { $gte: windowStart },
  });
  if (count >= MAX_OTP_PER_WINDOW) {
    return { allowed: false, message: 'Too many OTP requests. Try again after 15 minutes.', retryAfter: 900 };
  }

  return { allowed: true };
}

/**
 * Save OTP (hashed) for a phone. MongoDB primary; in-memory fallback on write failure.
 */
async function saveOtp(phone, otpHash, expiresAt) {
  const p = normalize(phone);
  const expires = new Date(expiresAt);
  const createdAt = new Date();
  const record = {
    phoneNumber: p,
    otpHash,
    expiresAt: expires,
    attempts: 0,
    createdAt,
  };

  try {
    await ensureDbReady();
    await OtpVerification.deleteMany({ phoneNumber: p });
    await OtpVerification.create(record);
    otpMemoryFallback.remove(p);
    return { storage: 'mongodb' };
  } catch (mongoErr) {
    console.error(
      '[otpRepository] Mongo saveOtp failed for phone ending',
      p.slice(-4),
      mongoErr?.message,
      mongoErr?.code || ''
    );
    otpMemoryFallback.set(p, record);
    return { storage: 'memory', mongoError: mongoErr?.message };
  }
}

/**
 * Get latest OTP record for a phone (memory first, then Mongo).
 */
async function getLatest(phone) {
  const p = normalize(phone);
  const mem = otpMemoryFallback.get(p);
  if (mem) return mem;

  return OtpVerification.findOne({ phoneNumber: p })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
}

/**
 * Delete OTP record(s) for a phone.
 */
async function deleteOtp(phone) {
  const p = normalize(phone);
  otpMemoryFallback.remove(p);
  await OtpVerification.deleteMany({ phoneNumber: p });
}

/**
 * Increment verification attempts for the latest OTP of this phone.
 * @returns {Promise<{ attempts: number } | null>}
 */
async function incrementAttempts(phone) {
  const p = normalize(phone);
  const mem = otpMemoryFallback.get(p);
  if (mem) {
    return otpMemoryFallback.incrementAttempts(p);
  }

  const latest = await OtpVerification.findOne({ phoneNumber: p })
    .sort({ createdAt: -1 })
    .select('_id attempts')
    .lean()
    .exec();
  if (!latest?._id) return null;

  const doc = await OtpVerification.findByIdAndUpdate(
    latest._id,
    { $inc: { attempts: 1 } },
    { new: true }
  )
    .lean()
    .exec();
  return doc ? { attempts: doc.attempts } : null;
}

module.exports = {
  normalize,
  canSend,
  saveOtp,
  getLatest,
  deleteOtp,
  incrementAttempts,
};
