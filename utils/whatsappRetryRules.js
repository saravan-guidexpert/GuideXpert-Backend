/** Statuses counting as terminal failure when choosing retry promotion candidates */
const TERMINAL_FAILURE_STATUSES = ['failed', 'retry_exhausted'];

/** Provider accepted or better — automated retries and promotions must not continue */
const RETRY_TERMINAL_SUCCESS_STATUSES = ['submitted', 'sent', 'delivered', 'read'];

/** Handset delivery / read — funnels and delivery-rate KPIs */
const DLR_DELIVERED_STATUSES = ['delivered', 'read'];

/** Phones with delivery/read in group must not be promoted (narrower than RETRY_TERMINAL_SUCCESS_STATUSES) */
const PROMOTION_BLOCK_SUCCESS_STATUSES = DLR_DELIVERED_STATUSES;

/** @deprecated Prefer DLR_DELIVERED_STATUSES for delivery KPIs or RETRY_TERMINAL_SUCCESS_STATUSES for retry cut-off */
const SUCCESS_TERMINAL_STATUSES = DLR_DELIVERED_STATUSES;

/** Rows that may still be promoted after staleness (never submitted/sent — those are retry-terminal) */
const IN_FLIGHT_PROMOTION_STATUSES = ['queued', 'retry_pending'];

/** Soft reconcile grace — not terminal; blocks promotion until grace expires or late DLR */
const RECONCILE_PENDING_STATUSES = ['awaiting_final_dlr'];

function parseCommaSeparatedPositiveInts(raw, fallbackArr) {
  if (raw == null || String(raw).trim() === '') return [...fallbackArr];
  const parts = String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts : [...fallbackArr];
}

