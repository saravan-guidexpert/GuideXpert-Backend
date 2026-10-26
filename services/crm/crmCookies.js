'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'gx_crm_session';
const CSRF_COOKIE = 'gx_crm_csrf';
const REMEMBER_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

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

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function cookieOptions(remember) {
  const options = {
    path: '/',
    sameSite: 'lax',
    secure: cookieSecure(),
  };
  if (remember) options.maxAge = REMEMBER_MS;
  return options;
}

function setSessionCookies(res, sessionToken, csrfToken, remember) {
  res.cookie(SESSION_COOKIE, sessionToken, { ...cookieOptions(remember), httpOnly: true });
  res.cookie(CSRF_COOKIE, csrfToken, { ...cookieOptions(remember), httpOnly: false });
}

function setCsrfCookie(res, csrfToken, remember) {
  res.cookie(CSRF_COOKIE, csrfToken, { ...cookieOptions(remember), httpOnly: false });
}

function clearSessionCookies(res) {
  const base = { path: '/', sameSite: 'lax', secure: cookieSecure() };
  res.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}

function sessionLifetime(remember) {
  return remember ? REMEMBER_MS : SESSION_MS;
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  REMEMBER_MS,
  SESSION_MS,
  readCookies,
  tokenHash,
  newSecret,
  setSessionCookies,
  setCsrfCookie,
  clearSessionCookies,
  sessionLifetime,
};
