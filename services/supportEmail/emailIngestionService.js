'use strict';

const SupportEmail = require('../../models/SupportEmail');
const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const SupportEmailAuditLog = require('../../models/SupportEmailAuditLog');
const queueService = require('./queueService');
const { normalizeGraphMessage } = require('./messageNormalizationService');
const { STAGES } = require('../../constants/supportEmail');

/**
 * Durably records a validation failure / quarantine record for a malformed Graph message.
 *
 * Guarantees:
 * - Sanitized durable record stored in SupportEmailAuditLog.
 * - Idempotent replay: repeated validation failure for same message ID does NOT duplicate records.
 * - Database failures throw immediately, ensuring delta cursor NEVER advances without durable accounting.
 *
 * @param {Object} params
 * @param {Object} params.graphMessage Raw Graph message payload
 * @param {string} params.mailbox Mailbox address
 * @param {string} [params.folder='inbox'] Folder
 * @param {string} params.reason Descriptive failure reason
 * @param {Error} [params.rawError] Original error object
 * @returns {Promise<{ quarantined: boolean, isReplay: boolean, log: Object }>}
 */
async function quarantineInvalidMessage({
  graphMessage,
  mailbox,
  folder = 'inbox',
  reason,
  rawError = null
}) {
  const targetId = String(graphMessage?.id || graphMessage?.internetMessageId || 'unknown_id').trim();
  const sanitizedMetadata = {
    reason: reason || 'Validation failure',
    rawError: rawError ? String(rawError.message || rawError) : null,
    rawReceivedDateTime: graphMessage?.receivedDateTime !== undefined ? graphMessage.receivedDateTime : null,
    mailbox: mailbox ? mailbox.toLowerCase() : '',
    folder: folder || 'inbox',
    subjectPreview: typeof graphMessage?.subject === 'string' ? graphMessage.subject.slice(0, 100) : '',
    internetMessageId: graphMessage?.internetMessageId || null,
    quarantinedAt: new Date()
  };

  // Replay protection: check if already quarantined
  const existing = await SupportEmailAuditLog.findOne({
    action: 'validation_quarantined',
    targetType: 'graph_message',
    targetId
  }).lean();

  if (existing) {
    return {
      quarantined: true,
      isReplay: true,
      log: existing
    };
  }

  // Durable insertion: if database throws here, it bubbles up so cursor does NOT advance
  const log = await SupportEmailAuditLog.create({
    action: 'validation_quarantined',
    targetType: 'graph_message',
    targetId,
    metadata: sanitizedMetadata
  });

  return {
    quarantined: true,
    isReplay: false,
    log
  };
}

/**
 * Retrieves the activation timestamp boundary for a mailbox.
 */
async function getMailboxActivationAt(mailbox) {
  if (!mailbox) return null;
  const policy = await EmailIngestionPolicy.findOne({
    mailbox: mailbox.trim().toLowerCase(),
    enabled: true
  }).lean();
  return policy?.activationAt ? new Date(policy.activationAt) : null;
}

/**
 * Idempotently ingests a single normalized Microsoft Graph message into SupportEmail collection.
 * Enforces the New-Only Boundary: historical emails prior to activationAt are marked isHistorical: true
 * and are NEVER enqueued for downstream AI, ticket, or sheets processing.
 *
 * @param {Object} params
 * @param {Object} params.graphMessage Raw or normalized Graph message
 * @param {string} params.mailbox Target mailbox address
 * @param {string} [params.folder='inbox'] Target folder
 * @param {Date} [params.activationAt] Overriding activation timestamp boundary
 * @param {Object} [params.queueSvc=queueService] Queue service adapter for testing
 * @param {boolean} [params.quarantineOnInvalid=false] Whether to durably quarantine malformed messages instead of throwing
 * @returns {Promise<Object>} Ingestion outcome { ingested: boolean, isHistorical: boolean, isDuplicate: boolean, isQuarantined?: boolean, email: Object|null }
 */
