/**
 * Admin-driven recovery for unresolved recipients of a single template.
 *
 * Targets:
 *   - terminal failures (failed | retry_exhausted)
 *   - retry exclusions (any retryExclusionReason set)
 *   - long-lived in-flight rows (queued | retry_pending) older than threshold
 *
 * Skips:
 *   - phones with provider-accepted+ status for same template (within UI window)
 *   - same within configurable global lookback
 *   - phones with an in-flight (queued/retry_pending) or success row newer than the
 *     candidate's last failure (avoids racing automated retry slices)
 *
 * Sends via existing safeSendWhatsApp with source: 'admin_manual' so the audit
 * trail and webhook reconciliation continue to work via WhatsAppMessageEvent.
 */
const mongoose = require('mongoose');
const WhatsAppMessageEvent = require('../models/WhatsAppMessageEvent');
const WhatsAppManualRecoveryJob = require('../models/WhatsAppManualRecoveryJob');
const WhatsAppRetryGroup = require('../models/WhatsAppRetryGroup');
const FormSubmission = require('../models/FormSubmission');
const IitCounsellingSubmission = require('../models/IitCounsellingSubmission');
const OneOnOneCounselingLead = require('../models/OneOnOneCounselingLead');
const MockTestLead = require('../models/MockTestLead');
const GuidanceSlot = require('../models/GuidanceSlot');
const gupshupService = require('./gupshupService');
const { sendIitReminderWhatsApp } = require('./gupshupService');
const { safeSendWhatsApp } = require('../utils/safeSendWhatsApp');
const { buildSlotNotificationVariables } = require('../utils/slotNotificationFormatters');
const {
  isIitReminderMessageKind,
  resolveIitReminderTemplateEnvKey,
  resolveIitSlotBookedTemplateEnvKey,
} = require('../utils/iitCounsellingWhatsApp');
const { parseOpsProductQuery } = require('../utils/whatsappOpsProduct');
const {
  buildOneOnOneSubmitVars,
  parsePreferredSlotInstantUtc,
  GUPSHUP_TEMPLATE_ONE_ON_ONE_CONFIRM,
} = require('../utils/oneOnOneCounselingWhatsApp');
const {
  buildGuidanceBookingSubmitVars,
  parseGuidanceSlotInstantUtc,
  GUPSHUP_TEMPLATE_GUIDANCE_BOOKING_CONFIRM,
} = require('../utils/guidanceBookingWhatsApp');
const {
  buildJeeMockTestSubmitVars,
  ensureJeeMockTestTemplateEnv,
  resolveJeeMockTestTemplate,
  GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER,
} = require('../utils/jeeMockTestWhatsApp');
const {
  buildOpsScopedEventMatch,
  validateMessageKindForOpsProduct,
} = require('../utils/whatsappOpsEventMatch');
const { resolveProviderErrorDisplay } = require('../utils/gupshupProviderErrors');
const {
  TERMINAL_FAILURE_STATUSES,
  RETRY_TERMINAL_SUCCESS_STATUSES,
  DLR_DELIVERED_STATUSES,
  IN_FLIGHT_PROMOTION_STATUSES,
  RECONCILE_PENDING_STATUSES,
  RECONCILE_RECOVERY_RISK_WARNING,
  isManualRecoveryBlocked,
  isRiskyReconcileRecovery
} = require('../utils/whatsappRetryRules');

const ALLOWED_MESSAGE_KINDS = WhatsAppMessageEvent.WHATSAPP_MESSAGE_KINDS;

const IIT_LABEL_TO_SLOT_ID = {
  'Wednesday 6PM': 'WEDNESDAY_6PM',
  'Saturday 6PM': 'SATURDAY_6PM',
  'Sunday 11AM': 'SUNDAY_11AM',
};

function getInFlightStaleMs() {
  const min = parseInt(process.env.WHATSAPP_RECOVERY_INFLIGHT_STALE_MINUTES || '180', 10) || 180;
  return min * 60 * 1000;
}

function getGlobalLookbackDays() {
  const d = parseInt(process.env.WHATSAPP_MANUAL_RECOVERY_SUCCESS_LOOKBACK_DAYS || '7', 10);
  return Number.isFinite(d) && d > 0 ? d : 7;
}

