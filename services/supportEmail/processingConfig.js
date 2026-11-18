'use strict';

const { LIMITS } = require('../../constants/supportEmail');

const DEFAULT_MAX_DURATION_MS = 60000;
const DEFAULT_LOCK_MARGIN_MS = 15000;

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function unsafe(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function overrideOrEnv(overrides, key, envName, fallback) {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  return positiveInt(envName, fallback);
}

function numberInRange(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * The bulk worker runs only when the variable is exactly "1" after trimming.
 * "0", "false", "true", and an empty value all leave it disabled.
 */
function isBulkProcessingEnabled(env = process.env) {
  return String(env && env.SUPPORT_EMAIL_PROCESSING_ENABLED != null ? env.SUPPORT_EMAIL_PROCESSING_ENABLED : '').trim() === '1';
}

/**
 * Phase 3 stays off until SUPPORT_EMAIL_PROCESSING_ENABLED=1.
 * The cron route checks this and does not register itself in vercel.json.
 * An override enables a batch only when it is the boolean true, so the string "0" cannot turn the worker on.
 */
function getProcessingConfig(overrides = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(overrides, 'enabled')
    ? overrides.enabled === true
    : isBulkProcessingEnabled();
  const maxDurationMs = overrideOrEnv(overrides, 'maxDurationMs', 'SUPPORT_EMAIL_MAX_DURATION_MS', DEFAULT_MAX_DURATION_MS);
  const lockMarginMs = overrideOrEnv(overrides, 'lockMarginMs', 'SUPPORT_EMAIL_LOCK_MARGIN_MS', DEFAULT_LOCK_MARGIN_MS);
  const requestedBudget = overrideOrEnv(overrides, 'timeBudgetMs', 'SUPPORT_EMAIL_TIME_BUDGET_MS', LIMITS.DEFAULT_TIME_BUDGET_MS);
  const requestedLease = overrideOrEnv(overrides, 'leaseMs', 'SUPPORT_EMAIL_STALE_LEASE_MS', LIMITS.DEFAULT_STALE_LEASE_MS);
  const batchSize = overrideOrEnv(overrides, 'batchSize', 'SUPPORT_EMAIL_BATCH_SIZE', LIMITS.DEFAULT_BATCH_SIZE);
  const maxAttachmentBytes = overrideOrEnv(overrides, 'maxAttachmentBytes', 'SUPPORT_EMAIL_MAX_ATTACHMENT_BYTES', LIMITS.MAX_ATTACHMENT_BYTES);
  const maxMessageAttachmentBytes = overrideOrEnv(
    overrides,
    'maxMessageAttachmentBytes',
    'SUPPORT_EMAIL_MAX_MESSAGE_ATTACHMENT_BYTES',
    LIMITS.MAX_MESSAGE_ATTACHMENT_BYTES
  );
  const attachmentRetentionDays = overrideOrEnv(overrides, 'attachmentRetentionDays', 'SUPPORT_EMAIL_ATTACHMENT_RETENTION_DAYS', 90);
  const extractedTextRetentionDays = overrideOrEnv(
    overrides,
    'extractedTextRetentionDays',
    'SUPPORT_EMAIL_EXTRACTED_TEXT_RETENTION_DAYS',
    180
  );

  if (!Number.isFinite(maxDurationMs) || !Number.isFinite(lockMarginMs) || maxDurationMs < lockMarginMs + 1000) {
    throw unsafe('unsafe_processing_config');
  }
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 200) throw unsafe('unsafe_processing_config');
  if (!Number.isFinite(maxAttachmentBytes) || maxAttachmentBytes < 1 || maxAttachmentBytes > LIMITS.MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw unsafe('unsafe_processing_config');
  }
  if (extractedTextRetentionDays < attachmentRetentionDays) throw unsafe('unsafe_processing_config');

  const timeBudgetMs = Math.min(requestedBudget, maxDurationMs - lockMarginMs);
  const leaseMs = Math.max(requestedLease, maxDurationMs + lockMarginMs);
  if (timeBudgetMs < 1000 || timeBudgetMs >= maxDurationMs || leaseMs < maxDurationMs + lockMarginMs) {
    throw unsafe('unsafe_processing_config');
  }

  return {
    enabled,
    batchSize,
    timeBudgetMs,
    leaseMs,
    maxDurationMs,
    lockMarginMs,
    maxAttachmentBytes,
    maxMessageAttachmentBytes,
    maxPdfPages: overrideOrEnv(overrides, 'maxPdfPages', 'SUPPORT_EMAIL_MAX_PDF_PAGES', LIMITS.MAX_PDF_PAGES),
    maxBodyTextLength: LIMITS.MAX_BODY_TEXT_LENGTH,
    maxBodyHtmlSnippetLength: LIMITS.MAX_BODY_HTML_SNIPPET_LENGTH,
    confidenceThreshold: Object.prototype.hasOwnProperty.call(overrides, 'confidenceThreshold')
      ? overrides.confidenceThreshold
      : numberInRange('SUPPORT_EMAIL_CONFIDENCE_THRESHOLD', LIMITS.DEFAULT_CONFIDENCE_THRESHOLD, 0, 1),
    sheetId: Object.prototype.hasOwnProperty.call(overrides, 'sheetId')
      ? String(overrides.sheetId || '')
      : String(process.env.SUPPORT_EMAIL_SHEET_ID || ''),
    sheetTab: overrides.sheetTab || process.env.SUPPORT_EMAIL_SHEET_TAB || 'Tickets',
    maxZipEntries: overrides.maxZipEntries || 100,
    maxZipEntryBytes: overrides.maxZipEntryBytes || (8 * 1024 * 1024),
    maxZipUncompressedBytes: overrides.maxZipUncompressedBytes || (20 * 1024 * 1024),
    maxZipCompressionRatio: overrides.maxZipCompressionRatio || 100,
    maxExtractedChars: overrides.maxExtractedChars || 100000,
    maxPromptAttachmentChars: 12000,
    attachmentRetentionDays,
    extractedTextRetentionDays,
    attachmentRetentionMs: attachmentRetentionDays * 24 * 60 * 60 * 1000,
    extractedTextRetentionMs: extractedTextRetentionDays * 24 * 60 * 60 * 1000,
    tempMaxAgeMs: overrideOrEnv(overrides, 'tempMaxAgeMs', 'SUPPORT_EMAIL_TEMP_MAX_AGE_MS', 60 * 60 * 1000),
    retentionBatchSize: overrideOrEnv(overrides, 'retentionBatchSize', 'SUPPORT_EMAIL_RETENTION_BATCH_SIZE', 25),
    workerId: overrides.workerId || `phase3-${process.pid}`
  };
}

module.exports = {
  getProcessingConfig,
  isBulkProcessingEnabled
};
