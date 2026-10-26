'use strict';

const { CrmError } = require('../../utils/crmError');

const memoryBuckets = new Map();

/**
 * Production uses MongoDB, which this API already requires for CRM transactions.
 * There is no Redis (or other shared cache) in the repositories. Per-process
 * memory is the development and test fallback only. Production does not use it.
 * A MongoDB error denies the attempt instead of opening the limit.
 *
 * The unique index on crmRateLimits.key is declared on the model. Remote
 * databases do not build it on deploy. The limiter still counts without that
 * index; concurrent first inserts can under-count until the index exists.
 */
function useSharedRateLimitStore(env = process.env) {
  return String((env && env.NODE_ENV) || '') === 'production';
}

function consumeMemory(key, max, windowMs, now) {
  const current = memoryBuckets.get(key);
  if (!current || now - current.start > windowMs) {
    memoryBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

async function consumeMongo(key, max, windowMs, now) {
  const CrmRateLimit = require('../../models/CrmRateLimit');
  try {
    const windowBegin = new Date(now - windowMs);
    const fresh = await CrmRateLimit.findOneAndUpdate(
      { key, windowStart: { $gte: windowBegin } },
      { $inc: { count: 1 } },
      { new: true }
    );
    if (fresh) return fresh.count <= max;
    await CrmRateLimit.updateOne(
      { key },
      { $set: { windowStart: new Date(now), count: 1 } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err instanceof CrmError) throw err;
    throw new CrmError(
      503,
      'Request protection is unavailable. Nothing was changed.',
      'rate_limit_unavailable'
    );
  }
}

async function consumeRateLimit(key, max, windowMs, now = Date.now(), env = process.env) {
  if (useSharedRateLimitStore(env)) return consumeMongo(key, max, windowMs, now);
  return consumeMemory(key, max, windowMs, now);
}

function resetRateLimitsForTests() {
  if (process.env.NODE_ENV === 'production') return;
  memoryBuckets.clear();
}

module.exports = {
  consumeMemory,
  consumeMongo,
  consumeRateLimit,
  resetRateLimitsForTests,
  useSharedRateLimitStore,
};