function dispatchKindToSendFn(kind) {
  switch (kind) {
    case 'slot_booked':
      return gupshupService.sendSlotBookedWhatsApp;
    case 'pre4hr':
      return gupshupService.sendPre4HrReminderWhatsApp;
    case 'meet':
      return gupshupService.sendMeetLinkWhatsApp;
    case '30min':
      return gupshupService.sendReminder30MinWhatsApp;
    case 'iit_pre2hr':
    case 'iit_pre45min':
    case 'iit_pre15min':
      return (phone10, vars, sendOpts) => sendIitReminderWhatsApp(phone10, vars, sendOpts || {});
    case 'one_on_one_submit':
      return gupshupService.sendOneOnOneSubmitWhatsApp;
    case 'guidance_booking_submit':
      return gupshupService.sendGuidanceBookingSubmitWhatsApp;
    case 'jee_mock_test_submit':
      return gupshupService.sendJeeMockTestSubmitWhatsApp;
    default:
      return null;
  }
}

async function resolveRecipientForRecovery({ phone, messageKind, opsProduct, lineage }) {
  const slug = parseOpsProductQuery(opsProduct);
  const useOneOnOne =
    slug === 'one_on_one_counseling' && messageKind === 'one_on_one_submit';
  const useGuidanceBooking =
    slug === 'guidance_booking' && messageKind === 'guidance_booking_submit';
  const useJeeMockTest =
    slug === 'jee_mock_test' && messageKind === 'jee_mock_test_submit';
  const useIit =
    slug === 'iit_counselling' &&
    (isIitReminderMessageKind(messageKind) || messageKind === 'slot_booked');

  if (useOneOnOne) {
    let lead = null;
    if (
      lineage?.oneOnOneCounselingLeadId &&
      mongoose.Types.ObjectId.isValid(String(lineage.oneOnOneCounselingLeadId))
    ) {
      lead = await OneOnOneCounselingLead.findById(lineage.oneOnOneCounselingLeadId).lean();
    }
    if (!lead) {
      lead = await OneOnOneCounselingLead.findOne({ mobileNumber: phone })
        .sort({ createdAt: -1 })
        .lean();
    }
    if (!lead) return { error: 'missing_one_on_one_lead' };
    return { iitSub: null, formSub: null, oneOnOneLead: lead, guidanceSlot: null, opsProduct: 'one_on_one_counseling' };
  }

  if (useGuidanceBooking) {
    let lead = null;
    if (
      lineage?.oneOnOneCounselingLeadId &&
      mongoose.Types.ObjectId.isValid(String(lineage.oneOnOneCounselingLeadId))
    ) {
      lead = await OneOnOneCounselingLead.findById(lineage.oneOnOneCounselingLeadId).lean();
    }
    if (!lead) {
      lead = await OneOnOneCounselingLead.findOne({ mobileNumber: phone })
        .sort({ createdAt: -1 })
        .lean();
    }
    if (!lead) return { error: 'missing_guidance_booking_lead' };
    let slot = null;
    if (lead.selectedSlotId) {
      slot = await GuidanceSlot.findById(lead.selectedSlotId).lean();
    }
    if (!slot) return { error: 'missing_guidance_slot' };
    return {
      iitSub: null,
      formSub: null,
      oneOnOneLead: lead,
      guidanceSlot: slot,
      opsProduct: 'guidance_booking',
    };
  }

  if (useJeeMockTest) {
    let lead = null;
    if (lineage?.mockTestLeadId && mongoose.Types.ObjectId.isValid(String(lineage.mockTestLeadId))) {
      lead = await MockTestLead.findById(lineage.mockTestLeadId).lean();
    }
    if (!lead) {
      lead = await MockTestLead.findOne({
        formCompleted: true,
        $or: [{ whatsappNumber: phone }, { contactNumber: phone }],
      })
        .sort({ submittedAt: -1 })
        .lean();
    }
    if (!lead) return { error: 'missing_mock_test_lead' };
    return {
      iitSub: null,
      formSub: null,
      oneOnOneLead: null,
      guidanceSlot: null,
      mockTestLead: lead,
      opsProduct: 'jee_mock_test',
    };
  }

  if (useIit) {
    let iitSub = null;
    if (lineage?.iitCounsellingSubmissionId && mongoose.Types.ObjectId.isValid(String(lineage.iitCounsellingSubmissionId))) {
      iitSub = await IitCounsellingSubmission.findById(lineage.iitCounsellingSubmissionId).lean();
    }
    if (!iitSub) {
      iitSub = await IitCounsellingSubmission.findOne({ phone }).sort({ createdAt: -1 }).lean();
    }
    if (!iitSub) return { error: 'missing_iit_submission' };
    return { iitSub, formSub: null, oneOnOneLead: null, guidanceSlot: null, opsProduct: 'iit_counselling' };
  }

  let formSub = null;
  if (lineage?.formSubmissionId && mongoose.Types.ObjectId.isValid(String(lineage.formSubmissionId))) {
    formSub = await FormSubmission.findById(lineage.formSubmissionId).lean();
  }
  if (!formSub) {
    formSub = await FormSubmission.findOne({ phone }).lean();
  }
  if (!formSub) return { error: 'missing_form_submission' };
  return { iitSub: null, formSub, oneOnOneLead: null, guidanceSlot: null, opsProduct: 'guidexpert' };
}

