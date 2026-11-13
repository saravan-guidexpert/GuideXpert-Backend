'use strict';

const crypto = require('crypto');

/**
 * Normalizes an Internet Message-ID (RFC 5322).
 * Strips leading/trailing whitespace and angle brackets `<...>`.
 * Returns null if empty.
 */
function normalizeInternetMessageId(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const cleaned = rawId.trim().replace(/^<+|>+$/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Normalizes an email address (trims and lowercases).
 */
function normalizeEmailAddress(address) {
  if (!address || typeof address !== 'string') return '';
  return address.trim().toLowerCase();
}

/**
 * Normalizes subject line by stripping Re:/Fwd: prefixes and collapsing whitespace.
 */
function normalizeSubject(subject) {
  if (!subject || typeof subject !== 'string') return '';
  return subject
    .replace(/^(\s*(re|fwd|fw):\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Normalizes body text for duplicate hashing (collapses whitespace, trims).
 */
function normalizeBodyText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Builds a deterministic dedupe key for Microsoft Graph webhook notifications.
 *
 * Fixes:
 * 1. Resolves specific resourceId (e.g. from resourceData.id or URL pattern) so that folder-level
 *    subscriptions (e.g. /mailFolders('inbox')/messages) do not generate identical keys for all emails.
 * 2. Incorporates an optional timeBucket to prevent permanent suppression of legitimate future events.
 */
function buildWebhookDedupeKey({ subscriptionId, resource, changeType, resourceId, timeBucket }) {
  if (!subscriptionId || !resource) {
    throw new Error('subscriptionId and resource are required to build webhook dedupe key');
  }

  let resolvedResourceId = resourceId ? String(resourceId).trim() : '';
  if (!resolvedResourceId) {
    // Attempt extracting message ID if resource has format .../messages/{id}
    const match = /\/messages\/([^\/?#]+)/i.exec(resource);
    if (match) {
      resolvedResourceId = match[1].trim();
    }
  }

  const parts = [
    subscriptionId.trim(),
    resource.trim(),
    resolvedResourceId,
    changeType || 'created'
  ];

  if (timeBucket) {
    parts.push(String(timeBucket));
  }

  return parts.join(':');
}

/**
 * Builds a deterministic dedupe key for inbound support email messages.
 */
function buildEmailDedupeKey(graphMessageId, internetMessageId) {
  if (graphMessageId) {
    return `graph:${graphMessageId.trim()}`;
  }
  const normMsgId = normalizeInternetMessageId(internetMessageId);
  if (normMsgId) {
    return `msgid:${normMsgId}`;
  }
  throw new Error('Either graphMessageId or internetMessageId is required to build email dedupe key');
}

/**
 * Computes an epoch-based grouping window for bounding sender+subject ticket deduplication.
 * Default window is 7 days.
 */
function getTicketGroupingWindow(date = new Date(), windowDays = 7) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  const windowMs = Math.max(1, windowDays) * 24 * 60 * 60 * 1000;
  return Math.floor(d.getTime() / windowMs);
}

/**
 * Builds a deterministic ticket dedupe key.
 *
 * 1. Conversation grouping: If conversationId is present, tickets in the same email conversation
 *    are linked together (RFC 5322 / Exchange threading).
 * 2. Bounded grouping window: When conversationId is absent, falls back to sender + normalized
 *    subject, bounded by a time window (default 7 days) to prevent merging unrelated enquiries
 *    sent months apart.
 */
function buildTicketDedupeKey({
  conversationId,
  fromAddress,
  subject,
  receivedDateTime,
  windowDays = 7
}) {
  if (conversationId && typeof conversationId === 'string' && conversationId.trim().length > 0) {
    return `conv:${conversationId.trim()}`;
  }

  const normAddress = normalizeEmailAddress(fromAddress);
  const normSubj = normalizeSubject(subject);
  const canonical = `${normAddress}|${normSubj}`;
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);

  const windowNumber = getTicketGroupingWindow(receivedDateTime, windowDays);
  return `hash:${hash}:w${windowNumber}`;
}

/**
 * Computes a SHA-256 content hash from email contents to detect exact re-sends.
 */
function buildContentHash({ from, subject, bodyText, attachmentShas = [] }) {
  const normFrom = normalizeEmailAddress(typeof from === 'object' ? from?.address : from);
  const normSubj = normalizeSubject(subject);
  const normBody = normalizeBodyText(bodyText);
  const sortedShas = Array.isArray(attachmentShas) ? [...attachmentShas].sort().join(',') : '';

  const payload = `${normFrom}\n${normSubj}\n${normBody}\n${sortedShas}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = {
  normalizeInternetMessageId,
  normalizeEmailAddress,
  normalizeSubject,
  normalizeBodyText,
  buildWebhookDedupeKey,
  buildEmailDedupeKey,
  getTicketGroupingWindow,
  buildTicketDedupeKey,
  buildContentHash
};