function parseCooldownMinutes(envKey, fallback) {
  const n = parseInt(process.env[envKey] || '', 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return fallback;
}

/** Built from env on each read so deploy-time env changes apply without restart in long-lived dev servers. */
function buildRetryPolicies() {
  return {
    slot_booked: {
      strategy: 'immediate_only',
      maxAttempts: 2,
      immediateRetryDelaySeconds: parseInt(process.env.WA_SLOT_BOOKED_RETRY_DELAY_SECONDS || '15', 10) || 15,
      retryTransientOnly: true,
      cooldownMinutes: 0
    },
    one_on_one_submit: {
      strategy: 'immediate_only',
      maxAttempts: 2,
      immediateRetryDelaySeconds:
        parseInt(process.env.WA_ONE_ON_ONE_SUBMIT_RETRY_DELAY_SECONDS || '15', 10) || 15,
      retryTransientOnly: true,
      cooldownMinutes: 0
    },
    guidance_booking_submit: {
      strategy: 'immediate_only',
      maxAttempts: 2,
      immediateRetryDelaySeconds:
        parseInt(process.env.WA_GUIDANCE_BOOKING_SUBMIT_RETRY_DELAY_SECONDS || '15', 10) || 15,
      retryTransientOnly: true,
      cooldownMinutes: 0
    },
    guidance_counsellor_booking_notify: {
      strategy: 'immediate_only',
      maxAttempts: 2,
      immediateRetryDelaySeconds:
        parseInt(process.env.WA_GUIDANCE_COUNSELLOR_BOOKING_NOTIFY_RETRY_DELAY_SECONDS || '15', 10) ||
        15,
      retryTransientOnly: true,
      cooldownMinutes: 0
    },
    jee_mock_test_submit: {
      strategy: 'immediate_only',
      maxAttempts: 2,
      immediateRetryDelaySeconds:
        parseInt(process.env.WA_JEE_MOCK_TEST_SUBMIT_RETRY_DELAY_SECONDS || '15', 10) || 15,
      retryTransientOnly: true,
      cooldownMinutes: 0
    },
    pre4hr: {
      strategy: 'multi_stage',
      maxAttempts: 3,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_PRE4HR_RETRY_DELAY_MINUTES, [1, 2]),
      cooldownMinutes: parseCooldownMinutes('WA_PRE4HR_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    },
    meet: {
      strategy: 'multi_stage',
      maxAttempts: 3,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_MEET_RETRY_DELAY_MINUTES, [1, 2]),
      cooldownMinutes: parseCooldownMinutes('WA_MEET_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    },
    '30min': {
      strategy: 'time_sensitive',
      maxAttempts: 2,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_30MIN_RETRY_DELAY_MINUTES, [1]),
      cooldownMinutes: parseCooldownMinutes('WA_30MIN_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    },
    iit_pre2hr: {
      strategy: 'time_sensitive',
      maxAttempts: 3,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_IIT_PRE2HR_RETRY_DELAY_MINUTES, [1]),
      cooldownMinutes: parseCooldownMinutes('WA_IIT_PRE2HR_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    },
    iit_pre45min: {
      strategy: 'time_sensitive',
      maxAttempts: 2,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_IIT_PRE45MIN_RETRY_DELAY_MINUTES, [1]),
      cooldownMinutes: parseCooldownMinutes('WA_IIT_PRE45MIN_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    },
    iit_pre15min: {
      strategy: 'time_sensitive',
      maxAttempts: 2,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_IIT_PRE15MIN_RETRY_DELAY_MINUTES, [1]),
      cooldownMinutes: parseCooldownMinutes('WA_IIT_PRE15MIN_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    },
    guidance_pre30min: {
      strategy: 'time_sensitive',
      maxAttempts: 2,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(process.env.WA_GUIDANCE_PRE30MIN_RETRY_DELAY_MINUTES, [1]),
      cooldownMinutes: parseCooldownMinutes('WA_GUIDANCE_PRE30MIN_RETRY_COOLDOWN_MINUTES', 0),
      classifyPermanentFailures: true
    }
  };
}

const TRANSIENT_FAILURE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /temporar/i,
  /network/i,
  /econn/i,
  /socket/i,
  /5\d\d/,
  /provider.*down/i,
  /service unavailable/i,
  /rate.?limit/i
];

/** Send blocked by missing env / provider config — must not be classified as user permanent failure. */
const INFRASTRUCTURE_SEND_FAILURE_PATTERNS = [
  /WhatsApp disabled/i,
  /ENABLE_WHATSAPP/i,
  /Gupshup not configured/i,
  /template id missing/i,
  /missing.*template/i,
  /IIT slot_booked header image URL missing/i,
];

function isInfrastructureSendFailure(failCtx = {}) {
  const hay = [failCtx.errorCode, failCtx.errorReason, failCtx.errorText, failCtx.errorMessage]
    .filter(Boolean)
    .join(' | ');
  return hay.length > 0 && INFRASTRUCTURE_SEND_FAILURE_PATTERNS.some((rx) => rx.test(hay));
}

/** Meta / WhatsApp Cloud API codes that must never be retried (engagement, spam, re-engagement). */
const META_PERMANENT_ERROR_CODES = new Set([
  '131047', // re-engagement message required
  '131048', // spam rate limit
  '131049', // ecosystem engagement limit
]);

const PERMANENT_FAILURE_PATTERNS = [
  /invalid/i,
  /not whatsapp/i,
  /no whatsapp/i,
  /whatsapp.*disabled/i,
  /disabled.*whatsapp/i,
  /user.*not.*registered/i,
  /not.*registered.*whatsapp/i,
  /opt.?out/i,
  /blocked/i,
  /blacklist/i,
  /does not exist/i,
  /rejected/i,
  /policy/i,
  /undeliverable/i,
  /unregistered/i,
  /ecosystem engagement/i,
  /healthy ecosystem/i,
  /re-engagement/i,
  /spam rate limit/i,
];

/**
 * @param {{ errorCode?: string, errorReason?: string, errorText?: string, errorMessage?: string }} failCtx
 * @returns {boolean}
 */
function isMetaPermanentProviderError(failCtx = {}) {
  const code = String(failCtx.errorCode || '').trim();
  if (code && META_PERMANENT_ERROR_CODES.has(code)) return true;
  const hay = [failCtx.errorCode, failCtx.errorReason, failCtx.errorText, failCtx.errorMessage]
    .filter(Boolean)
    .join(' | ');
  if (!hay) return false;
  if (/131047|131048|131049/.test(hay)) return true;
  return /ecosystem engagement/i.test(hay) || /healthy ecosystem/i.test(hay);
}

const RETRY_EXCLUSION_REASON = {
  alreadyDeliveredOrRead: 'already_delivered_or_read',
  duplicateRetryPrevented: 'duplicate_retry_prevented',
  retryEligibilityDisabled: 'retry_eligibility_disabled',
  cooldownBlocked: 'cooldown_blocked',
  missingPhone: 'missing_phone',
  missingRegisteredSubmission: 'missing_registered_submission',
  policyNonRetryable: 'policy_non_retryable',
  permanentFailure: 'permanent_failure',
  inFlightTimeout: 'in_flight_timeout',
  promotionSuperseded: 'promotion_superseded',
  outsideReminderValidity: 'outside_reminder_validity',
  /** Second gate or invariant: send blocked because now outside slot-relative eligibility window */
  eligibilityTimingBlocked: 'eligibility_timing_blocked',
  /** DLR reported failed after provider accept; ambiguous / non-retryable */
  dlrFailedAfterAccept: 'dlr_failed_after_accept',
  /** submitted/sent aged out without DLR resolution */
  webhookStaleUnresolved: 'webhook_stale_unresolved'
};

function permanentFailureClassification(_failCtx = {}, afterProviderAccept = false) {
  return {
    retryable: false,
    terminalFailureKind: 'permanent',
    exclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
    metaNote: afterProviderAccept ? 'webhook_failed_after_provider_accept' : 'meta_permanent_error',
  };
}

function getRetryPolicy(kind) {
  const policies = buildRetryPolicies();
  return (
    policies[kind] || {
      strategy: 'multi_stage',
      maxAttempts: 3,
      retryDelayMinutes: parseCommaSeparatedPositiveInts(
        process.env.WHATSAPP_RETRY_DELAY_MINUTES,
        [1, 2]
      ),
      cooldownMinutes: parseInt(process.env.WHATSAPP_RETRY_COOLDOWN_MINUTES || '0', 10) || 0,
      classifyPermanentFailures: true
    }
  );
}

function isCampaignStrategy(kind) {
  return getRetryPolicy(kind).strategy !== 'immediate_only';
}

function isImmediateOnlyStrategy(kind) {
  return getRetryPolicy(kind).strategy === 'immediate_only';
}

/**
 * Slot_booked: only transient errors retry. Campaigns: permanent patterns never retry;
 * transient retry; unknown/non-matching hay still retries (provider glitches).
 */
/**
 * Classify campaign failure for webhook DLR, reconciliation, and send-time errors.
 * @param {string} kind
 * @param {{ errorCode?: string, errorReason?: string, errorText?: string }} failCtx
 * @param {{ afterProviderAccept?: boolean, attemptNumber?: number }} [opts]
 * @returns {{ retryable: boolean, terminalFailureKind: 'permanent'|'transient'|null, exclusionReason: string|null, metaNote: string|null }}
 */
function isIitTemplateParamFormatError(failCtx = {}) {
  const hay = [failCtx.errorCode, failCtx.errorReason, failCtx.errorText, failCtx.errorMessage]
    .filter(Boolean)
    .join(' | ');
  return /132012/i.test(hay) || /parameter format does not match/i.test(hay);
}

function classifyCampaignFailure(kind, failCtx = {}, opts = {}) {
  const { afterProviderAccept = false, attemptNumber = 1 } = opts;
  const policy = getRetryPolicy(kind);
  const hay = [failCtx.errorCode, failCtx.errorReason, failCtx.errorText].filter(Boolean).join(' | ');
  const maxA = Number(policy.maxAttempts) || 3;
  const att = Number(attemptNumber) || 1;
  const hasAttemptsLeft = att < maxA;

  if (kind === 'iit_pre2hr' && isIitTemplateParamFormatError(failCtx) && hasAttemptsLeft) {
    return {
      retryable: true,
      terminalFailureKind: 'transient',
      exclusionReason: null,
      metaNote: 'iit_pre2hr_template_param_retry',
    };
  }

  if (isInfrastructureSendFailure(failCtx)) {
    return {
      retryable: true,
      terminalFailureKind: null,
      exclusionReason: null,
      metaNote: 'infrastructure_not_ready',
    };
  }

  if (isMetaPermanentProviderError(failCtx)) {
    return permanentFailureClassification(failCtx, afterProviderAccept);
  }

  if (hay && PERMANENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) {
    return {
      retryable: false,
      terminalFailureKind: 'permanent',
      exclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
      metaNote: afterProviderAccept ? 'webhook_failed_after_provider_accept' : null
    };
  }

  const transient = hay ? TRANSIENT_FAILURE_PATTERNS.some((rx) => rx.test(hay)) : false;

  if (afterProviderAccept) {
    if (transient && hasAttemptsLeft) {
      return {
        retryable: true,
        terminalFailureKind: 'transient',
        exclusionReason: null,
        metaNote: 'webhook_failed_after_provider_accept_transient'
      };
    }
    if (transient && !hasAttemptsLeft) {
      return {
        retryable: false,
        terminalFailureKind: 'transient',
        exclusionReason: RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
        metaNote: 'webhook_failed_after_provider_accept_max_attempts'
      };
    }
    return {
      retryable: false,
      terminalFailureKind: transient ? 'transient' : 'permanent',
      exclusionReason: RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
      metaNote: 'webhook_failed_after_provider_accept'
    };
  }

  if (!hay) {
    return {
      retryable: policy.classifyPermanentFailures !== false,
      terminalFailureKind: policy.classifyPermanentFailures !== false ? 'transient' : null,
      exclusionReason: null,
      metaNote: null
    };
  }

  if (transient) {
    return {
      retryable: hasAttemptsLeft,
      terminalFailureKind: 'transient',
      exclusionReason: hasAttemptsLeft ? null : RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
      metaNote: null
    };
  }

  return {
    retryable: policy.classifyPermanentFailures !== false,
    terminalFailureKind: 'transient',
    exclusionReason: null,
    metaNote: null
  };
}

function isRetryableFailure(kind, { errorCode, errorReason, errorText } = {}) {
  if (isInfrastructureSendFailure({ errorCode, errorReason, errorText })) {
    return true;
  }
  if (isMetaPermanentProviderError({ errorCode, errorReason, errorText })) {
    return false;
  }
  const policy = getRetryPolicy(kind);
  const hay = [errorCode, errorReason, errorText].filter(Boolean).join(' | ');
  if (policy.retryTransientOnly) {
    if (!hay) return false;
    if (PERMANENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) return false;
    return TRANSIENT_FAILURE_PATTERNS.some((rx) => rx.test(hay));
  }
  if (policy.classifyPermanentFailures) {
    if (hay && PERMANENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) return false;
    return true;
  }
  if (!hay) return true;
  if (PERMANENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) return false;
  return TRANSIENT_FAILURE_PATTERNS.some((rx) => rx.test(hay));
}

function retryCooldownMsForKind(kind) {
  const p = getRetryPolicy(kind);
  return Math.max(0, Number(p.cooldownMinutes) || 0) * 60 * 1000;
}

/** Milliseconds to wait after `fromAttempt` finishes (terminal or stale) before promoting to `fromAttempt+1`. */
function getRetryDelayMsAfterAttempt(kind, fromAttempt) {
  const p = getRetryPolicy(kind);
  const idx = Number(fromAttempt) - 1;
  const arr = Array.isArray(p.retryDelayMinutes) ? p.retryDelayMinutes : [];
  const minutes = idx >= 0 && idx < arr.length ? Number(arr[idx]) : Number(arr[arr.length - 1]) || 5;
  const floor = retryCooldownMsForKind(kind);
  return Math.max(floor, Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60 * 1000);
}

/** Stale in-flight rows become promotion-eligible after this age (ms). */
function inFlightPromotionStaleMsForKind(kind) {
  if (kind === 'slot_booked') {
    return Math.max(
      60 * 1000,
      (parseInt(process.env.WA_SLOT_BOOKED_INFLIGHT_STALE_MS || '', 10) || 120000)
    );
  }
  return Math.max(
    60 * 1000,
    (parseInt(process.env.WA_CAMPAIGN_INFLIGHT_STALE_MS || '', 10) || 180000)
  );
}

/**
 * Rows at `fromAttempt` eligible for next promotion (per-row `eligibleAtMs` already computed vs `nowMs`).
 * @param {Array<{ phone: string, _id: any, retryEligible?: boolean, eligibleAtMs: number }>} rows
 * @param {{ neverRetryPhones: string[], alreadyPromotedPhones: string[] }} opts
 */
function filterRetryPromotionRowsV2(rows, opts) {
  const { neverRetryPhones, alreadyPromotedPhones } = opts;
  const banned = new Set(neverRetryPhones);
  const promoted = new Set(alreadyPromotedPhones);
  const now = Date.now();
  const includedRows = [];
  const excludedRows = [];
  const exclusionCounts = {};

  function pushExcluded(r, reason) {
    excludedRows.push({
      phone: r && r.phone ? r.phone : null,
      parentMessageEventId: r && r._id ? r._id : null,
      reason
    });
    exclusionCounts[reason] = (exclusionCounts[reason] || 0) + 1;
  }

  rows.forEach((r) => {
    const p = r.phone;
    if (!p) {
      pushExcluded(r, RETRY_EXCLUSION_REASON.missingPhone);
      return;
    }
    if (banned.has(p)) {
      pushExcluded(r, RETRY_EXCLUSION_REASON.alreadyDeliveredOrRead);
      return;
    }
    if (promoted.has(p)) {
      pushExcluded(r, RETRY_EXCLUSION_REASON.duplicateRetryPrevented);
      return;
    }
    if (r.retryEligible === false) {
      pushExcluded(r, RETRY_EXCLUSION_REASON.retryEligibilityDisabled);
      return;
    }
    const eligibleAt = Number.isFinite(r.eligibleAtMs) ? r.eligibleAtMs : 0;
    if (now < eligibleAt) {
      pushExcluded(r, RETRY_EXCLUSION_REASON.cooldownBlocked);
      return;
    }
    includedRows.push(r);
  });

  return { includedRows, excludedRows, exclusionCounts };
}

/**
 * Legacy wrapper: single cutoff = now - cooldownCutoffMs (old behavior).
 * @deprecated prefer filterRetryPromotionRowsV2 + per-row delays
 */
function filterRetryPromotionRows(failedStageRows, opts) {
  const { neverRetryPhones, alreadyPromotedPhones, cooldownCutoffMs } = opts;
  const now = Date.now();
  const cool = Number.isFinite(cooldownCutoffMs) ? cooldownCutoffMs : 0;
  const rows = (failedStageRows || []).map((r) => {
    const failedMs = r.failedAt ? new Date(r.failedAt).getTime() : now - cool - 1;
    const eligibleAtMs = failedMs + cool;
    return { ...r, eligibleAtMs };
  });
  return filterRetryPromotionRowsV2(rows, { neverRetryPhones, alreadyPromotedPhones });
}

/** Default ms before reconciling stale submitted/sent campaign rows */
function dlrReconcileStaleMs() {
  return Math.max(
    5 * 60 * 1000,
    parseInt(process.env.WA_DLR_RECONCILE_STALE_MS || '', 10) || 45 * 60 * 1000
  );
}

/** Grace window in awaiting_final_dlr before phase-2 terminal failed */
function dlrReconcileGraceMs() {
  return Math.max(
    5 * 60 * 1000,
    parseInt(process.env.WA_DLR_RECONCILE_GRACE_MS || '', 10) || 30 * 60 * 1000
  );
}

/**
 * @param {{ status?: string, reconcileDerivedFailure?: boolean }} doc
 */
function isReconcileDerivedTerminal(doc) {
  if (!doc) return false;
  const st = String(doc.status || '').toLowerCase();
  return st === 'failed' && doc.reconcileDerivedFailure === true;
}

/** Exclusion reasons that must never be backfilled as reconcile-derived */
const PERMANENT_EXCLUSION_REASONS = [
  RETRY_EXCLUSION_REASON.permanentFailure,
  RETRY_EXCLUSION_REASON.policyNonRetryable,
  RETRY_EXCLUSION_REASON.alreadyDeliveredOrRead
];

const RECONCILE_RECOVERY_RISK_WARNING =
  'This recipient previously entered delayed-DLR reconciliation. Original delivery may still arrive late.';

function reconcileFinalityMs(row) {
  if (!row || !row.reconcileFinalityUntil) return 0;
  const t = new Date(row.reconcileFinalityUntil).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * True while row is in awaiting_final_dlr or reconcileFinalityUntil is still in the future.
 * @param {{ status?: string, reconcileFinalityUntil?: Date|string|null }} row
 * @param {Date} [now]
 */
function isReconcileGraceActive(row, now = new Date()) {
  if (!row) return false;
  const st = String(row.status || '').toLowerCase();
  if (RECONCILE_PENDING_STATUSES.includes(st)) return true;
  const until = reconcileFinalityMs(row);
  return until > now.getTime();
}

/** Manual recovery must not target rows in reconciliation grace. */
function isManualRecoveryBlocked(row, now = new Date()) {
  return isReconcileGraceActive(row, now);
}

/**
 * Reconcile-derived failure after finality — allow only with explicit operator confirmation.
 * @param {{ status?: string, reconcileDerivedFailure?: boolean, reconcileFinalityUntil?: Date|string|null }} row
 * @param {Date} [now]
 */
function isRiskyReconcileRecovery(row, now = new Date()) {
  if (!row || isReconcileGraceActive(row, now)) return false;
  const st = String(row.status || '').toLowerCase();
  return st === 'failed' && row.reconcileDerivedFailure === true;
}

/**
 * Phase-2 finalize classifier — conservative duplicate-safe retry hints for stale DLR.
 * @param {string} messageKind
 * @param {{ webhookErrorCode?: string, webhookErrorReason?: string, errorMessage?: string, attemptNumber?: number, providerAcceptedAt?: Date|null }} row
 * @param {{ now?: Date }} [opts]
 */
function classifyReconcileFinalizeFailure(messageKind, row = {}, opts = {}) {
  const failCtx = {
    errorCode: row.webhookErrorCode || row.errorCode,
    errorReason: row.webhookErrorReason || row.errorReason,
    errorText: row.errorMessage || 'stale_dlr_no_resolution'
  };
  const hay = [failCtx.errorCode, failCtx.errorReason, failCtx.errorText].filter(Boolean).join(' | ');
  const policy = getRetryPolicy(messageKind);
  const maxA = Number(policy.maxAttempts) || 3;
  const att = Number(row.attemptNumber) || 1;
  const hasAttemptsLeft = att < maxA;
  const wasAccepted = !!row.providerAcceptedAt;

  if (isMetaPermanentProviderError(failCtx)) {
    return permanentFailureClassification(failCtx, wasAccepted);
  }

  if (hay && PERMANENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) {
    return {
      retryable: false,
      terminalFailureKind: 'permanent',
      exclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
      metaNote: 'reconcile_finalize_permanent'
    };
  }

  if (hay && TRANSIENT_FAILURE_PATTERNS.some((rx) => rx.test(hay))) {
    if (hasAttemptsLeft) {
      return {
        retryable: true,
        terminalFailureKind: 'transient',
        exclusionReason: null,
        metaNote: 'reconcile_finalize_transient'
      };
    }
    return {
      retryable: false,
      terminalFailureKind: 'transient',
      exclusionReason: RETRY_EXCLUSION_REASON.dlrFailedAfterAccept,
      metaNote: 'reconcile_finalize_transient_max_attempts'
    };
  }

  if (wasAccepted && hasAttemptsLeft && att <= 2) {
    const onlyStale = !hay || /stale_dlr/i.test(hay);
    if (onlyStale) {
      return {
        retryable: true,
        terminalFailureKind: 'transient',
        exclusionReason: null,
        metaNote: 'reconcile_stale_likely_transient'
      };
    }
  }

  return classifyCampaignFailure(messageKind, failCtx, {
    afterProviderAccept: wasAccepted,
    attemptNumber: att
  });
}

const IIT_RETRY_KINDS = new Set(['iit_pre2hr', 'iit_pre45min', 'iit_pre15min']);

/** Max wall clock from first attempt-1 terminal failure before group exhausted */
function campaignRetryMaxWallMs(kind) {
  const base = Math.max(
    5 * 60 * 1000,
    parseInt(process.env.WHATSAPP_CAMPAIGN_RETRY_MAX_WALL_MS || '', 10) || 900000
  );
  if (kind && IIT_RETRY_KINDS.has(kind)) {
    return Math.max(
      base,
      parseInt(process.env.WA_IIT_CAMPAIGN_RETRY_MAX_WALL_MS || '', 10) || 6 * 60 * 60 * 1000
    );
  }
  return base;
}

function retrySourceFromAttemptNumber(n) {
  const a = Number(n) || 1;
  if (a <= 1) return 'initial';
  if (a === 2) return 'retry1';
  if (a === 3) return 'retry2';
  return 'manual_recovery';
}

module.exports = {
  /** @deprecated Use getRetryPolicy(); values are env-driven */
  get RETRY_POLICIES() {
    return buildRetryPolicies();
  },
  TERMINAL_FAILURE_STATUSES,
  RETRY_TERMINAL_SUCCESS_STATUSES,
  DLR_DELIVERED_STATUSES,
  PROMOTION_BLOCK_SUCCESS_STATUSES,
  SUCCESS_TERMINAL_STATUSES,
  IN_FLIGHT_PROMOTION_STATUSES,
  RECONCILE_PENDING_STATUSES,
  RETRY_EXCLUSION_REASON,
  isReconcileDerivedTerminal,
  PERMANENT_EXCLUSION_REASONS,
  RECONCILE_RECOVERY_RISK_WARNING,
  isReconcileGraceActive,
  isManualRecoveryBlocked,
  isRiskyReconcileRecovery,
  classifyReconcileFinalizeFailure,
  classifyCampaignFailure,
  isMetaPermanentProviderError,
  META_PERMANENT_ERROR_CODES,
  isInfrastructureSendFailure,
  filterRetryPromotionRows,
  filterRetryPromotionRowsV2,
  retrySourceFromAttemptNumber,
  getRetryPolicy,
  isCampaignStrategy,
  isImmediateOnlyStrategy,
  isRetryableFailure,
  retryCooldownMsForKind,
  getRetryDelayMsAfterAttempt,
  inFlightPromotionStaleMsForKind,
  dlrReconcileStaleMs,
  dlrReconcileGraceMs,
  campaignRetryMaxWallMs
};
