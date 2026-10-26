'use strict';

/**
 * Credentialed browser origins for the API and for CRM login.
 *
 * Production accepts only explicit HTTPS origins. The hostnames below are the
 * ones already named in this repository's server allow-list and frontend
 * deployment notes. FRONTEND_URL may add more exact https origins. It cannot
 * add a wildcard, an http origin, localhost, or an arbitrary *.vercel.app host.
 *
 * The owner still needs to confirm that https://guide-xpert-frontend.vercel.app
 * is a current production frontend. The frontend vercel.json rewrites /api to
 * gxp-new-backend.vercel.app and does not name the browser origin.
 *
 * A missing Origin is allowed. Browsers send Origin on cross-site requests.
 * State-changing CRM routes still require a session and CSRF. Non-browser
 * clients often omit Origin.
 *
 * Development and test also allow localhost and 127.0.0.1 on any port, and
 * exact FRONTEND_URL values including http. That does not apply when
 * NODE_ENV is production.
 */

const PRODUCTION_FRONTEND_ORIGINS = Object.freeze([
  'https://www.guidexpert.co.in',
  'https://guidexpert.co.in',
  'https://guide-xpert-frontend.vercel.app',
]);

const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function isHttpsOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function configuredOrigins(env) {
  return String((env && env.FRONTEND_URL) || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isProduction(env) {
  return String((env && env.NODE_ENV) || '') === 'production';
}

function isAllowedCrmOrigin(origin, env = process.env) {
  if (origin == null || origin === '') return true;
  if (typeof origin !== 'string') return false;
  const production = isProduction(env);
  const configured = configuredOrigins(env);
  if (production) {
    if (!isHttpsOrigin(origin)) return false;
    if (PRODUCTION_FRONTEND_ORIGINS.includes(origin)) return true;
    return configured.filter(isHttpsOrigin).includes(origin);
  }
  if (PRODUCTION_FRONTEND_ORIGINS.includes(origin)) return true;
  if (configured.includes(origin)) return true;
  return LOCAL_DEV_ORIGIN.test(origin);
}

function assertAllowedOrigin(req, env = process.env) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (!origin) return true;
  return isAllowedCrmOrigin(origin, env);
}

function crmCorsOrigin(origin, callback, env = process.env) {
  if (!origin) return callback(null, true);
  if (isAllowedCrmOrigin(origin, env)) return callback(null, origin);
  return callback(null, false);
}

module.exports = {
  PRODUCTION_FRONTEND_ORIGINS,
  assertAllowedOrigin,
  crmCorsOrigin,
  isAllowedCrmOrigin,
  isHttpsOrigin,
};