/**
 * Pure aggregation that returns one representative row per unresolved phone.
 * @param {{ messageKind: string, fromAt?: Date|null, toAt?: Date|null }} opts
 */
async function buildPreview({
  messageKind,
  fromAt = null,
  toAt = null,
  opsProduct = null,
  preferredLanguage = null,
}) {
  if (!ALLOWED_MESSAGE_KINDS.includes(messageKind)) {
    return { error: `Invalid messageKind. Allowed: ${ALLOWED_MESSAGE_KINDS.join(', ')}` };
  }
  const kindErr = validateMessageKindForOpsProduct(messageKind, opsProduct);
  if (kindErr) return { error: kindErr };

  const scoped = await buildOpsScopedEventMatch({ messageKind, opsProduct, preferredLanguage });
  if (scoped.error) return { error: scoped.error };
  if (scoped.empty) {
    return {
      data: {
        candidates: [],
        candidatesByReason: {},
        targeted: 0,
        skippedAlreadyDelivered: 0,
        skippedGlobalRecentSuccess: 0,
        skippedInFlightDuplicate: 0,
        skippedReconcileGrace: 0,
        skippedReconcilePending: 0,
        skippedAwaitingFinalDlr: 0,
        riskyCount: 0,
      },
    };
  }

  const match = scoped.match;
  /** For "delivered in UI window" we still scope success events to the same date bounds. */
  const windowCreatedRange = (fromAt || toAt)
    ? { ...(fromAt ? { $gte: fromAt } : {}), ...(toAt ? { $lte: toAt } : {}) }
    : null;

  const inFlightStaleBefore = new Date(Date.now() - getInFlightStaleMs());

  /**
   * Pick one representative event per phone:
   *   - prefer rows with terminal failure / retry_exhausted (rank 3)
   *   - else rows with retryExclusionReason set (rank 2)
   *   - else stale in-flight rows (rank 1)
   *   - tiebreaker: latest createdAt
   */
  const rows = await WhatsAppMessageEvent.aggregate([
    { $match: match },
    {
      $addFields: {
        lineageId: { $ifNull: ['$canonicalRetryGroupId', '$retryGroupId'] },
        unresolvedRank: {
          $cond: [
            { $in: ['$status', TERMINAL_FAILURE_STATUSES] }, 3,
            { $cond: [
              { $ne: ['$retryExclusionReason', null] }, 2,
              { $cond: [
                {
                  $and: [
                    { $in: ['$status', IN_FLIGHT_PROMOTION_STATUSES] },
                    { $lte: ['$createdAt', inFlightStaleBefore] }
                  ]
                }, 1, 0
              ] }
            ] }
          ]
        }
      }
    },
    { $match: { unresolvedRank: { $gt: 0 } } },
    { $sort: { phone: 1, unresolvedRank: -1, createdAt: -1 } },
    {
      $group: {
        _id: '$phone',
        eventId: { $first: '$_id' },
        retryGroupId: { $first: '$retryGroupId' },
        lineageId: { $first: '$lineageId' },
        maxAttemptAtStart: { $max: '$attemptNumber' },
        attemptNumber: { $first: '$attemptNumber' },
        status: { $first: '$status' },
        retryExclusionReason: { $first: '$retryExclusionReason' },
        reconcileDerivedFailure: { $first: '$reconcileDerivedFailure' },
        reconcileFinalityUntil: { $first: '$reconcileFinalityUntil' },
        errorMessage: { $first: '$errorMessage' },
        webhookErrorCode: { $first: '$webhookErrorCode' },
        sendErrorCode: { $first: '$sendErrorCode' },
        webhookErrorReason: { $first: '$webhookErrorReason' },
        providerPayloadSnippet: { $first: '$providerPayloadSnippet' },
        formSubmissionId: { $first: '$formSubmissionId' },
        iitCounsellingSubmissionId: { $first: '$iitCounsellingSubmissionId' },
        oneOnOneCounselingLeadId: { $first: '$oneOnOneCounselingLeadId' },
        createdAt: { $first: '$createdAt' },
        unresolvedRank: { $first: '$unresolvedRank' }
      }
    }
  ]);

  const rowInPreviewWindow = (r) => {
    if (!fromAt && !toAt) return true;
    const t = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
    if (Number.isNaN(t)) return false;
    if (fromAt && t < fromAt.getTime()) return false;
    if (toAt && t > toAt.getTime()) return false;
    return true;
  };
  const rowsFiltered = rows.filter(rowInPreviewWindow);

  if (!rowsFiltered.length) {
    return {
      data: {
        candidates: [],
        candidatesByReason: {},
        targeted: 0,
        skippedAlreadyDelivered: 0,
        skippedGlobalRecentSuccess: 0,
        skippedInFlightDuplicate: 0,
        skippedReconcileGrace: 0,
        skippedReconcilePending: 0,
        skippedAwaitingFinalDlr: 0,
        riskyCount: 0
      }
    };
  }

  const allPhones = rowsFiltered.map((r) => r._id).filter(Boolean);
  const now = new Date();

  const reconcileBlockedPhones = allPhones.length
    ? await WhatsAppMessageEvent.distinct('phone', {
        messageKind,
        phone: { $in: allPhones },
        $or: [
          { status: { $in: RECONCILE_PENDING_STATUSES } },
          { reconcileFinalityUntil: { $gt: now } }
        ]
      })
    : [];
  const reconcileBlockedSet = new Set(reconcileBlockedPhones);

  /** Phones already resolved within the same UI window (window-scoped exclusion) */
  const windowSuccess = await WhatsAppMessageEvent.distinct('phone', {
    messageKind,
    ...(windowCreatedRange ? { createdAt: windowCreatedRange } : {}),
    phone: { $in: allPhones },
    status: { $in: RETRY_TERMINAL_SUCCESS_STATUSES }
  });
  const windowSuccessSet = new Set(windowSuccess);

  /** Phones already resolved globally within lookback (per chosen rule) */
  const lookbackStart = new Date(Date.now() - getGlobalLookbackDays() * 24 * 60 * 60 * 1000);
  const remainingAfterWindow = allPhones.filter((p) => !windowSuccessSet.has(p));
  const globalSuccess = remainingAfterWindow.length
    ? await WhatsAppMessageEvent.distinct('phone', {
        messageKind,
        phone: { $in: remainingAfterWindow },
        status: { $in: RETRY_TERMINAL_SUCCESS_STATUSES },
        createdAt: { $gte: lookbackStart }
      })
    : [];
  const globalSuccessSet = new Set(globalSuccess);

  /** Phones that already have a fresh in-flight or success row newer than candidate's row */
  const newerInFlight = await WhatsAppMessageEvent.aggregate([
    {
      $match: {
        messageKind,
        phone: { $in: allPhones },
        status: { $in: [...IN_FLIGHT_PROMOTION_STATUSES, ...RETRY_TERMINAL_SUCCESS_STATUSES] }
      }
    },
    { $sort: { phone: 1, createdAt: -1 } },
    {
      $group: {
        _id: '$phone',
        latestStatus: { $first: '$status' },
        latestCreatedAt: { $first: '$createdAt' }
      }
    }
  ]);
  const newerInFlightMap = new Map(newerInFlight.map((r) => [r._id, r]));

  const candidates = [];
  let skippedAlreadyDelivered = 0;
  let skippedGlobalRecentSuccess = 0;
  let skippedInFlightDuplicate = 0;
  let skippedReconcileGrace = 0;
  let skippedReconcilePending = 0;
  let skippedAwaitingFinalDlr = 0;
  let riskyCount = 0;
  const candidatesByReason = {};

  rowsFiltered.forEach((r) => {
    const phone = r._id;
    if (!phone) return;

    const rowDoc = {
      status: r.status,
      reconcileDerivedFailure: r.reconcileDerivedFailure,
      reconcileFinalityUntil: r.reconcileFinalityUntil
    };
    if (reconcileBlockedSet.has(phone) || isManualRecoveryBlocked(rowDoc, now)) {
      if (RECONCILE_PENDING_STATUSES.includes(String(r.status || '').toLowerCase())) {
        skippedAwaitingFinalDlr += 1;
      } else {
        skippedReconcileGrace += 1;
      }
      skippedReconcilePending += 1;
      return;
    }

    if (windowSuccessSet.has(phone)) {
      skippedAlreadyDelivered += 1;
      return;
    }
    if (globalSuccessSet.has(phone)) {
      skippedGlobalRecentSuccess += 1;
      return;
    }
    const newer = newerInFlightMap.get(phone);
    if (
      newer &&
      newer.latestCreatedAt &&
      r.createdAt &&
      new Date(newer.latestCreatedAt).getTime() > new Date(r.createdAt).getTime() &&
      !TERMINAL_FAILURE_STATUSES.includes(newer.latestStatus)
    ) {
      skippedInFlightDuplicate += 1;
      return;
    }

    let reason = 'unresolved';
    if (TERMINAL_FAILURE_STATUSES.includes(r.status)) {
      reason = r.status;
    } else if (r.retryExclusionReason) {
      reason = `excluded:${r.retryExclusionReason}`;
    } else if (IN_FLIGHT_PROMOTION_STATUSES.includes(r.status)) {
      reason = `stale_in_flight:${r.status}`;
    }
    candidatesByReason[reason] = (candidatesByReason[reason] || 0) + 1;

    const lineageOid =
      r.lineageId && mongoose.Types.ObjectId.isValid(String(r.lineageId))
        ? new mongoose.Types.ObjectId(String(r.lineageId))
        : r.retryGroupId && mongoose.Types.ObjectId.isValid(String(r.retryGroupId))
          ? new mongoose.Types.ObjectId(String(r.retryGroupId))
          : null;

    const risky = isRiskyReconcileRecovery(rowDoc, now);
    if (risky) riskyCount += 1;

    const providerErr = resolveProviderErrorDisplay({
      webhookErrorCode: r.webhookErrorCode,
      sendErrorCode: r.sendErrorCode,
      webhookErrorReason: r.webhookErrorReason,
      errorMessage: r.errorMessage,
      providerPayloadSnippet: r.providerPayloadSnippet
    });

    candidates.push({
      phone,
      eventId: r.eventId,
      retryGroupId: r.retryGroupId,
      lineageId: lineageOid,
      maxAttemptAtStart: Number(r.maxAttemptAtStart) || Number(r.attemptNumber) || 1,
      attemptNumber: r.attemptNumber,
      status: r.status,
      retryExclusionReason: r.retryExclusionReason,
      reconcileDerivedFailure: r.reconcileDerivedFailure === true,
      errorMessage: providerErr.errorReason || r.errorMessage,
      errorCode: providerErr.errorCode,
      errorReason: providerErr.errorReason,
      errorSource: providerErr.errorSource,
      formSubmissionId: r.formSubmissionId,
      iitCounsellingSubmissionId: r.iitCounsellingSubmissionId,
      oneOnOneCounselingLeadId: r.oneOnOneCounselingLeadId,
      createdAt: r.createdAt,
      reason,
      ...(risky
        ? {
            requiresConfirmation: true,
            riskWarning: RECONCILE_RECOVERY_RISK_WARNING
          }
        : {})
    });
  });

  return {
    data: {
      candidates,
      candidatesByReason,
      targeted: candidates.length,
      riskyCount,
      requiresConfirmation: riskyCount > 0,
      warnings:
        riskyCount > 0
          ? [
              `${riskyCount} recipient(s) require explicit confirmation (${RECONCILE_RECOVERY_RISK_WARNING})`
            ]
          : [],
      skippedAlreadyDelivered,
      skippedGlobalRecentSuccess,
      skippedInFlightDuplicate,
      skippedReconcileGrace,
      skippedReconcilePending,
      skippedAwaitingFinalDlr,
      lookbackDays: getGlobalLookbackDays(),
      inFlightStaleMinutes: Math.round(getInFlightStaleMs() / 60000)
    }
  };
}

