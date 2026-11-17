'use strict';

const crypto = require('crypto');

const PENDING_COOKIE = 'gx_jee_result_pending';
const SESSION_COOKIE = 'gx_jee_result_sid';
const COOKIE_PATH = '/api/jee-main-mock-test/results';
const PENDING_MS = 15 * 60 * 1000;
const SESSION_MS = 30 * 60 * 1000;

function signingSecret() {
  const secret = process.env.OTP_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'test') return 'jee-result-test-secret';
  throw new Error('OTP_SECRET is not set');
}

function cookieSecure() {
  return process.env.NODE_ENV === 'production';
}

function readCookies(req) {
  const header = req && req.headers ? req.headers.cookie || '' : '';
  const out = {};
  String(header).split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  });
  return out;
}

function serializeCookie(name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value == null ? '' : value)}`,
    `Path=${COOKIE_PATH}`,
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (cookieSecure()) parts.push('Secure');
  if (maxAgeMs === 0) parts.push('Max-Age=0');
  else parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join('; ');
}

function appendCookies(res, cookies) {
  const current = res.getHeader('Set-Cookie');
  const next = []
    .concat(current || [])
    .concat(cookies)
    .filter(Boolean);
  res.setHeader('Set-Cookie', next);
}

function signPending(mobile) {
  const expiresAt = Date.now() + PENDING_MS;
  const body = Buffer.from(JSON.stringify({ m: mobile, e: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, maxAgeMs: PENDING_MS };
}

function readPendingMobile(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.e !== 'number' || payload.e < Date.now()) return null;
  if (!/^[6-9]\d{9}$/.test(payload.m)) return null;
  return payload.m;
}

function pendingMobileFromRequest(req) {
  return readPendingMobile(readCookies(req)[PENDING_COOKIE]);
}

function sessionTokenFromRequest(req) {
  const token = readCookies(req)[SESSION_COOKIE];
  return token || null;
}

function setPendingCookie(res, token) {
  appendCookies(res, [serializeCookie(PENDING_COOKIE, token, PENDING_MS)]);
}

function clearPendingCookie(res) {
  appendCookies(res, [serializeCookie(PENDING_COOKIE, '', 0)]);
}

function setSessionCookie(res, token) {
  appendCookies(res, [serializeCookie(SESSION_COOKIE, token, SESSION_MS)]);
}

function clearSessionCookie(res) {
  appendCookies(res, [serializeCookie(SESSION_COOKIE, '', 0)]);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
  PENDING_COOKIE,
  SESSION_COOKIE,
  COOKIE_PATH,
  PENDING_MS,
  SESSION_MS,
  readCookies,
  signPending,
  readPendingMobile,
  pendingMobileFromRequest,
  sessionTokenFromRequest,
  setPendingCookie,
  clearPendingCookie,
  setSessionCookie,
  clearSessionCookie,
  tokenHash,
  newSessionToken,
};
