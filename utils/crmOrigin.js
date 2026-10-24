'use strict';

const localhostDevOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const guidexpertOriginRegex = /^https?:\/\/([a-z0-9-]+\.)*guidexpert\.co\.in$/i;
const vercelOriginRegex = /^https:\/\/[a-z0-9-]+(-[a-z0-9-]+)*\.vercel\.app$/i;

function allowedOrigins() {
  return String(process.env.FRONTEND_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAllowedCrmOrigin(origin) {
  if (!origin) return true;
  if (typeof origin !== 'string') return false;
  return (
    allowedOrigins().includes(origin) ||
    localhostDevOriginRegex.test(origin) ||
    guidexpertOriginRegex.test(origin) ||
    vercelOriginRegex.test(origin)
  );
}

function assertAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return isAllowedCrmOrigin(origin);
}

module.exports = {
  isAllowedCrmOrigin,
  assertAllowedOrigin,
};