async function ingestEmailMessage({
  graphMessage,
  mailbox,
  folder = 'inbox',
  activationAt = null,
  queueSvc = queueService,
  quarantineOnInvalid = false
}) {
  if (!graphMessage) {
    throw new Error('[emailIngestionService] graphMessage is required');
  }

  // 1. Normalize message attributes with poison-message quarantine protection
  let normalized;
  try {
    normalized = graphMessage.graphMessageId
      ? graphMessage
      : normalizeGraphMessage(graphMessage, { mailbox, folder });

    // Validate receivedDateTime strictly unless it is an @removed deletion event
    if (!normalized.isRemoved) {
      if (!normalized.receivedDateTime || isNaN(new Date(normalized.receivedDateTime).getTime())) {
        throw new Error('[emailIngestionService] Invalid or missing receivedDateTime; refusing to process message');
      }
    }
  } catch (normErr) {
    if (quarantineOnInvalid) {
      const qResult = await quarantineInvalidMessage({
        graphMessage,
        mailbox,
        folder,
        reason: normErr.message,
        rawError: normErr
      });
      return {
        ingested: false,
        isQuarantined: true,
        isHistorical: false,
        isDuplicate: false,
        quarantineLog: qResult.log,
        email: null
      };
    }
    throw normErr;
  }

  // Handle deletion / removal events from delta stream safely
  if (normalized.isRemoved) {
    // If the message already exists in local database, update its removal metadata.
    // CRITICAL: A moved or deleted message in Outlook does NOT delete its SupportTicket,
    // ticket events, or conversation history!
    let existingDoc = null;
    if (normalized.graphMessageId) {
      const current = await SupportEmail.findOne({ graphMessageId: normalized.graphMessageId }).lean();
      if (current) {
        // Keep removal timestamp consistent across replays: preserve existing removedAt.
        // NOTE: removedAt records the wall-clock time the application first observed
        // the removal event, not the actual deletion time in Exchange Online (which Graph omits).
        const removedAt = current.metadata?.removedAt
          ? new Date(current.metadata.removedAt)
          : new Date();

        // Preserve exact removal reason ('deleted', 'missing', 'malformed'); do not default to 'deleted'
        const rawReason = normalized.graphRemovalReason || normalized.removalReason || 'missing';

        existingDoc = await SupportEmail.findOneAndUpdate(
          { graphMessageId: normalized.graphMessageId },
          {
            $set: {
              'metadata.isRemoved': true,
              'metadata.inInbox': false,
              'metadata.graphRemovalReason': rawReason,
              'metadata.removalReason': rawReason,
              'metadata.removedAt': removedAt
            }
          },
          { new: true }
        ).lean();
      }
    }

    return {
      ingested: true,
      isRemoved: true,
      isHistorical: false,
      isDuplicate: false,
      email: existingDoc || null
    };
  }

  // 2. Resolve activation boundary
  const effectiveActivationAt = activationAt || (await getMailboxActivationAt(mailbox));
  const isHistorical = effectiveActivationAt
    ? normalized.receivedDateTime < effectiveActivationAt
    : false;

  const docPayload = {
    ...normalized,
    activationAt: effectiveActivationAt,
    isHistorical,
    pipeline: {
      state: isHistorical ? 'completed' : 'received',
      fetch: isHistorical ? 'fetched' : 'pending',
      attachments: 'pending',
      ai: 'pending',
      ticket: 'pending',
      sheets: 'pending',
      updatedAt: new Date()
    }
  };

  // 3. Idempotently insert into SupportEmail collection with precise index conflict detection
  let emailDoc;
  let isDuplicate = false;

  try {
    emailDoc = await SupportEmail.create(docPayload);
  } catch (err) {
    // Catch unique index collisions
    if (err.code === 11000) {
      const isGraphMessageIdConflict = Boolean(
        err.keyPattern?.graphMessageId ||
        (typeof err.message === 'string' && (err.message.includes('graphMessageId_1_unique') || err.message.includes('graphMessageId:')))
      );

      const isInternetMessageIdConflict = Boolean(
        err.keyPattern?.internetMessageId ||
        (typeof err.message === 'string' && (err.message.includes('internetMessageId_1_unique_partial') || err.message.includes('internetMessageId:')))
      );

      // Only treat a duplicate-key error as an email duplicate when the violated index is actually graphMessageId or internetMessageId
      if (!isGraphMessageIdConflict && !isInternetMessageIdConflict) {
        throw err;
      }

      isDuplicate = true;
      const updateFields = {};
      if (normalized.metadata && typeof normalized.metadata.isRead === 'boolean') {
        updateFields['metadata.isRead'] = normalized.metadata.isRead;
      }

      if (isInternetMessageIdConflict) {
        // Message returned to Inbox with a new ordinary Graph ID, or duplicate RFC 5322 Message-ID
        if (normalized.metadata && normalized.metadata.inInbox === true) {
          updateFields['metadata.inInbox'] = true;
          updateFields['metadata.isRemoved'] = false;
        }
        emailDoc = await SupportEmail.findOneAndUpdate(
          { internetMessageId: normalized.internetMessageId },
          Object.keys(updateFields).length > 0 ? { $set: updateFields } : {},
          { new: true }
        ).lean();
      } else {
        // Exact same Graph ID re-encountered
        if (normalized.metadata && normalized.metadata.inInbox === true) {
          updateFields['metadata.inInbox'] = true;
          updateFields['metadata.isRemoved'] = false;
        }
        emailDoc = await SupportEmail.findOneAndUpdate(
          { graphMessageId: normalized.graphMessageId },
          Object.keys(updateFields).length > 0 ? { $set: updateFields } : {},
          { new: true }
        ).lean();
      }

      if (!emailDoc) {
        throw err; // In unexpected state, re-throw
      }

      return {
        ingested: true,
        isHistorical: Boolean(emailDoc.isHistorical),
        isDuplicate: true,
        email: emailDoc
      };
    }
    throw err;
  }

  // 4. Enqueue initial queue processing job (ONLY for non-historical, non-duplicate emails)
  if (!isHistorical && !isDuplicate) {
    try {
      await queueSvc.enqueueJob({
        emailId: emailDoc._id,
        stage: STAGES.FETCH,
        priority: 0,
        metadata: {
          mailbox: mailbox.toLowerCase(),
          graphMessageId: emailDoc.graphMessageId
        }
      });
    } catch (queueErr) {
      // If job already exists for this stage, enqueueJob handles it idempotently
    }
  }

  return {
    ingested: true,
    isHistorical,
    isDuplicate: false,
    email: emailDoc
  };
}

