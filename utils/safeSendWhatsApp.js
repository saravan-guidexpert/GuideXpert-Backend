/**
 * Non-blocking WhatsApp send with FormSubmission retry fields + WhatsAppMessageEvent audit row.
 * Reserves WhatsAppMessageEvent (queued) before provider send when retryGroupId + attemptNumber are set.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const FormSubmission = require('../models/FormSubmission');
const WhatsAppMessageEvent = require('../models/WhatsAppMessageEvent');
const WhatsAppRetryGroup = require('../models/WhatsAppRetryGroup');
const { getTemplateMetaForKind } = require('./whatsappTemplateMeta');
const { parseGupshupTemplateSendResponse } = require('./gupshupMessageIds');
const {
  retrySourceFromAttemptNumber,
  isImmediateOnlyStrategy,
  isRetryableFailure,
  isCampaignStrategy,
  getRetryPolicy,
  RETRY_EXCLUSION_REASON
} = require('./whatsappRetryRules');
const { getCampaignReminderEligibility, CAMPAIGN_RELATIVE_KINDS } = require('./waReminderEligibility');
const { extractGupshupSendErrorCode } = require('./gupshupProviderErrors');
const {
  resolveCampaignSlotInstant,
  buildEligibilityTimingRecord,
  logCampaignTimingBlocked,
  logCampaignTimingInvariantViolation
} = require('./waCampaignSendAssertion');
const { reserveOutboundWhatsAppAttempt } = require('./waSendAttemptReservation');
const { maybeCrash } = require('./waTestCrash');
const { normalizeOutboundOpsProduct } = require('./whatsappOpsProduct');
const { isIitSlotBookedTemplateEnvKey } = require('./iitCounsellingWhatsApp');
const {
  classifyGupshupSendOutcome,
  buildAwaitingReconcileFields,
  isAmbiguousGupshupSendError,
  isIitSlotBookedSend
} = require('./gupshupSendOutcome');

function maskPhone(phone10) {
  const s = String(phone10 || '').replace(/\D/g, '');
  const last4 = s.slice(-4);
  return last4.length === 4 ? `****${last4}` : '****';
}

function summarizeVars(vars) {
  const src = vars && typeof vars === 'object' ? vars : {};
  const keys = Object.keys(src);
  const preview = {};
  keys.forEach((k) => {
    const v = src[k];
    preview[k] = v == null ? 0 : String(v).trim().length;
  });
  return { keys, lengths: preview };
}

function providerPayloadSnippet(result, max = 1000) {
  if (!result || result.data == null) return null;
  try {
    const s = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return null;
  }
}

function mapSourceToGroupTrigger(source) {
  switch (source) {
    case 'save_step3':
      return 'save_step3';
    case 'cron':
      return 'cron';
    case 'retry_cron':
      return 'cron';
    case 'admin_manual':
      return 'manual';
    case 'retry_api':
      return 'retry_api';
    case 'one_on_one_submit':
      return 'one_on_one_submit';
    case 'guidance_booking_submit':
      return 'guidance_booking_submit';
    case 'guidance_counsellor_booking_notify':
      return 'guidance_counsellor_booking_notify';
    case 'jee_mock_test_submit':
      return 'jee_mock_test_submit';
    default:
      return 'manual';
  }
}

async function resolveRetryGroupId({ retryGroupId, messageKind, cronRunId, source }) {
  if (retryGroupId && mongoose.Types.ObjectId.isValid(String(retryGroupId))) {
    return new mongoose.Types.ObjectId(String(retryGroupId));
  }
  const g = await WhatsAppRetryGroup.create({
    messageKind,
    cronRunId: cronRunId || null,
    trigger: mapSourceToGroupTrigger(source),
    status: 'open'
  });
  return g._id;
}

function toOidMaybe(value) {
  if (value != null && mongoose.Types.ObjectId.isValid(String(value))) {
    return new mongoose.Types.ObjectId(String(value));
  }
  return null;
}

function buildMessageEventPayload({
  phone10,
  subId,
  retryKind,
  cronRunId,
  cronJobKey,
  source,
  templateIdEnvKey,
  templateId,
  messageId,
  ids,
  payloadSnippet,
  now,
  status,
  retrySnap,
  errText,
  sendErrorCode,
  retryGroupId,
  attemptNumber,
  parentOid,
  attemptBatchOid,
  retrySourceLabel,
  retryEligible,
  correlationId,
  canonicalRetryGroupId,
  terminalFailureKind,
  retryExclusionReason,
  opsProduct,
  cohortSlotInstantUtc,
  iitCounsellingSubmissionId,
  oneOnOneCounselingLeadId,
  mockTestLeadId,
  eligibilityTiming
}) {
  return {
    phone: phone10,
    formSubmissionId: subId,
    iitCounsellingSubmissionId: iitCounsellingSubmissionId || null,
    oneOnOneCounselingLeadId: oneOnOneCounselingLeadId || null,
    mockTestLeadId: mockTestLeadId || null,
    cohortSlotInstantUtc: cohortSlotInstantUtc || null,
    opsProduct: opsProduct || 'guidexpert',
    messageKind: retryKind,
    cronRunId: cronRunId || null,
    cronJobKey: cronJobKey || null,
    source,
    templateIdEnvKey,
    templateId,
    gupshupMessageId: messageId,
    gupshupInternalMessageId: ids.gupshupInternalMessageId || null,
    whatsappWaMessageId: ids.whatsappWaMessageId || null,
    providerAcceptedAt: status === 'submitted' || messageId ? now : null,
    providerPayloadSnippet: payloadSnippet,
    status,
    retryCountSnapshot: retrySnap,
    errorMessage: errText ? errText.slice(0, 2000) : null,
    sendErrorCode: sendErrorCode || null,
    retryGroupId,
    canonicalRetryGroupId: canonicalRetryGroupId || null,
    attemptNumber,
    parentMessageEventId: parentOid,
    attemptBatchId: attemptBatchOid,
    retrySource: retrySourceLabel,
    retryEligible,
    terminalFailureKind: terminalFailureKind || null,
    retryExclusionReason: retryExclusionReason || null,
    correlationId: correlationId || null,
    ...(eligibilityTiming && typeof eligibilityTiming === 'object' ? { eligibilityTiming } : {})
  };
}

async function persistAttemptEvent(payload, reservedEventId) {
  const nowUp = new Date();
  if (reservedEventId && mongoose.Types.ObjectId.isValid(String(reservedEventId))) {
    const { _id, ...rest } = payload;
    await WhatsAppMessageEvent.updateOne(
      { _id: new mongoose.Types.ObjectId(String(reservedEventId)) },
      { $set: { ...rest, updatedAt: nowUp } }
    );
    return;
  }
  const key = {
    retryGroupId: payload.retryGroupId,
    phone: payload.phone,
    attemptNumber: payload.attemptNumber
  };
  if (payload.attemptNumber > 1 && payload.retryGroupId) {
    await WhatsAppMessageEvent.updateOne(
      key,
      {
        $set: payload,
        $setOnInsert: { createdAt: payload.createdAt || nowUp }
      },
      { upsert: true }
    );
    return;
  }
  await WhatsAppMessageEvent.create(payload);
}

/**
 * @param {object} opts
 * @param {string} opts.phone10
 * @param {string} [opts.formSubmissionId]
 * @param {object} opts.vars
 * @param {'slot_booked'|'pre4hr'|'meet'|'30min'} opts.retryKind
 * @param {'save_step3'|'cron'|'retry_cron'|'admin_manual'|'retry_api'} opts.source
 * @param {import('mongoose').Types.ObjectId|null} [opts.cronRunId]
 * @param {string|null} [opts.cronJobKey]
 * @param {(phone10: string, vars: object, sendOpts?: { correlationId?: string }) => Promise<{ success: boolean, data?: object, error?: string }>} opts.sendFn
 * @param {import('mongoose').Types.ObjectId|null} [opts.retryGroupId]
 * @param {number} [opts.attemptNumber]
 * @param {import('mongoose').Types.ObjectId|null} [opts.parentMessageEventId]
 * @param {import('mongoose').Types.ObjectId|null} [opts.attemptBatchId]
 * @param {string|null} [opts.correlationId]
 * @param {'guidexpert'|'iit_counselling'} [opts.opsProduct]
 * @param {Date|null} [opts.cohortSlotInstantUtc] booking instant for cohort analytics (IIT / non-FormSubmission)
 * @param {string|import('mongoose').Types.ObjectId|null} [opts.iitCounsellingSubmissionId]
 * @param {string|null} [opts.explicitTemplateEnvKey] process.env key name override (e.g. IIT slot_booked template)
 * @returns {Promise<{ success: boolean, error?: string, retryGroupId?: import('mongoose').Types.ObjectId, idempotent?: boolean, duplicateInFlight?: boolean, skippedOutsideWindow?: boolean, blockedPreSend?: boolean }>}
 */
