/**
 * Durable reservation for WhatsApp outbound attempts (retryGroupId + phone + attemptNumber).
 * Guarantees at most one provider sendFn per logical attempt under concurrent workers / crashes.
 */
const mongoose = require('mongoose');
const WhatsAppMessageEvent = require('../models/WhatsAppMessageEvent');
const { normalizeOutboundOpsProduct } = require('./whatsappOpsProduct');
const {
  TERMINAL_FAILURE_STATUSES,
  RETRY_TERMINAL_SUCCESS_STATUSES,
  RECONCILE_PENDING_STATUSES,
  inFlightPromotionStaleMsForKind
} = require('./whatsappRetryRules');

function toOid(value) {
  if (value != null && mongoose.Types.ObjectId.isValid(String(value))) {
    return new mongoose.Types.ObjectId(String(value));
  }
  return null;
}

/**
 * @param {object} p
 * @returns {Promise<{ outcome: string, reservedEventId: import('mongoose').Types.ObjectId|null }>}
 * outcome: inserted_queued | reclaimed | proceed_retry_pending | already_terminal |
 *          duplicate_in_flight | blocked_duplicate_attempt | no_group
 */
async function reserveOutboundWhatsAppAttempt(p) {
  const {
    retryGroupId,
    phone10,
    attemptNumber,
    messageKind,
    formSubmissionId,
    source,
    cronRunId,
    cronJobKey,
    templateIdEnvKey,
    templateId,
    parentMessageEventId,
    attemptBatchId,
    retrySourceLabel,
    canonicalRetryGroupId,
    correlationId,
    opsProduct,
    cohortSlotInstantUtc,
    iitCounsellingSubmissionId,
    oneOnOneCounselingLeadId,
    mockTestLeadId
  } = p;

  const gid = toOid(retryGroupId);
  if (!gid) {
    return { outcome: 'no_group', reservedEventId: null };
  }

  const attNum = Math.min(6, Math.max(1, parseInt(String(attemptNumber || 1), 10) || 1));
  const key = { retryGroupId: gid, phone: phone10, attemptNumber: attNum };
  const staleMs = inFlightPromotionStaleMsForKind(messageKind);
  const now = p.now instanceof Date ? p.now : new Date();
  const nowMs = now.getTime();
  const staleBefore = new Date(nowMs - staleMs);
  const parentOid = parentMessageEventId && mongoose.Types.ObjectId.isValid(String(parentMessageEventId))
    ? new mongoose.Types.ObjectId(String(parentMessageEventId))
    : null;
  const batchOid =
    attemptBatchId && mongoose.Types.ObjectId.isValid(String(attemptBatchId))
      ? new mongoose.Types.ObjectId(String(attemptBatchId))
      : null;
  const canonOid =
    canonicalRetryGroupId && mongoose.Types.ObjectId.isValid(String(canonicalRetryGroupId))
      ? new mongoose.Types.ObjectId(String(canonicalRetryGroupId))
      : null;
  const subOid =
    formSubmissionId && mongoose.Types.ObjectId.isValid(String(formSubmissionId))
      ? new mongoose.Types.ObjectId(String(formSubmissionId))
      : null;
  const iitSubOid =
    iitCounsellingSubmissionId && mongoose.Types.ObjectId.isValid(String(iitCounsellingSubmissionId))
      ? new mongoose.Types.ObjectId(String(iitCounsellingSubmissionId))
      : null;
  const oneOnOneLeadOid =
    oneOnOneCounselingLeadId && mongoose.Types.ObjectId.isValid(String(oneOnOneCounselingLeadId))
      ? new mongoose.Types.ObjectId(String(oneOnOneCounselingLeadId))
      : null;
  const mockTestLeadOid =
    mockTestLeadId && mongoose.Types.ObjectId.isValid(String(mockTestLeadId))
      ? new mongoose.Types.ObjectId(String(mockTestLeadId))
      : null;
  const slotUtc =
    cohortSlotInstantUtc instanceof Date && !Number.isNaN(cohortSlotInstantUtc.getTime())
      ? cohortSlotInstantUtc
      : null;

  const baseQueuedFields = {
    phone: phone10,
    messageKind,
    cronRunId: cronRunId && mongoose.Types.ObjectId.isValid(String(cronRunId))
      ? new mongoose.Types.ObjectId(String(cronRunId))
      : null,
    cronJobKey: cronJobKey || null,
    source,
    templateIdEnvKey: templateIdEnvKey || null,
    templateId: templateId || null,
    formSubmissionId: subOid,
    iitCounsellingSubmissionId: iitSubOid,
    oneOnOneCounselingLeadId: oneOnOneLeadOid,
    mockTestLeadId: mockTestLeadOid,
    cohortSlotInstantUtc: slotUtc,
    opsProduct: normalizeOutboundOpsProduct(opsProduct),
    parentMessageEventId: parentOid,
    attemptBatchId: batchOid,
    retrySource: retrySourceLabel || 'initial',
    canonicalRetryGroupId: canonOid,
    correlationId: correlationId || null,
    retryEligible: false,
    retryExclusionReason: null,
    retryExclusionAt: null,
    createdAt: now,
    updatedAt: now
  };

  let doc = await WhatsAppMessageEvent.findOne(key).lean();

  const interpretExisting = (d) => {
    if (!d) return null;
    const st = String(d.status || '').toLowerCase();
    if (RETRY_TERMINAL_SUCCESS_STATUSES.includes(st)) {
      return { outcome: 'already_terminal', reservedEventId: d._id };
    }
    if (st === 'retry_pending') {
      return { outcome: 'proceed_retry_pending', reservedEventId: d._id };
    }
    if (st === 'queued') {
      const created = new Date(d.createdAt || 0).getTime();
      if (nowMs - created < staleMs) {
        return { outcome: 'duplicate_in_flight', reservedEventId: d._id };
      }
      return { type: 'reclaim', doc: d };
    }
    if (RECONCILE_PENDING_STATUSES.includes(st)) {
      return { outcome: 'blocked_duplicate_attempt', reservedEventId: d._id };
    }
    if (TERMINAL_FAILURE_STATUSES.includes(st)) {
      return { outcome: 'blocked_duplicate_attempt', reservedEventId: d._id };
    }
    return { outcome: 'blocked_duplicate_attempt', reservedEventId: d._id };
  };

  if (doc) {
    const r = interpretExisting(doc);
    if (r && r.type === 'reclaim') {
      const reclaimed = await WhatsAppMessageEvent.findOneAndUpdate(
        { _id: doc._id, status: 'queued', createdAt: { $lte: staleBefore } },
        {
          $set: {
            correlationId: correlationId || doc.correlationId,
            updatedAt: now
          }
        },
        { new: true }
      ).lean();
      if (!reclaimed) {
        return { outcome: 'duplicate_in_flight', reservedEventId: doc._id };
      }
      return { outcome: 'reclaimed', reservedEventId: reclaimed._id };
    }
    if (r && r.outcome) return r;
  }

  try {
    const created = await WhatsAppMessageEvent.create({
      ...key,
      ...baseQueuedFields,
      status: 'queued',
      gupshupMessageId: null,
      gupshupInternalMessageId: null,
      whatsappWaMessageId: null,
      providerAcceptedAt: null,
      providerPayloadSnippet: null,
      errorMessage: null,
      retryCountSnapshot: null,
      terminalFailureKind: null
    });
    return { outcome: 'inserted_queued', reservedEventId: created._id };
  } catch (e) {
    if (e && e.code === 11000) {
      const again = await WhatsAppMessageEvent.findOne(key).lean();
      const r2 = interpretExisting(again);
      if (r2 && r2.type === 'reclaim') {
        const reclaimed = await WhatsAppMessageEvent.findOneAndUpdate(
          { _id: again._id, status: 'queued', createdAt: { $lte: staleBefore } },
          { $set: { correlationId: correlationId || again.correlationId, updatedAt: now } },
          { new: true }
        ).lean();
        if (reclaimed) return { outcome: 'reclaimed', reservedEventId: reclaimed._id };
      }
      if (r2 && !r2.type) return r2;
      return { outcome: 'duplicate_in_flight', reservedEventId: again ? again._id : null };
    }
    throw e;
  }
}

module.exports = {
  reserveOutboundWhatsAppAttempt
};