/**
 * Idempotently ingests a batch of messages from a delta page.
 * Quarantines malformed messages safely to prevent poison-message sync deadlock.
 *
 * @param {Object} params
 * @param {Array<Object>} params.messages Array of Graph messages
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {Date} [params.activationAt]
 * @param {Object} [params.queueSvc]
 * @param {boolean} [params.quarantineOnInvalid=true]
 * @returns {Promise<Object>} Batch summary
 */
async function ingestMessageBatch({
  messages = [],
  mailbox,
  folder = 'inbox',
  activationAt = null,
  queueSvc = queueService,
  quarantineOnInvalid = true
}) {
  if (!Array.isArray(messages)) {
    return { total: 0, ingestedCount: 0, historicalCount: 0, duplicateCount: 0, quarantinedCount: 0, emails: [] };
  }

  const effectiveActivationAt = activationAt || (await getMailboxActivationAt(mailbox));
  const results = [];
  let ingestedCount = 0;
  let historicalCount = 0;
  let duplicateCount = 0;
  let quarantinedCount = 0;

  for (const msg of messages) {
    const outcome = await ingestEmailMessage({
      graphMessage: msg,
      mailbox,
      folder,
      activationAt: effectiveActivationAt,
      queueSvc,
      quarantineOnInvalid
    });

    if (outcome.isQuarantined) {
      quarantinedCount++;
      continue;
    }

    if (outcome.email) {
      results.push(outcome.email);
    }
    if (outcome.isRemoved) {
      // Handled removal
    } else if (outcome.isDuplicate) {
      duplicateCount++;
    } else {
      ingestedCount++;
      if (outcome.isHistorical) {
        historicalCount++;
      }
    }
  }

  return {
    total: messages.length,
    ingestedCount,
    historicalCount,
    duplicateCount,
    quarantinedCount,
    emails: results
  };
}

module.exports = {
  getMailboxActivationAt,
  quarantineInvalidMessage,
  ingestEmailMessage,
  ingestMessageBatch
};

