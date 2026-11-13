'use strict';

const {
  normalizeInternetMessageId,
  normalizeEmailAddress,
  normalizeSubject,
  buildContentHash
} = require('./dedupeService');
const { LIMITS } = require('../../constants/supportEmail');

/**
 * Strips basic HTML markup to produce plain text while avoiding heavy external dependencies.
 */
function stripHtmlToText(html = '') {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/p>|<\/div>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalizes an individual email recipient object from Microsoft Graph.
 */
function normalizeRecipient(rawRecipient = {}) {
  const emailObj = rawRecipient.emailAddress || rawRecipient;
  const name = typeof emailObj.name === 'string' ? emailObj.name.trim() : '';
  const address = normalizeEmailAddress(emailObj.address || '');
  return { name, address };
}

/**
 * Normalizes a recipient list (toRecipients, ccRecipients, bccRecipients).
 */
function normalizeRecipientList(rawList = []) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(normalizeRecipient)
    .filter((r) => r.address.length > 0);
}

/**
 * Normalizes a raw Microsoft Graph message JSON into SupportEmail document attributes.
 *
 * @param {Object} graphMessage Raw Microsoft Graph message JSON
 * @param {Object} [context]
 * @param {string} [context.mailbox] Target mailbox address
 * @param {string} [context.folder='inbox'] Target folder name
 * @returns {Object} Normalized attributes matching SupportEmail schema
 */
function normalizeGraphMessage(graphMessage = {}, context = {}) {
  if (!graphMessage.id) {
    throw new Error('[messageNormalizationService] Missing required graphMessage.id');
  }

  // Handle Graph delta deletion / move events (@removed)
  // Official Microsoft Graph documentation: when an item leaves a folder, Graph returns @removed.
  // When supplied, Graph provides reason 'deleted'. Delta removal event alone CANNOT distinguish
  // moved vs permanently deleted. We preserve the raw Graph reason, do not default missing or
  // malformed reasons to 'deleted', and record inInbox: false.
  if (graphMessage['@removed']) {
    let graphRemovalReason;
    const removedVal = graphMessage['@removed'];

    if (typeof removedVal === 'object' && removedVal !== null && !Array.isArray(removedVal)) {
      if (typeof removedVal.reason === 'string') {
        const trimmed = removedVal.reason.trim();
        graphRemovalReason = trimmed ? trimmed : 'missing';
      } else if ('reason' in removedVal) {
        // reason field exists but is not a string (e.g. null, number, boolean)
        graphRemovalReason = 'malformed';
      } else {
        // object without 'reason' property, e.g. @removed: {}
        graphRemovalReason = 'missing';
      }
    } else if (typeof removedVal === 'string') {
      const trimmed = removedVal.trim();
      graphRemovalReason = trimmed ? trimmed : 'missing';
    } else {
      // primitive non-string (e.g. @removed: true, @removed: 1)
      graphRemovalReason = 'malformed';
    }

    return {
      graphMessageId: String(graphMessage.id).trim(),
      isRemoved: true,
      inInbox: false,
      graphRemovalReason,
      removalReason: graphRemovalReason,
      receivedDateTime: new Date(),
      metadata: {
        mailbox: context.mailbox ? context.mailbox.toLowerCase() : '',
        folder: context.folder || 'inbox',
        isRemoved: true,
        inInbox: false,
        graphRemovalReason,
        removalReason: graphRemovalReason
      }
    };
  }

  const graphMessageId = String(graphMessage.id).trim();
  const internetMessageId = normalizeInternetMessageId(graphMessage.internetMessageId);
  const conversationId = graphMessage.conversationId ? String(graphMessage.conversationId).trim() : null;

  // Strict validation: receivedDateTime must be present and a valid date
  // Do NOT silently default invalid or missing timestamps to current time
  if (!graphMessage.receivedDateTime) {
    throw new Error('[messageNormalizationService] Missing required receivedDateTime');
  }
  const isIsoString = typeof graphMessage.receivedDateTime === 'string'
    ? /^\d{4}-\d{2}-\d{2}/.test(graphMessage.receivedDateTime)
    : graphMessage.receivedDateTime instanceof Date;
  const rawReceived = new Date(graphMessage.receivedDateTime);
  if (!isIsoString || isNaN(rawReceived.getTime())) {
    throw new Error(`[messageNormalizationService] Malformed receivedDateTime: "${graphMessage.receivedDateTime}"`);
  }
  const receivedDateTime = rawReceived;

  const rawSent = graphMessage.sentDateTime ? new Date(graphMessage.sentDateTime) : null;
  const sentDateTime = rawSent && !isNaN(rawSent.getTime()) ? rawSent : null;

  const from = normalizeRecipient(graphMessage.from);
  const toRecipients = normalizeRecipientList(graphMessage.toRecipients);
  const ccRecipients = normalizeRecipientList(graphMessage.ccRecipients);

  const subject = typeof graphMessage.subject === 'string'
    ? graphMessage.subject.trim().slice(0, 1000)
    : '';

  const bodyPreview = typeof graphMessage.bodyPreview === 'string'
    ? graphMessage.bodyPreview.trim().slice(0, 1000)
    : '';

  // Extract bounded bodyText and bodyHtmlSnippet
  let bodyText = '';
  let bodyHtmlSnippet = '';
  const rawBody = graphMessage.body?.content || '';
  const contentType = (graphMessage.body?.contentType || '').toLowerCase();

  if (contentType === 'html') {
    bodyText = stripHtmlToText(rawBody).slice(0, LIMITS.MAX_BODY_TEXT_LENGTH);
    bodyHtmlSnippet = rawBody.slice(0, LIMITS.MAX_BODY_HTML_SNIPPET_LENGTH);
  } else if (contentType === 'text') {
    bodyText = rawBody.slice(0, LIMITS.MAX_BODY_TEXT_LENGTH);
  }

  // Fallback to bodyPreview if bodyText is empty
  if (!bodyText && bodyPreview) {
    bodyText = bodyPreview.slice(0, LIMITS.MAX_BODY_TEXT_LENGTH);
  }

  const hasAttachments = Boolean(graphMessage.hasAttachments);
  const attachmentCount = Array.isArray(graphMessage.attachments)
    ? graphMessage.attachments.length
    : (hasAttachments ? 1 : 0);

  // Compute canonical contentHash for exact duplicate detection
  const contentHash = buildContentHash({
    from: from.address,
    subject,
    bodyText,
    attachmentShas: []
  });

  return {
    graphMessageId,
    internetMessageId,
    conversationId,
    receivedDateTime,
    sentDateTime,
    from,
    toRecipients,
    ccRecipients,
    subject,
    bodyPreview,
    bodyText,
    bodyHtmlSnippet,
    hasAttachments,
    attachmentCount,
    contentHash,
    metadata: {
      mailbox: context.mailbox ? context.mailbox.toLowerCase() : '',
      folder: context.folder || 'inbox',
      importance: graphMessage.importance || 'normal',
      isRead: Boolean(graphMessage.isRead),
      isDraft: Boolean(graphMessage.isDraft),
      webLink: graphMessage.webLink || null,
      isRemoved: false,
      inInbox: true
    }
  };
}

module.exports = {
  stripHtmlToText,
  normalizeRecipient,
  normalizeRecipientList,
  normalizeGraphMessage
};

