'use strict';

const WINDOW_MS = 15 * 60 * 1000;
const buckets = new Map();

function limits() {
  const ip = Number(process.env.CRM_LOGIN_MAX_IP || 50);
  const identifier = Number(process.env.CRM_LOGIN_MAX_IDENTIFIER || 8);
  return {
    ip: Number.isInteger(ip) && ip > 0 ? ip : 50,
    identifier: Number.isInteger(identifier) && identifier > 0 ? identifier : 8,
    windowMs: WINDOW_MS,
  };
}

function prune(now, windowMs) {
  if (buckets.size < 5000) return;
  for (const [key, entry] of buckets) {
    if (now - entry.start > windowMs) buckets.delete(key);
  }
}

function consume(key, max, now) {
  const windowMs = limits().windowMs;
  prune(now, windowMs);
  const current = buckets.get(key);
  if (!current || now - current.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function assertLoginAllowed(ip, identifier, now = Date.now()) {
  const cap = limits();
  const ipAllowed = consume(`ip:${ip || 'unknown'}`, cap.ip, now);
  const idAllowed = consume(`id:${identifier || 'blank'}`, cap.identifier, now);
  return ipAllowed && idAllowed;
}

function resetLoginLimiterForTests() {
  if (process.env.NODE_ENV === 'production') return;
  buckets.clear();
}

module.exports = {
  assertLoginAllowed,
  resetLoginLimiterForTests,
};
