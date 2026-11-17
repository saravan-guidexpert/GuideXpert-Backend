'use strict';

/**
 * Privacy-safe operational telemetry for Phase 2B.
 *
 * The project has no metrics backend. This module provides:
 *   1. Structured JSON log events with stable `event` names that Vercel/log drains can turn into
 *      counters and alerts.
 *   2. Best-effort in-process counters for diagnostics within a single invocation/isolate.
 *
 * IMPORTANT: in-process counters are NOT durable across Vercel invocations. They are useful for
 * a cron summary response and local diagnostics only. Durable dashboards/alerts must be derived
 * from the structured logs (see PHASE_2B_WEBHOOKS.md §Observability).
 */

const counters = new Map();

// Never allow these keys into log output. Matching is intentionally broad.
const SENSITIVE_KEY_PATTERN = /(clientstate|secret|token|authorization|cookie|password|body|subject|content|attachment|raw|emailaddress|recipient|sender)/i;

// Redact secrets and mailbox addresses that appear inside arbitrary string values
// (for example an upstream error message). Key-based filtering cannot protect these.
const REDACTION_RULES = Object.freeze([
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  {
    pattern: /\b(access_token|refresh_token|id_token|token|client_state|clientstate|secret|sig|signature)=([^&\s]+)/gi,
    replacement: '$1=[REDACTED]'
  },
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: '[REDACTED_EMAIL]' }
]);

/**
 * Redacts common secret shapes and email addresses from a string and bounds its length.
 * This is deliberately conservative: operational logs must never become a secret/PII sink.
 */
function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

function maskMailbox(mailbox) {
  if (!mailbox || typeof mailbox !== 'string') return null;
  const trimmed = mailbox.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return undefined;
}

function sanitizeFields(fields = {}) {
  const sanitized = sanitizeValue(fields) || {};
  if (Object.prototype.hasOwnProperty.call(fields, 'mailbox')) {
    sanitized.mailbox = maskMailbox(fields.mailbox);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'folder') && typeof fields.folder === 'string') {
    sanitized.folder = fields.folder.toLowerCase();
  }
  return sanitized;
}

/**
 * Emits a structured operational event. Never pass raw clientState, tokens, bodies, subjects,
 * attachment content or unmasked mailbox addresses to this function.
 */
function logOperationalEvent(level, event, fields = {}) {
  // Keep the node:test output readable. Counters are still recorded.
  if (process.env.NODE_TEST_CONTEXT && process.env.SUPPORT_EMAIL_TELEMETRY_LOGS !== '1') {
    return;
  }
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...sanitizeFields(fields)
  };
  console[method](JSON.stringify(payload));
}

/**
 * Increments a best-effort in-process counter. Returns the new value.
 */
function incrementMetric(name, delta = 1, labels = {}) {
  const key = `${name}|${JSON.stringify(labels)}`;
  const next = (counters.get(key) || 0) + delta;
  counters.set(key, next);
  return next;
}

function recordMetricEvent(name, fields = {}) {
  incrementMetric(name, 1, {});
  logOperationalEvent('info', name, fields);
}

function getMetricsSnapshot() {
  const snapshot = {};
  for (const [key, value] of counters.entries()) {
    const separator = key.indexOf('|');
    const name = key.slice(0, separator);
    const labels = key.slice(separator + 1);
    if (!snapshot[name]) snapshot[name] = [];
    snapshot[name].push({ labels: JSON.parse(labels), value });
  }
  return snapshot;
}

function resetMetricsForTests() {
  counters.clear();
}

/**
 * Converts an Error into a privacy-safe structured payload. The message is redacted and
 * truncated; callers should not add raw error messages beside this summary.
 */
function summarizeError(err) {
  if (!err) {
    return { errorName: null, errorCode: null, statusCode: null, errorMessage: null };
  }
  const statusCode = err.statusCode || err.response?.status || null;
  return {
    errorName: err.name || null,
    errorCode: err.code || null,
    statusCode,
    errorMessage: err.message ? sanitizeText(String(err.message)) : null
  };
}

module.exports = {
  maskMailbox,
  sanitizeText,
  sanitizeFields,
  summarizeError,
  logOperationalEvent,
  incrementMetric,
  recordMetricEvent,
  getMetricsSnapshot,
  resetMetricsForTests
};