async function safeSendWhatsApp({
  phone10,
  formSubmissionId,
  vars,
  retryKind,
  source,
  cronRunId,
  cronJobKey,
  sendFn,
  retryGroupId: retryGroupIdOpt,
  attemptNumber: attemptNumberOpt,
  parentMessageEventId,
  attemptBatchId: attemptBatchIdOpt,
  correlationId: correlationIdOpt,
  canonicalRetryGroupId: canonicalRetryGroupIdOpt,
  opsProduct: opsProductOpt,
  cohortSlotInstantUtc,
  iitCounsellingSubmissionId,
  oneOnOneCounselingLeadId,
  mockTestLeadId,
  explicitTemplateEnvKey,
  now: nowOpt
}) {
  const nowBase = nowOpt instanceof Date ? nowOpt : new Date();
  const outboundProduct = normalizeOutboundOpsProduct(opsProductOpt);
  const trimTemplateKey = typeof explicitTemplateEnvKey === 'string' ? explicitTemplateEnvKey.trim() : '';
  let templateIdEnvKey;
  let templateId;
  if (trimTemplateKey) {
    templateIdEnvKey = trimTemplateKey;
    templateId = process.env[trimTemplateKey] || null;
  } else {
    ({ templateIdEnvKey, templateId } = getTemplateMetaForKind(retryKind));
  }
  const varSummary = summarizeVars(vars);

  const attNum = Math.min(6, Math.max(1, parseInt(String(attemptNumberOpt ?? 1), 10) || 1));
  const retrySourceLabel = retrySourceFromAttemptNumber(attNum);
  const correlationId = correlationIdOpt || crypto.randomUUID();
  const canonicalOid = toOidMaybe(canonicalRetryGroupIdOpt);
  const iitSubOid = toOidMaybe(iitCounsellingSubmissionId);
  const oneOnOneLeadOid = toOidMaybe(oneOnOneCounselingLeadId);
  const mockTestLeadOid = toOidMaybe(mockTestLeadId);
  const cohortSlotUtc =
    cohortSlotInstantUtc instanceof Date && !Number.isNaN(cohortSlotInstantUtc.getTime())
      ? cohortSlotInstantUtc
      : null;
  const gxSideEffects = outboundProduct === 'guidexpert';
  let resolvedGroupId = null;
  let reservedEventId = null;
  /** Latest resolved slot instant for campaign eligibility + persisted diagnostics */
  let slotCampaignForTiming = null;

  try {
    if (typeof sendFn !== 'function') {
      console.warn('[WhatsApp]', maskPhone(phone10), `type=${retryKind}`, 'sendFn missing');
      return { success: false, error: 'sendFn missing' };
    }

    resolvedGroupId = await resolveRetryGroupId({
      retryGroupId: retryGroupIdOpt,
      messageKind: retryKind,
      cronRunId,
      source
    });
    const parentOid = toOidMaybe(parentMessageEventId);
    let attemptBatchOid = toOidMaybe(attemptBatchIdOpt);
    if (!attemptBatchOid && attNum === 1 && cronRunId) {
      attemptBatchOid = toOidMaybe(cronRunId);
    }

    const iitImageHeader = isIitSlotBookedTemplateEnvKey(templateIdEnvKey);
    console.log(
      '[WhatsApp] attempt',
      maskPhone(phone10),
      `type=${retryKind}`,
      `attempt=${attNum}`,
      `group=${String(resolvedGroupId)}`,
      `templateKey=${templateIdEnvKey || 'n/a'}`,
      `templateId=${templateId || 'missing'}`,
      `headerType=${iitImageHeader ? 'image' : 'none'}`,
      `hasImageHeader=${iitImageHeader}`,
      `vars=${JSON.stringify(varSummary)}`
    );
    if (!templateId) {
      console.warn('[WhatsApp] template missing', maskPhone(phone10), `type=${retryKind}`, templateIdEnvKey || 'unknown');
    }
    const emptyKeys = varSummary.keys.filter((k) => (varSummary.lengths[k] || 0) === 0);
    if (emptyKeys.length > 0) {
      console.warn('[WhatsApp] empty var values', maskPhone(phone10), `type=${retryKind}`, emptyKeys.join(','));
    }

    if (CAMPAIGN_RELATIVE_KINDS.has(retryKind)) {
      slotCampaignForTiming = await resolveCampaignSlotInstant({
        formSubmissionId,
        phone10,
        cohortSlotInstantUtc: cohortSlotUtc
      });
      const eligFirst = getCampaignReminderEligibility(retryKind, slotCampaignForTiming, nowBase);
      if (!eligFirst.ok) {
        console.warn('[WhatsApp] skipped_outside_validity', maskPhone(phone10), `type=${retryKind}`, eligFirst.reason || '');
        return {
          success: false,
          error: eligFirst.reason || 'outside_reminder_validity',
          skippedOutsideWindow: true,
          retryGroupId: resolvedGroupId
        };
      }
    }

    let subId = formSubmissionId;
    if (!subId && outboundProduct === 'guidexpert') {
      const sub = await FormSubmission.findOne({ phone: phone10 }).select('_id').lean();
      subId = sub ? sub._id : null;
    }

    const reserveResult = await reserveOutboundWhatsAppAttempt({
      retryGroupId: resolvedGroupId,
      phone10,
      attemptNumber: attNum,
      messageKind: retryKind,
      formSubmissionId: subId,
      source,
      cronRunId,
      cronJobKey,
      templateIdEnvKey,
      templateId,
      parentMessageEventId: parentOid,
      attemptBatchId: attemptBatchOid,
      retrySourceLabel,
      canonicalRetryGroupId: canonicalOid,
      correlationId,
      opsProduct: outboundProduct,
      cohortSlotInstantUtc: cohortSlotUtc,
      iitCounsellingSubmissionId: iitSubOid,
      oneOnOneCounselingLeadId: oneOnOneLeadOid,
      mockTestLeadId: mockTestLeadOid,
      now: nowBase
    });

    if (reserveResult.outcome === 'already_terminal') {
      return { success: true, idempotent: true, retryGroupId: resolvedGroupId };
    }
    if (reserveResult.outcome === 'duplicate_in_flight') {
      return {
        success: false,
        duplicateInFlight: true,
        error: 'duplicate_in_flight',
        retryGroupId: resolvedGroupId
      };
    }
    if (reserveResult.outcome === 'blocked_duplicate_attempt') {
      return {
        success: false,
        error: 'attempt_already_recorded',
        retryGroupId: resolvedGroupId
      };
    }
    reservedEventId = reserveResult.reservedEventId || null;

    if (CAMPAIGN_RELATIVE_KINDS.has(retryKind)) {
      slotCampaignForTiming = await resolveCampaignSlotInstant({
        formSubmissionId: subId,
        phone10,
        cohortSlotInstantUtc: cohortSlotUtc
      });
      const nowGate = nowBase;
      const eligPre = getCampaignReminderEligibility(retryKind, slotCampaignForTiming, nowGate);
      if (!eligPre.ok) {
        const timingBlock = buildEligibilityTimingRecord(retryKind, slotCampaignForTiming, nowGate);
        logCampaignTimingBlocked({
          retryKind,
          source,
          attempt: attNum,
          reason: eligPre.reason,
          slotMs: slotCampaignForTiming ? new Date(slotCampaignForTiming).getTime() : null,
          nowMs: nowGate.getTime(),
          earliestMs: eligPre.earliestAt ? eligPre.earliestAt.getTime() : null,
          reservedEventId: reservedEventId ? String(reservedEventId) : null,
          maskPhone: maskPhone(phone10)
        });
        if (reservedEventId && mongoose.Types.ObjectId.isValid(String(reservedEventId))) {
          await WhatsAppMessageEvent.updateOne(
            { _id: new mongoose.Types.ObjectId(String(reservedEventId)) },
            {
              $set: {
                status: 'failed',
                errorMessage: `eligibility_timing_blocked_pre_send:${eligPre.reason || 'unknown'}`,
                retryEligible: false,
                retryExclusionReason: RETRY_EXCLUSION_REASON.eligibilityTimingBlocked,
                retryExclusionAt: nowGate,
                eligibilityTiming: timingBlock,
                updatedAt: nowGate,
                failedAt: nowGate
              }
            }
          );
        }
        return {
          success: false,
          error: eligPre.reason || 'eligibility_timing_blocked_pre_send',
          skippedOutsideWindow: true,
          blockedPreSend: true,
          retryGroupId: resolvedGroupId
        };
      }
    }

    const result = await sendFn(phone10, vars, {
      correlationId,
      ...(trimTemplateKey ? { templateEnvKey: trimTemplateKey } : {})
    });
    const now = nowBase;
    const sendOutcome = classifyGupshupSendOutcome(result, {
      retryKind,
      outboundProduct,
      templateIdEnvKey
    });
    if (sendOutcome.treatAsAccepted) {
      maybeCrash('after_provider_accept');
    }
    const ids = sendOutcome.ids;
    const messageId = sendOutcome.messageId;
    const payloadSnippet = providerPayloadSnippet(result);
    if (sendOutcome.treatAsAccepted && !messageId) {
      console.warn('[WhatsApp] send_ok_but_no_provider_id', {
        mask: maskPhone(phone10),
        type: retryKind,
        templateId: templateId || null,
        templateKey: templateIdEnvKey || null,
        reason: sendOutcome.reason
      });
    }

    if (sendOutcome.treatAsAccepted) {
      let retrySnapOnSuccess = 0;
      let eligibilityTimingPayload = null;
      if (CAMPAIGN_RELATIVE_KINDS.has(retryKind)) {
        eligibilityTimingPayload = buildEligibilityTimingRecord(retryKind, slotCampaignForTiming, now);
        if (
          eligibilityTimingPayload &&
          (eligibilityTimingPayload.sentTooEarly || eligibilityTimingPayload.sentAfterExpiry)
        ) {
          logCampaignTimingInvariantViolation({
            retryKind,
            source,
            attempt: attNum,
            maskPhone: maskPhone(phone10),
            correlationId,
            eligibilityTiming: eligibilityTimingPayload
          });
        }
      }
      if (gxSideEffects) {
        const prior = await FormSubmission.findOne({ phone: phone10 }).select('whatsappRetryCount').lean();
        retrySnapOnSuccess =
          prior && Number.isFinite(prior.whatsappRetryCount) ? prior.whatsappRetryCount : 0;

        const setDoc = {
          whatsappRetryCount: 0,
          whatsappRetryKind: null,
          lastWhatsappAttemptAt: now,
          whatsappLastError: null
        };
        if (messageId) {
          setDoc.whatsappLastMessageId = messageId;
        }
        await FormSubmission.updateOne({ phone: phone10 }, { $set: setDoc });
      }

      const successPayload = buildMessageEventPayload({
        phone10,
        subId,
        retryKind,
        cronRunId,
        cronJobKey,
        source,
        templateIdEnvKey,
        templateId,
        messageId,
        ids,
        payloadSnippet,
        now,
        status: sendOutcome.useAwaitingReconcile ? 'awaiting_final_dlr' : 'submitted',
        retrySnap: retrySnapOnSuccess,
        errText: sendOutcome.useAwaitingReconcile ? sendOutcome.errText : null,
        retryGroupId: resolvedGroupId,
        attemptNumber: attNum,
        parentOid,
        attemptBatchOid,
        retrySourceLabel,
        retryEligible: false,
        correlationId,
        canonicalRetryGroupId: canonicalOid,
        terminalFailureKind: null,
        retryExclusionReason: null,
        opsProduct: outboundProduct,
        cohortSlotInstantUtc: cohortSlotUtc,
        iitCounsellingSubmissionId: iitSubOid,
        oneOnOneCounselingLeadId: oneOnOneLeadOid,
        mockTestLeadId: mockTestLeadOid,
        eligibilityTiming: eligibilityTimingPayload
      });
      if (sendOutcome.useAwaitingReconcile) {
        Object.assign(successPayload, buildAwaitingReconcileFields(now));
      }
      await persistAttemptEvent(successPayload, reservedEventId);

      console.log(
        '[WhatsApp] success',
        maskPhone(phone10),
        `type=${retryKind}`,
        sendOutcome.useAwaitingReconcile ? 'awaiting_dlr' : 'submitted',
        sendOutcome.reason || ''
      );
      if (CAMPAIGN_RELATIVE_KINDS.has(retryKind) && resolvedGroupId) {
        try {
          const { syncReminderJobFromRetryGroup } = require('../services/whatsappReminderJobSync');
          await syncReminderJobFromRetryGroup(resolvedGroupId);
        } catch {
          /* non-fatal projection */
        }
      }
      maybeCrash('after_db_write');
      return { success: true, retryGroupId: resolvedGroupId };
    }

    const errText = sendOutcome.errText || (result && result.error ? String(result.error) : 'send failed');
    const providerDebug = providerPayloadSnippet(result, 500) || '';
    const sendHttpStatus =
      result && Number.isFinite(Number(result.httpStatus)) ? Number(result.httpStatus) : null;
    const sendErrorCode = extractGupshupSendErrorCode(result && result.data, sendHttpStatus);

    let snap = attNum > 1 ? attNum - 1 : null;
    if (gxSideEffects && attNum === 1) {
      const subBefore = await FormSubmission.findOneAndUpdate(
        { phone: phone10 },
        {
          $inc: { whatsappRetryCount: 1 },
          $set: {
            whatsappRetryKind: retryKind,
            lastWhatsappAttemptAt: now,
            whatsappLastError: errText.slice(0, 2000)
          }
        },
        { new: true, select: 'whatsappRetryCount' }
      );
      snap = subBefore ? subBefore.whatsappRetryCount : null;
    }

    const immediateOnly = isImmediateOnlyStrategy(retryKind);
    const transientRetryable = isRetryableFailure(retryKind, { errorText: errText });
    const policy = getRetryPolicy(retryKind);
    const maxA = Number(policy.maxAttempts) || 3;

    let derivedStatus = 'failed';
    let rowRetryEligible = true;
    let terminalFailureKind = null;
    let permExcl = null;

    if (immediateOnly) {
      derivedStatus =
        (immediateOnly && attNum >= 2) || (!transientRetryable && immediateOnly) || attNum >= maxA
          ? 'retry_exhausted'
          : 'failed';
      rowRetryEligible = attNum === 1 && transientRetryable;
    } else if (isCampaignStrategy(retryKind)) {
      if (!transientRetryable) {
        derivedStatus = 'failed';
        rowRetryEligible = false;
        terminalFailureKind = 'permanent';
        permExcl = RETRY_EXCLUSION_REASON.permanentFailure;
      } else if (attNum >= maxA) {
        derivedStatus = 'retry_exhausted';
        rowRetryEligible = false;
      } else {
        derivedStatus = 'failed';
        rowRetryEligible = true;
      }
    } else {
      derivedStatus = attNum >= maxA ? 'retry_exhausted' : 'failed';
      rowRetryEligible = attNum < maxA;
    }

    const failEligibilityTiming =
      CAMPAIGN_RELATIVE_KINDS.has(retryKind) && slotCampaignForTiming
        ? buildEligibilityTimingRecord(retryKind, slotCampaignForTiming, now)
        : null;

      await persistAttemptEvent(
        buildMessageEventPayload({
          phone10,
          subId,
          retryKind,
          cronRunId,
          cronJobKey,
          source,
          templateIdEnvKey,
          templateId,
          messageId: ids.canonicalMessageId || null,
          ids,
          payloadSnippet: providerDebug || null,
          now,
          status: derivedStatus,
          retrySnap: snap,
          errText,
          sendErrorCode,
          retryGroupId: resolvedGroupId,
          attemptNumber: attNum,
          parentOid,
          attemptBatchOid,
          retrySourceLabel,
          retryEligible: rowRetryEligible,
          correlationId,
          canonicalRetryGroupId: canonicalOid,
          terminalFailureKind,
          retryExclusionReason: permExcl,
          opsProduct: outboundProduct,
          cohortSlotInstantUtc: cohortSlotUtc,
          iitCounsellingSubmissionId: iitSubOid,
          oneOnOneCounselingLeadId: oneOnOneLeadOid,
          mockTestLeadId: mockTestLeadOid,
          eligibilityTiming: failEligibilityTiming
        }),
        reservedEventId
      );

    console.warn(
      '[WhatsApp] failure',
      maskPhone(phone10),
      `type=${retryKind}`,
      errText,
      providerDebug ? `provider=${providerDebug}` : ''
    );
    if (isCampaignStrategy(retryKind) && resolvedGroupId) {
      try {
        const { syncReminderJobFromRetryGroup } = require('../services/whatsappReminderJobSync');
        await syncReminderJobFromRetryGroup(resolvedGroupId);
      } catch {
        /* non-fatal projection */
      }
      if (derivedStatus === 'failed' && rowRetryEligible && attNum === 1) {
        try {
          const { scheduleAttempt1RetryPromotion } = require('../services/whatsappRetryOrchestrator');
          await scheduleAttempt1RetryPromotion(resolvedGroupId, retryKind, now);
        } catch {
          /* non-fatal promotion schedule */
        }
      }
    }
    return { success: false, error: errText, retryGroupId: resolvedGroupId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'unknown error';
    const now = new Date();
    if (
      isIitSlotBookedSend(retryKind, outboundProduct, templateIdEnvKey) &&
      isAmbiguousGupshupSendError(msg) &&
      reservedEventId
    ) {
      try {
        const ambiguousPayload = buildMessageEventPayload({
          phone10,
          subId: formSubmissionId,
          retryKind,
          cronRunId,
          cronJobKey,
          source,
          templateIdEnvKey,
          templateId,
          messageId: null,
          ids: {},
          payloadSnippet: null,
          now,
          status: 'awaiting_final_dlr',
          retrySnap: null,
          errText: msg.slice(0, 2000),
          retryGroupId: resolvedGroupId,
          attemptNumber: attNum,
          parentOid: toOidMaybe(parentMessageEventId),
          attemptBatchOid: toOidMaybe(attemptBatchIdOpt),
          retrySourceLabel,
          retryEligible: false,
          correlationId,
          canonicalRetryGroupId: canonicalOid,
          terminalFailureKind: null,
          retryExclusionReason: null,
          opsProduct: outboundProduct,
          cohortSlotInstantUtc: cohortSlotUtc,
          iitCounsellingSubmissionId: iitSubOid,
          oneOnOneCounselingLeadId: oneOnOneLeadOid,
          mockTestLeadId: mockTestLeadOid,
          eligibilityTiming: null
        });
        Object.assign(ambiguousPayload, buildAwaitingReconcileFields(now));
        await persistAttemptEvent(ambiguousPayload, reservedEventId);
        console.warn('[WhatsApp] IIT ambiguous exception — awaiting DLR', maskPhone(phone10), msg);
        return { success: true, retryGroupId: resolvedGroupId, ambiguousAwaitingDlr: true };
      } catch (ambigPersistErr) {
        console.warn('[WhatsApp] ambiguous persist failed', ambigPersistErr.message);
      }
    }
    try {
      if (!resolvedGroupId) {
        resolvedGroupId = await resolveRetryGroupId({
          retryGroupId: retryGroupIdOpt,
          messageKind: retryKind,
          cronRunId,
          source
        });
      }
      const parentOidInner = toOidMaybe(parentMessageEventId);
      let attemptBatchOidInner = toOidMaybe(attemptBatchIdOpt);
      if (!attemptBatchOidInner && attNum === 1 && cronRunId) {
        attemptBatchOidInner = toOidMaybe(cronRunId);
      }

      let subId = formSubmissionId;
      if (!subId && outboundProduct === 'guidexpert') {
        const sub = await FormSubmission.findOne({ phone: phone10 }).select('_id').lean();
        subId = sub ? sub._id : null;
      }

      let snap = attNum > 1 ? attNum - 1 : null;
      if (gxSideEffects && attNum === 1) {
        const subBefore = await FormSubmission.findOneAndUpdate(
          { phone: phone10 },
          {
            $inc: { whatsappRetryCount: 1 },
            $set: {
              whatsappRetryKind: retryKind,
              lastWhatsappAttemptAt: now,
              whatsappLastError: msg.slice(0, 2000)
            }
          },
          { new: true, select: 'whatsappRetryCount' }
        );
        snap = subBefore ? subBefore.whatsappRetryCount : null;
      }

      const immediateOnly = isImmediateOnlyStrategy(retryKind);
      const transientRetryable = isRetryableFailure(retryKind, { errorText: msg });
      const policy = getRetryPolicy(retryKind);
      const maxA = Number(policy.maxAttempts) || 3;
      let evtStatus = 'failed';
      let rowRetryEligible = true;
      let terminalFailureKind = null;
      let permExcl = null;
      if (immediateOnly) {
        evtStatus =
          (immediateOnly && attNum >= 2) || (!transientRetryable && immediateOnly) || attNum >= maxA
            ? 'retry_exhausted'
            : 'failed';
        rowRetryEligible = attNum === 1 && transientRetryable;
      } else if (isCampaignStrategy(retryKind)) {
        if (!transientRetryable) {
          evtStatus = 'failed';
          rowRetryEligible = false;
          terminalFailureKind = 'permanent';
          permExcl = RETRY_EXCLUSION_REASON.permanentFailure;
        } else if (attNum >= maxA) {
          evtStatus = 'retry_exhausted';
          rowRetryEligible = false;
        } else {
          evtStatus = 'failed';
          rowRetryEligible = true;
        }
      } else {
        evtStatus = attNum >= maxA ? 'retry_exhausted' : 'failed';
        rowRetryEligible = attNum < maxA;
      }

      const catchEligibilityTiming =
        CAMPAIGN_RELATIVE_KINDS.has(retryKind) && slotCampaignForTiming
          ? buildEligibilityTimingRecord(retryKind, slotCampaignForTiming, now)
          : null;

      await persistAttemptEvent(
        buildMessageEventPayload({
          phone10,
          subId,
          retryKind,
          cronRunId,
          cronJobKey,
          source,
          templateIdEnvKey,
          templateId,
          messageId: null,
          ids: {},
          payloadSnippet: null,
          now,
          status: evtStatus,
          retrySnap: snap,
          errText: msg,
          retryGroupId: resolvedGroupId,
          attemptNumber: attNum,
          parentOid: parentOidInner,
          attemptBatchOid: attemptBatchOidInner,
          retrySourceLabel,
          retryEligible: rowRetryEligible,
          correlationId,
          canonicalRetryGroupId: canonicalOid,
          terminalFailureKind,
          retryExclusionReason: permExcl,
          opsProduct: outboundProduct,
          cohortSlotInstantUtc: cohortSlotUtc,
          iitCounsellingSubmissionId: iitSubOid,
          oneOnOneCounselingLeadId: oneOnOneLeadOid,
          mockTestLeadId: mockTestLeadOid,
          eligibilityTiming: catchEligibilityTiming
        }),
        reservedEventId
      );
    } catch (inner) {
      console.warn('[WhatsApp] failure', maskPhone(phone10), `type=${retryKind}`, msg, '| persist:', inner.message);
      return { success: false, error: msg };
    }
    console.warn('[WhatsApp] failure', maskPhone(phone10), `type=${retryKind}`, msg);
    return { success: false, error: msg };
  }
}

module.exports = {
  safeSendWhatsApp
};