/**
 * Re-check a phone right before sending; returns false if it should NOT be sent now
 * (delivered/read globally within lookback, or in-flight row newer than candidate).
 */
async function isStillUnresolved(messageKind, phone, candidateCreatedAt) {
  const now = new Date();
  const reconcileBlock = await WhatsAppMessageEvent.findOne({
    messageKind,
    phone,
    $or: [
      { status: { $in: RECONCILE_PENDING_STATUSES } },
      { reconcileFinalityUntil: { $gt: now } }
    ]
  })
    .select('_id status reconcileFinalityUntil reconcileDerivedFailure')
    .lean();
  if (reconcileBlock && isManualRecoveryBlocked(reconcileBlock, now)) {
    return { ok: false, reason: 'reconcile_grace_active' };
  }

  const lookbackStart = new Date(Date.now() - getGlobalLookbackDays() * 24 * 60 * 60 * 1000);
  const success = await WhatsAppMessageEvent.findOne({
    messageKind,
    phone,
    status: { $in: RETRY_TERMINAL_SUCCESS_STATUSES },
    createdAt: { $gte: lookbackStart }
  })
    .select('_id')
    .lean();
  if (success) return { ok: false, reason: 'already_delivered_or_read' };

  if (candidateCreatedAt) {
    const newer = await WhatsAppMessageEvent.findOne({
      messageKind,
      phone,
      status: { $in: IN_FLIGHT_PROMOTION_STATUSES },
      createdAt: { $gt: new Date(candidateCreatedAt) }
    })
      .sort({ createdAt: -1 })
      .select('_id status')
      .lean();
    if (newer) return { ok: false, reason: 'newer_in_flight' };
  }
  return { ok: true };
}

