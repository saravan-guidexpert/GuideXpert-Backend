const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.OTP_SECRET = process.env.OTP_SECRET || 'test-otp-secret-for-resources';

function signDownloadToken(resourceId, phone) {
  const secret = process.env.OTP_SECRET;
  const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
  const exp = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  const payload = `${resourceId}|${phone}|${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verifyDownloadToken(token, resourceId, phone) {
  const secret = process.env.OTP_SECRET;
  if (!secret || !token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 4) return false;
    const [tokenResourceId, tokenPhone, expStr, sig] = parts;
    if (tokenResourceId !== resourceId || tokenPhone !== phone) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const payload = `${tokenResourceId}|${tokenPhone}|${expStr}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

test('download token signs and verifies for matching resource and phone', () => {
  const token = signDownloadToken('abc123', '9876543210');
  assert.equal(verifyDownloadToken(token, 'abc123', '9876543210'), true);
  assert.equal(verifyDownloadToken(token, 'other', '9876543210'), false);
  assert.equal(verifyDownloadToken(token, 'abc123', '1111111111'), false);
});

test('student resource models and storage service load', () => {
  require('../models/StudentResource');
  require('../models/StudentResourceDownload');
  require('../services/resourceStorageService');
  require('../controllers/studentResourceController');
});

test('resource download OTP uses the MSG91 sender', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../controllers/studentResourceController.js'),
    'utf8'
  );
  assert.match(source, /const \{ sendOtp: sendOtpSms \} = require\('\.\.\/utils\/msg91Service'\)/);
  assert.match(source, /gw = await sendOtpSms\(p, otp\)/);
});
