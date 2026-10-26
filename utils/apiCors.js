'use strict';

const { crmCorsOrigin } = require('./crmOrigin');

// Allow any Vercel preview/production frontend (*.vercel.app)
const vercelOriginRegex = /^https:\/\/[a-z0-9-]+(-[a-z0-9-]+)*\.vercel\.app$/i;
// Any localhost / 127.0.0.1 port (Vite may use 5173, 5174, etc.)
const localhostDevOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
// Production/staging on guidexpert.co.in (www or subdomains)
const guidexpertOriginRegex = /^https?:\/\/([a-z0-9-]+\.)*guidexpert\.co\.in$/i;

function siteAllowedOrigins(env = process.env) {
  const origins = [
    env.FRONTEND_URL,
    'https://www.guidexpert.co.in',
    'https://guidexpert.co.in',
    'http://www.guidexpert.co.in',
    'http://guidexpert.co.in',
    'https://guide-xpert-frontend.vercel.app',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ].filter(Boolean);
  if (origins.length === 0) origins.push('https://guidexpert.co.in');
  return origins;
}

function isAllowedSiteOrigin(origin, env = process.env) {
  if (!origin) return true;
  return (
    siteAllowedOrigins(env).includes(origin) ||
    vercelOriginRegex.test(origin) ||
    localhostDevOriginRegex.test(origin) ||
    guidexpertOriginRegex.test(origin)
  );
}

// CRM routes carry a session cookie, so they use the strict CRM allow-list.
function isCrmPath(req) {
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  return /^\/api\/crm(?:-auth)?(?:\/|$)/.test(pathOnly);
}

const BASE_OPTIONS = Object.freeze({
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CRM-CSRF'],
  optionsSuccessStatus: 204,
});

function apiCorsOptions(env = process.env) {
  function siteOrigin(origin, callback) {
    if (isAllowedSiteOrigin(origin, env)) {
      return callback(null, origin || siteAllowedOrigins(env)[0]);
    }
    console.warn('[cors] Blocked origin:', origin);
    return callback(null, false);
  }

  function crmOrigin(origin, callback) {
    return crmCorsOrigin(origin, (err, allowed) => {
      if (origin && allowed !== origin) {
        console.warn('[cors] Blocked an origin that is not on the CRM allow-list.');
      }
      return callback(err, allowed);
    }, env);
  }

  return function corsOptionsDelegate(req, callback) {
    callback(null, { ...BASE_OPTIONS, origin: isCrmPath(req) ? crmOrigin : siteOrigin });
  };
}

module.exports = { apiCorsOptions, isAllowedSiteOrigin, isCrmPath };