/**
 * Recompute recovered / inFlight counters from rows created after `job.startedAt` for
 * the candidate phones. Cheap: bounded by job size and a simple aggregate.
 *
 * - recovered = phones with delivered/read row post-start
 * - inFlight = phones with queued/submitted/sent row post-start (and NOT yet recovered or terminal-failed post-start)
 */
async function computePostStartCounters(job) {
  if (!job?.startedAt || !Array.isArray(job.candidatePhones) || !job.candidatePhones.length) {
    return {
      recovered: 0,
      inFlight: 0,
      failed: 0,
      excluded: 0,
      delivered: 0
    };
  }
  const rows = await WhatsAppMessageEvent.aggregate([
    {
      $match: {
        messageKind: job.messageKind,
        phone: { $in: job.candidatePhones },
        createdAt: { $gte: job.startedAt }
      }
    },
    {
      $group: {
        _id: '$phone',
        delivered: { $max: { $cond: [{ $in: ['$status', DLR_DELIVERED_STATUSES] }, 1, 0] } },
        terminalFail: { $max: { $cond: [{ $in: ['$status', TERMINAL_FAILURE_STATUSES] }, 1, 0] } },
        excluded: {
          $max: {
            $cond: [
              {
                $and: [
                  { $ne: ['$retryExclusionReason', null] },
                  { $ne: ['$retryExclusionReason', ''] }
                ]
              },
              1,
              0
            ]
          }
        },
        inFlight: { $max: { $cond: [{ $in: ['$status', IN_FLIGHT_PROMOTION_STATUSES] }, 1, 0] } }
      }
    }
  ]);
  let recovered = 0;
  let inFlight = 0;
  let failed = 0;
  let excluded = 0;
  rows.forEach((r) => {
    if (r.delivered) {
      recovered += 1;
    } else if (r.excluded) {
      excluded += 1;
    } else if (r.terminalFail) {
      failed += 1;
    } else if (r.inFlight) {
      inFlight += 1;
    }
  });
  return {
    recovered,
    inFlight,
    failed,
    excluded,
    delivered: recovered
  };
}

