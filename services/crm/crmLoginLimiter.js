'use strict';

const { consumeRateLimit, resetRateLimitsForTests } = require('./crmRateLimit');

const WINDOW_MS = 15 * 60 * 1000;

function limits() {
  const ip = Number(process.env.CRM_LOGIN_MAX_IP || 50);
  const identifier = Number(process.env.CRM_LOGIN_MAX_IDENTIFIER || 8);
  return {
    ip: Number.isInteger(ip) && ip > 0 ? ip : 50,
    identifier: Number.isInteger(identifier) && identifier > 0 ? identifier : 8,
    windowMs: WINDOW_MS,
  };
}

async function assertLoginAllowed(ip, identifier, now = Date.now()) {
  const cap = limits();
  const ipAllowed = await consumeRateLimit(`login:ip:${ip || 'unknown'}`, cap.ip, cap.windowMs, now);
  const idAllowed = await consumeRateLimit(`login:id:${identifier || 'blank'}`, cap.identifier, cap.windowMs, now);
  return ipAllowed && idAllowed;
}

function resetLoginLimiterForTests() {
  resetRateLimitsForTests();
}

module.exports = {
  assertLoginAllowed,
  resetLoginLimiterForTests,
};
