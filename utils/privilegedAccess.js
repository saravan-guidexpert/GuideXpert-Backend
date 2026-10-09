/**
 * Privileged phone bypass for QA: fixed OTP (no SMS) and full panel eligibility.
 * New phone-gated features should call isPrivilegedPhone() before DB eligibility checks.
 */

const crypto = require('crypto');
const otpRepository = require('./otpRepository');
const Admin = require('../models/Admin');

const DEFAULT_PRIVILEGED_PHONES = ['8143266699', '6304153659', '8919926373'];
const DEFAULT_PRIVILEGED_OTP = '123456';

function normalizePrivilegedPhone(phone) {
  return otpRepository.normalize(phone);
}

function parsePhoneList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,;\s]+/)
    .map((part) => normalizePrivilegedPhone(part.trim()))
    .filter((p) => /^\d{10}$/.test(p));
}

/** @returns {string[]} normalized 10-digit privileged phones */
function getPrivilegedPhones() {
  const fromEnv = parsePhoneList(process.env.OTP_BYPASS_PHONES || process.env.OTP_BYPASS_PHONE);
  const list = fromEnv.length > 0 ? fromEnv : [...DEFAULT_PRIVILEGED_PHONES];
  return [...new Set(list)];
}

/** @deprecated prefer getPrivilegedPhones — returns first privileged phone */
function getPrivilegedPhone() {
  return getPrivilegedPhones()[0] || DEFAULT_PRIVILEGED_PHONES[0];
}

function getPrivilegedOtp() {
  const code = String(process.env.OTP_BYPASS_CODE || DEFAULT_PRIVILEGED_OTP).trim();
  return /^\d{6}$/.test(code) ? code : DEFAULT_PRIVILEGED_OTP;
}

function isPrivilegedPhone(phone) {
  const p = normalizePrivilegedPhone(phone);
  if (!p || p.length !== 10) return false;
  return getPrivilegedPhones().includes(p);
}

/**
 * Find or create super-admin for privileged phone (username = 10-digit phone).
 */
async function ensurePrivilegedAdmin(phone) {
  const p = normalizePrivilegedPhone(phone);
  if (!isPrivilegedPhone(p)) {
    throw new Error('Not a privileged phone');
  }
  const username = p;
  let admin = await Admin.findOne({ username });
  const password =
    (process.env.PRIVILEGED_ADMIN_PASSWORD && String(process.env.PRIVILEGED_ADMIN_PASSWORD).trim()) ||
    crypto.randomBytes(16).toString('hex');
  if (!admin) {
    admin = await Admin.create({
      username,
      password,
      name: 'Privileged QA Admin',
      isSuperAdmin: true,
      sectionAccess: [],
    });
    console.log('[privilegedAccess] Created super-admin for phone ending', p.slice(-4));
    return admin;
  }
  if (!admin.isSuperAdmin) {
    admin.isSuperAdmin = true;
    admin.updatedAt = new Date();
    await admin.save();
  }
  return admin;
}

/**
 * By default, privileged QA phones SHOULD still receive real SMS if SMS gateway is configured,
 * unless explicitly disabled via OTP_BYPASS_SKIP_SMS=true.
 */
function shouldSkipSmsForPrivileged(phone) {
  if (!isPrivilegedPhone(phone)) return false;
  return process.env.OTP_BYPASS_SKIP_SMS === 'true';
}

module.exports = {
  normalizePrivilegedPhone,
  getPrivilegedPhones,
  getPrivilegedPhone,
  getPrivilegedOtp,
  isPrivilegedPhone,
  shouldSkipSmsForPrivileged,
  ensurePrivilegedAdmin,
};