async function executeJob(jobId) {
  const job = await WhatsAppManualRecoveryJob.findById(jobId);
  if (!job) return;
  if (job.status !== 'queued') return;

  job.status = 'running';
  job.startedAt = new Date();
  job.lastProgressAt = new Date();
  await job.save();

  const sendFn = dispatchKindToSendFn(job.messageKind);
  if (typeof sendFn !== 'function') {
    job.status = 'failed';
    job.finishedAt = new Date();
    job.errorSummary = 'Unknown messageKind / sendFn missing';
    await job.save();
    return;
  }

  let batchRetryGroupId = job.batchRetryGroupId;
  if (!batchRetryGroupId) {
    const g = await WhatsAppRetryGroup.create({
      messageKind: job.messageKind,
      trigger: 'manual',
      status: 'open'
    });
    batchRetryGroupId = g._id;
    await WhatsAppManualRecoveryJob.updateOne({ _id: jobId }, { $set: { batchRetryGroupId } });
  }

  const lineageByPhone = new Map();
  (Array.isArray(job.candidateLineage) ? job.candidateLineage : []).forEach((e) => {
    if (e && e.phone) lineageByPhone.set(e.phone, e);
  });

  try {
    const phones = Array.isArray(job.candidatePhones) ? [...job.candidatePhones] : [];
    let attempted = 0;
    let apiAccepted = 0;
    let sendFailed = 0;
    let skippedAlreadyDelivered = job.counters?.skippedAlreadyDelivered || 0;
    let skippedInFlightDuplicate = job.counters?.skippedInFlightDuplicate || 0;
    const skippedGlobalRecentSuccess = job.counters?.skippedGlobalRecentSuccess || 0;

    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < phones.length; i += 1) {
      const fresh = await WhatsAppManualRecoveryJob.findById(jobId).select('cancelRequested').lean();
      if (fresh?.cancelRequested) {
        await WhatsAppManualRecoveryJob.updateOne(
          { _id: jobId },
          {
            $set: {
              status: 'cancelled',
              finishedAt: new Date(),
              lastProgressAt: new Date()
            }
          }
        );
        return;
      }

      const phone = phones[i];
      if (!phone) continue;

      const lineage = lineageByPhone.get(phone) || {};
      const candidateCreatedAt = lineage.candidateCreatedAt || null;
      const guard = await isStillUnresolved(job.messageKind, phone, candidateCreatedAt);
      if (!guard.ok) {
        if (guard.reason === 'already_delivered_or_read') skippedAlreadyDelivered += 1;
        else if (guard.reason === 'newer_in_flight' || guard.reason === 'reconcile_grace_active') {
          skippedInFlightDuplicate += 1;
        }
        await WhatsAppManualRecoveryJob.updateOne(
          { _id: jobId },
          {
            $set: {
              'counters.skippedAlreadyDelivered': skippedAlreadyDelivered,
              'counters.skippedInFlightDuplicate': skippedInFlightDuplicate,
              'counters.remaining': Math.max(0, phones.length - (i + 1)),
              lastProgressAt: new Date()
            }
          }
        );
        continue;
      }

      const resolved = await resolveRecipientForRecovery({
        phone,
        messageKind: job.messageKind,
        opsProduct: job.opsProduct,
        lineage,
      });
      if (resolved.error) {
        sendFailed += 1;
        await WhatsAppManualRecoveryJob.updateOne(
          { _id: jobId },
          {
            $set: {
              'counters.sendFailed': sendFailed,
              'counters.remaining': Math.max(0, phones.length - (i + 1)),
              lastProgressAt: new Date(),
            },
          }
        );
        continue;
      }

      const maxA = Number(lineage.maxAttemptAtStart);
      const maxAttemptStart = Number.isFinite(maxA) && maxA > 0 ? maxA : 1;
      const nextAttempt = Math.min(6, maxAttemptStart + 1);
      const parentId =
        lineage.lastEventId && mongoose.Types.ObjectId.isValid(String(lineage.lastEventId))
          ? lineage.lastEventId
          : null;
      const canon =
        lineage.lineageId && mongoose.Types.ObjectId.isValid(String(lineage.lineageId))
          ? lineage.lineageId
          : null;

      const sendBase = {
        phone10: phone,
        retryKind: job.messageKind,
        source: 'admin_manual',
        cronRunId: null,
        cronJobKey: null,
        sendFn,
        retryGroupId: batchRetryGroupId,
        attemptNumber: nextAttempt,
        parentMessageEventId: parentId,
        canonicalRetryGroupId: canon,
      };

      let r;
      if (resolved.opsProduct === 'iit_counselling' && isIitReminderMessageKind(job.messageKind)) {
        const iitSub = resolved.iitSub;
        const slotBooking = iitSub.iitCounselling?.section1Data?.slotBooking || '';
        const preferredLanguage =
          job.preferredLanguage ||
          iitSub.iitCounselling?.section2Data?.preferredLanguage ||
          '';
        const templateEnvKey = resolveIitReminderTemplateEnvKey({
          slotBooking,
          preferredLanguage,
          reminderKind: job.messageKind,
        });
        const fullName = iitSub.fullName || iitSub.iitCounselling?.section1Data?.fullName || 'Student';
        r = await safeSendWhatsApp({
          ...sendBase,
          formSubmissionId: null,
          iitCounsellingSubmissionId: iitSub._id,
          vars: { name: fullName },
          opsProduct: 'iit_counselling',
          cohortSlotInstantUtc: iitSub.counsellingSlotInstantUtc || null,
          explicitTemplateEnvKey: templateEnvKey || undefined,
        });
      } else if (resolved.opsProduct === 'iit_counselling' && job.messageKind === 'slot_booked') {
        const iitSub = resolved.iitSub;
        const slotBooking = String(iitSub.iitCounselling?.section1Data?.slotBooking || '').trim();
        const iitTplKey = resolveIitSlotBookedTemplateEnvKey(slotBooking);
        const slotIdForTpl = IIT_LABEL_TO_SLOT_ID[slotBooking] || '';
        const fullName = iitSub.fullName || iitSub.iitCounselling?.section1Data?.fullName || 'Student';
        r = await safeSendWhatsApp({
          ...sendBase,
          formSubmissionId: null,
          iitCounsellingSubmissionId: iitSub._id,
          vars: buildSlotNotificationVariables({
            fullName,
            step3Data: {
              slotDate: iitSub.counsellingSlotInstantUtc,
              selectedSlot: slotIdForTpl,
            },
          }),
          opsProduct: 'iit_counselling',
          cohortSlotInstantUtc: iitSub.counsellingSlotInstantUtc || null,
          ...(iitTplKey ? { explicitTemplateEnvKey: iitTplKey } : {}),
        });
      } else if (resolved.opsProduct === 'one_on_one_counseling' && job.messageKind === 'one_on_one_submit') {
        const lead = resolved.oneOnOneLead;
        r = await safeSendWhatsApp({
          ...sendBase,
          formSubmissionId: null,
          vars: buildOneOnOneSubmitVars(lead),
          opsProduct: 'one_on_one_counseling',
          cohortSlotInstantUtc: parsePreferredSlotInstantUtc(lead),
          oneOnOneCounselingLeadId: lead._id,
          explicitTemplateEnvKey: GUPSHUP_TEMPLATE_ONE_ON_ONE_CONFIRM,
        });
      } else if (resolved.opsProduct === 'jee_mock_test' && job.messageKind === 'jee_mock_test_submit') {
        const lead = resolved.mockTestLead;
        const template = resolveJeeMockTestTemplate(lead);
        const templateEnvKey = template
          ? ensureJeeMockTestTemplateEnv(template)
          : GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER;
        r = await safeSendWhatsApp({
          ...sendBase,
          formSubmissionId: null,
          vars: buildJeeMockTestSubmitVars(lead),
          opsProduct: 'jee_mock_test',
          mockTestLeadId: lead._id,
          explicitTemplateEnvKey: templateEnvKey,
          sendFn: (phone, sendVars, sendOpts) =>
            gupshupService.sendJeeMockTestSubmitWhatsApp(phone, sendVars, {
              ...sendOpts,
              templateId: template?.templateId,
              templateEnvKey,
            }),
        });
      } else if (resolved.opsProduct === 'guidance_booking' && job.messageKind === 'guidance_booking_submit') {
        const lead = resolved.oneOnOneLead;
        const slot = resolved.guidanceSlot;
        r = await safeSendWhatsApp({
          ...sendBase,
          formSubmissionId: null,
          vars: buildGuidanceBookingSubmitVars(slot),
          opsProduct: 'guidance_booking',
          cohortSlotInstantUtc: parseGuidanceSlotInstantUtc(slot),
          oneOnOneCounselingLeadId: lead._id,
          explicitTemplateEnvKey: GUPSHUP_TEMPLATE_GUIDANCE_BOOKING_CONFIRM,
        });
      } else {
        const sub = resolved.formSub;
        const withMeetingLink = job.messageKind === 'meet' || job.messageKind === '30min';
        const vars = buildSlotNotificationVariables(sub, { withMeetingLink });
        r = await safeSendWhatsApp({
          ...sendBase,
          formSubmissionId: sub._id,
          vars,
          opsProduct: 'guidexpert',
        });
      }

      attempted += 1;
      if (r && r.success) apiAccepted += 1;
      else sendFailed += 1;

      /** Recompute recovered/inFlight from post-start rows so the UI sees live updates as
       *  webhooks arrive even before the job loop finishes. */
      const post = await computePostStartCounters({
        startedAt: job.startedAt,
        messageKind: job.messageKind,
        candidatePhones: phones
      });

      await WhatsAppManualRecoveryJob.updateOne(
        { _id: jobId },
        {
          $set: {
            'counters.attempted': attempted,
            'counters.apiAccepted': apiAccepted,
            'counters.sendFailed': sendFailed,
            'counters.skippedAlreadyDelivered': skippedAlreadyDelivered,
            'counters.skippedInFlightDuplicate': skippedInFlightDuplicate,
            'counters.skippedGlobalRecentSuccess': skippedGlobalRecentSuccess,
            'counters.remaining': Math.max(0, phones.length - (i + 1)),
            'counters.recovered': post.recovered,
            'counters.inFlight': post.inFlight,
            'counters.delivered': post.delivered,
            'counters.failed': post.failed,
            'counters.excluded': post.excluded,
            lastProgressAt: new Date()
          }
        }
      );
    }
    /* eslint-enable no-await-in-loop */

    /** Final post-start counter refresh after the loop completes; webhooks may
     *  continue to land for a while, so the controller endpoint also recomputes
     *  these on read. */
    const finalPost = await computePostStartCounters({
      startedAt: job.startedAt,
      messageKind: job.messageKind,
      candidatePhones: phones
    });
    await WhatsAppManualRecoveryJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'completed',
          finishedAt: new Date(),
          lastProgressAt: new Date(),
          'counters.remaining': 0,
          'counters.recovered': finalPost.recovered,
          'counters.inFlight': finalPost.inFlight,
          'counters.delivered': finalPost.delivered,
          'counters.failed': finalPost.failed,
          'counters.excluded': finalPost.excluded
        }
      }
    );
  } catch (e) {
    await WhatsAppManualRecoveryJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: (e && e.message ? String(e.message) : 'unknown error').slice(0, 2000),
          lastProgressAt: new Date()
        }
      }
    );
  }
}

/**
 * Helper used by the controller to kick a job off without blocking the request.
 */
function startJobAsync(jobId) {
  setImmediate(() => {
    executeJob(jobId).catch((e) => {
      console.error('[whatsappManualRecovery] executeJob failed', e && e.message ? e.message : e);
    });
  });
}

module.exports = {
  ALLOWED_MESSAGE_KINDS,
  buildPreview,
  executeJob,
  startJobAsync,
  isStillUnresolved,
  computePostStartCounters,
  resolveRecipientForRecovery,
  dispatchKindToSendFn,
};
