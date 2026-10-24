'use strict';

/**
 * Transient MongoDB / network failures only.
 * Callers that send WhatsApp, SMS, or otherwise mutate external state must not use retryTransient.
 */

const NON_TRANSIENT_CODES = new Set([
  18, // AuthenticationFailed
  50, // MaxTimeMSExpired — retrying repeats the same expensive query
  10334, // BSONObjectTooLarge
  11000, // DuplicateKey
]);

const TRANSIENT_CODES = new Set([
  6, // HostUnreachable
  7, // HostNotFound
  89, // NetworkTimeout
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  9001, // SocketException
  10107, // NotWritablePrimary
  11600, // InterruptedAtShutdown
  11602, // InterruptedDueToReplStateChange
  13435, // NotPrimaryNoSecondaryOk ("not primary and secondaryOk=false")
  13436, // NotPrimaryOrSecondary
]);

const SECRET_LEAK = /mongodb(\+srv)?:\/\/|\/\/[^/\s]+:[^@/\s]+@|password=|authSource=|GUP?SHUP|MSG91|Bearer\s+\S+/i;

function errorText(error) {
  if (!error) return '';
  return String(error.message || error.errmsg || '');
}

function isNonTransientMongoError(error) {
  const code = Number(error.code);
  if (NON_TRANSIENT_CODES.has(code)) return true;
  const msg = errorText(error);
  return /BSON size limit|BSONObj size|object to insert too large|operation exceeded time limit|MaxTimeMSExpired|authentication failed|bad auth|not whitelisted|whitelist/i.test(msg);
}

function isTransientSignal(error) {
  const name = String(error.name || '');
  if (/ServerSelection|NetworkTimeout|NetworkError|PoolCleared/i.test(name)) return true;
  const code = Number(error.code);
  if (TRANSIENT_CODES.has(code)) return true;
  const msg = errorText(error);
  return /not primary and secondaryOk=false|not master and slaveOk=false|not primary|not master|connection \d+ to .+ timed out|server selection timed out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|topology was destroyed/i.test(msg);
}

function isTransientMongoError(error, seen = new WeakSet()) {
  if (!error || typeof error !== 'object') return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if (isNonTransientMongoError(error)) return false;
  if (isTransientSignal(error)) return true;
  return isTransientMongoError(error.cause, seen) || isTransientMongoError(error.reason, seen);
}

function isQueryTimeLimitError(error) {
  if (!error || typeof error !== 'object') return false;
  if (Number(error.code) === 50) return true;
  return /operation exceeded time limit|MaxTimeMSExpired/i.test(errorText(error));
}

function isBsonLimitError(error) {
  if (!error || typeof error !== 'object') return false;
  if (Number(error.code) === 10334) return true;
  return /BSON size limit|BSONObj size|object to insert too large/i.test(errorText(error));
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://[redacted]')
    .replace(/\b\d{10,}\b/g, '[redacted]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]');
}

function publicClientMessage(error, fallback = 'Internal server error') {
  if (isQueryTimeLimitError(error)) {
    return 'The request took too long. Narrow the date range and try again.';
  }
  if (isBsonLimitError(error)) {
    return 'The request was too large. Narrow the date range and try again.';
  }
  if (isTransientMongoError(error)) {
    return 'Database temporarily unavailable. Try again.';
  }
  let raw = errorText(error).trim();
  if (!raw || SECRET_LEAK.test(raw) || /Mongo(Network|Server|Parse|Driver)/.test(raw) || raw.length > 240) {
    return fallback;
  }
  raw = redactSensitiveText(raw);
  return raw || fallback;
}

function safeErrorSummary(error) {
  const name = String(error?.name || 'Error').replace(/[^\w]/g, '').slice(0, 80) || 'Error';
  const code = Number.isFinite(Number(error?.code)) ? ` ${Number(error.code)}` : '';
  return `${name}${code}: ${publicClientMessage(error)}`.slice(0, 300);
}

function logDbError(label, error) {
  const detail = redactSensitiveText(error?.stack || errorText(error) || error);
  console.error(label, error?.name || 'Error', error?.code ?? '', detail);
}

function cronFailurePayload(error) {
  const transient = isTransientMongoError(error);
  return {
    status: transient ? 503 : 500,
    body: {
      success: false,
      message: transient
        ? 'Database temporarily unavailable. Try again.'
        : publicClientMessage(error, 'Internal server error'),
    },
  };
}

function analyticsFailurePayload(error) {
  if (isQueryTimeLimitError(error)) {
    return {
      status: 500,
      body: {
        success: false,
        message: 'Analytics query timed out. Narrow the date range and try again.',
      },
    };
  }
  if (isBsonLimitError(error)) {
    return {
      status: 500,
      body: {
        success: false,
        message: 'Analytics result was too large. Narrow the date range and try again.',
      },
    };
  }
  if (isTransientMongoError(error)) {
    return {
      status: 503,
      body: {
        success: false,
        message: 'Database temporarily unavailable. Try again.',
      },
    };
  }
  return {
    status: 500,
    body: { success: false, message: 'Something went wrong.' },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an operation that is safe to run more than once.
 * Refuses to run unless `idempotent: true` so message sends cannot be wrapped by accident.
 * Attempts are capped at 3. Backoff is exponential and capped.
 */
async function retryTransient(operation, options = {}) {
  if (options.idempotent !== true) {
    throw new Error('retryTransient refuses non-idempotent operations');
  }
  const attempts = Math.min(3, Math.max(1, options.attempts ?? 2));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 1000);
  const sleep = options.sleep || defaultSleep;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientMongoError(error) || attempt === attempts) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = {
  isTransientMongoError,
  isQueryTimeLimitError,
  isBsonLimitError,
  redactSensitiveText,
  publicClientMessage,
  safeErrorSummary,
  logDbError,
  cronFailurePayload,
  analyticsFailurePayload,
  retryTransient,
};
