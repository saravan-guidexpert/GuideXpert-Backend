const mongoose = require('mongoose');
const WhatsAppMessageEvent = require('../models/WhatsAppMessageEvent');
const MessagingCronRun = require('../models/MessagingCronRun');
const WhatsAppWebhookEvent = require('../models/WhatsAppWebhookEvent');
const FormSubmission = require('../models/FormSubmission');
const IitCounsellingSubmission = require('../models/IitCounsellingSubmission');
const WhatsAppRetryGroup = require('../models/WhatsAppRetryGroup');
const WhatsAppOpsChartSnapshot = require('../models/WhatsAppOpsChartSnapshot');
const WhatsAppManualRecoveryJob = require('../models/WhatsAppManualRecoveryJob');
const { buildSlotNotificationVariables } = require('../utils/slotNotificationFormatters');
const { safeSendWhatsApp } = require('../utils/safeSendWhatsApp');
const gupshupService = require('../services/gupshupService');
const { executeRetryWhatsAppBatch } = require('../services/retryWhatsAppBatch');
const {
  previewRetryPromotion,
  executeRetryAttempt,
  computeRetryCandidates
} = require('../services/whatsappRetryOrchestrator');
const {
  getRetryPolicy,
  isCampaignStrategy,
  RECONCILE_RECOVERY_RISK_WARNING,
  isManualRecoveryBlocked,
  isRiskyReconcileRecovery
} = require('../utils/whatsappRetryRules');
const { deriveSubmissionWaStatus } = require('../services/whatsappOpsStatus');
const opsAggregates = require('../services/whatsappOpsAggregates');
const recipientAnalytics = require('../services/whatsappOpsRecipientAnalytics');
const manualRecoveryService = require('../services/whatsappManualRecovery');
const {
  parseOpsProductQuery,
  listAllowedOpsProducts,
  matchWhatsAppEventsByOpsProduct
} = require('../utils/whatsappOpsProduct');
const { validateMessageKindForOpsProduct } = require('../utils/whatsappOpsEventMatch');
const {
  resolveProviderErrorDisplay,
  parseWebhookPayloadForErrors
} = require('../utils/gupshupProviderErrors');
const { describeOpsFailure } = require('../utils/whatsappOpsFailureCopy');
const IST_OFFSET_MINUTES = 330;

function clampInt(v, dflt, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, 1), max);
}

/** @param {import('express').Request} req @param {string|null|undefined} opsProduct */
function parsePreferredLanguageFromQuery(req, opsProduct) {
  const raw = req.query?.preferredLanguage ?? req.body?.preferredLanguage;
  if (raw == null || raw === '') return { preferredLanguage: null };
  const norm = recipientAnalytics.normalizePreferredLanguageParam(raw);
  if (norm === undefined) {
    return { error: 'Invalid preferredLanguage. Use Telugu or Hindi.' };
  }
  if (parseOpsProductQuery(opsProduct) !== 'iit_counselling') {
    return { preferredLanguage: null };
  }
  return { preferredLanguage: norm };
}

function dateRange(query) {
  const from = parseBoundaryDate(query.from, 'start');
  const to = parseBoundaryDate(query.to, 'end') || new Date();
  return { from, to };
}

function parseBoundaryDate(raw, mode) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  // HTML date inputs: treat YYYY-MM-DD as Asia/Kolkata calendar days (matches month/day ops APIs).
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const r = istDayRangeFromIso(value);
    if (!r) return null;
    return mode === 'start' ? r.from : r.to;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIsoDateOnly(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  return { y, m, d, iso: s };
}

function parseIsoMonth(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const [y, m] = s.split('-').map((x) => parseInt(x, 10));
  if (!y || !m) return null;
  return { y, m, iso: s };
}

function istDayRangeFromIso(dateIso) {
  const p = parseIsoDateOnly(dateIso);
  if (!p) return null;
  const startUtcMs = Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0, 0) - (IST_OFFSET_MINUTES * 60 * 1000);
  const endUtcMs = startUtcMs + (24 * 60 * 60 * 1000) - 1;
  return { from: new Date(startUtcMs), to: new Date(endUtcMs), isoDate: p.iso };
}

function istMonthRangeFromIso(monthIso) {
  const p = parseIsoMonth(monthIso);
  if (!p) return null;
  const startUtcMs = Date.UTC(p.y, p.m - 1, 1, 0, 0, 0, 0) - (IST_OFFSET_MINUTES * 60 * 1000);
  const nextMonthStartUtcMs = Date.UTC(p.m === 12 ? p.y + 1 : p.y, p.m === 12 ? 0 : p.m, 1, 0, 0, 0, 0)
    - (IST_OFFSET_MINUTES * 60 * 1000);
  return {
    from: new Date(startUtcMs),
    to: new Date(nextMonthStartUtcMs - 1),
    isoMonth: p.iso
  };
}

function facetStatsPipeline(match) {
  return [
    { $match: match },
    {
      $facet: {
        total: [{ $count: 'c' }],
        byKind: [{ $group: { _id: '$messageKind', c: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$status', c: { $sum: 1 } } }],
        /** Accepted by Gupshup (API success path), any lifecycle stage before terminal send-fail */
        submittedAccepted: [{
          $match: { status: { $in: ['submitted', 'sent', 'delivered', 'read'] } }
        }, { $count: 'c' }],
        /** Still awaiting DLR past `submitted` */
        strictSubmitted: [{ $match: { status: 'submitted' } }, { $count: 'c' }],
        /** Webhook `sent` or later */
        sentCumulative: [{
          $match: { status: { $in: ['sent', 'delivered', 'read'] } }
        }, { $count: 'c' }],
        /** Device delivery or read */
        deliveredCumulative: [{
          $match: { status: { $in: ['delivered', 'read'] } }
        }, { $count: 'c' }],
        readStrict: [{ $match: { status: 'read' } }, { $count: 'c' }],
        failed: [{ $match: { status: { $in: ['failed', 'retry_exhausted'] } } }, { $count: 'c' }],
        retryExhausted: [{ $match: { status: 'retry_exhausted' } }, { $count: 'c' }],
        retried: [{ $match: { retryCountSnapshot: { $gt: 0 } } }, { $count: 'c' }],
        slotBookedAttempts: [{ $match: { messageKind: 'slot_booked' } }, { $count: 'c' }]
      }
    }
  ];
}

function facetStatsToTotals(facet) {
  return {
    whatsappAttempts: facet.total?.[0]?.c || 0,
    /** Funnel: messages accepted by provider (not send-failed / exhausted) */
    providerAcceptedCount: facet.submittedAccepted?.[0]?.c || 0,
    strictSubmittedCount: facet.strictSubmitted?.[0]?.c || 0,
    sentCount: facet.sentCumulative?.[0]?.c || 0,
    whatsappFailed: facet.failed?.[0]?.c || 0,
    /** Count of messages that reached device delivery (includes those later read) */
    deliveredCount: facet.deliveredCumulative?.[0]?.c || 0,
    readCount: facet.readStrict?.[0]?.c || 0,
    retried: facet.retried?.[0]?.c || 0,
    retryExhausted: facet.retryExhausted?.[0]?.c || 0,
    slotBookedAttempts: facet.slotBookedAttempts?.[0]?.c || 0
  };
}

function mapEventStatusToDeliveryStatus(status) {
  const s = status ? String(status).toLowerCase() : '';
  if (s === 'read') return 'read';
  if (s === 'delivered') return 'delivered';
  if (s === 'failed' || s === 'retry_exhausted') return 'failed';
  if (s === 'sent') return 'sent';
  if (s === 'submitted' || s === 'queued' || s === 'retry_pending') return 'submitted';
  return s || null;
}

const { WHATSAPP_MESSAGE_KINDS: ALLOWED_MESSAGE_KINDS } = WhatsAppMessageEvent;

const GUIDANCE_HEALTH_KINDS = [
  'guidance_booking_submit',
  'guidance_pre30min',
  'guidance_counsellor_booking_notify',
];

async function computeGuidanceWhatsAppHealth(windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const byKind = {};

  for (const kind of GUIDANCE_HEALTH_KINDS) {
    const [statusRows, codeRows] = await Promise.all([
      WhatsAppMessageEvent.aggregate([
        { $match: { messageKind: kind, createdAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      WhatsAppMessageEvent.aggregate([
        {
          $match: {
            messageKind: kind,
            createdAt: { $gte: since },
            webhookErrorCode: { $nin: [null, ''] },
          },
        },
        { $group: { _id: '$webhookErrorCode', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const byStatus = Object.fromEntries(statusRows.map((r) => [r._id, r.count]));
    const total = statusRows.reduce((sum, r) => sum + r.count, 0);
    const delivered = (byStatus.delivered || 0) + (byStatus.read || 0);

    byKind[kind] = {
      total,
      delivered,
      successRatePct: total > 0 ? Math.round((delivered / total) * 100) : null,
      byStatus,
      topWebhookErrorCodes: codeRows.map((r) => ({ code: r._id, count: r.count })),
    };
  }

  return {
    windowHours,
    sinceIso: since.toISOString(),
    byKind,
    metaEngagementLimitNote:
      'Meta error 131049 (ecosystem engagement) is permanent — ensure guidance templates are UTILITY category in Gupshup.',
  };
}

exports.getOpsMeta = async (_req, res) => {
  try {
    const guidanceWhatsAppHealth = await computeGuidanceWhatsAppHealth(24);
    res.json({
      success: true,
      data: {
        envHints: [
          'ENABLE_WHATSAPP',
          'GUPSHUP_API_KEY',
          'GUPSHUP_SOURCE',
          'GUPSHUP_TEMPLATE_REMINDER',
          'GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED_WEDNESDAY',
          'GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED_SATURDAY',
          'GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED_SUNDAY',
          'GUPSHUP_TEMPLATE_IIT_SLOT_BOOKED',
          'GUPSHUP_TEMPLATE_ONE_ON_ONE_CONFIRM',
          'GUPSHUP_ONE_ON_ONE_HEADER_IMAGE_URL',
          'GUPSHUP_TEMPLATE_GUIDANCE_BOOKING_CONFIRM',
          'GUPSHUP_TEMPLATE_GUIDANCE_PRE30MIN_REMINDER',
          'GUPSHUP_TEMPLATE_GUIDANCE_COUNSELLOR_BOOKING_NOTIFY',
          'GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER',
          'WA_GUIDANCE_BOOKING_SUBMIT_RETRY_DELAY_SECONDS',
        'GUPSHUP_TEMPLATE_IIT_PRE2HR_TELUGU',
        'GUPSHUP_TEMPLATE_IIT_PRE2HR_HINDI',
        'GUPSHUP_TEMPLATE_IIT_PRE45MIN_TELUGU',
        'GUPSHUP_TEMPLATE_IIT_PRE45MIN_HINDI',
        'GUPSHUP_TEMPLATE_IIT_PRE15MIN_TELUGU',
        'GUPSHUP_TEMPLATE_IIT_PRE15MIN_HINDI',
        'GUPSHUP_TEMPLATE_IIT_SUNDAY_PRE2HR_TELUGU',
        'GUPSHUP_TEMPLATE_IIT_SUNDAY_PRE2HR_HINDI',
        'GUPSHUP_TEMPLATE_IIT_SUNDAY_PRE45MIN_TELUGU',
        'GUPSHUP_TEMPLATE_IIT_SUNDAY_PRE45MIN_HINDI',
        'GUPSHUP_TEMPLATE_IIT_SUNDAY_PRE15MIN_TELUGU',
        'GUPSHUP_TEMPLATE_IIT_SUNDAY_PRE15MIN_HINDI',
        'GUPSHUP_TEMPLATE_PRE4HR',
        'GUPSHUP_TEMPLATE_MEET',
        'GUPSHUP_TEMPLATE_30MIN',
        'WHATSAPP_CRON_SCHEDULE_COPY'
      ],
      opsProductsAllowed: [...listAllowedOpsProducts()],
      templateKinds: [
        { id: 'slot_booked', label: 'Slot booked', description: 'Immediate confirmation after slot booking', retryPolicy: getRetryPolicy('slot_booked'), opsProducts: ['guidexpert', 'iit_counselling'] },
        { id: 'one_on_one_submit', label: 'Form submit confirmation', description: 'Immediate confirmation after /one-on-one-session form submit', retryPolicy: getRetryPolicy('one_on_one_submit'), opsProducts: ['one_on_one_counseling'] },
        { id: 'guidance_booking_submit', label: 'Booking confirmation', description: 'Immediate confirmation after /guidance-booking-confirmation book-slot', retryPolicy: getRetryPolicy('guidance_booking_submit'), opsProducts: ['guidance_booking'] },
        { id: 'guidance_counsellor_booking_notify', label: 'Counsellor booking notify', description: 'Immediate WhatsApp to assigned counsellor when student books a guidance slot', retryPolicy: getRetryPolicy('guidance_counsellor_booking_notify'), opsProducts: ['guidance_booking'] },
        { id: 'guidance_pre30min', label: '30 min before session', description: 'Scheduled reminder 30 minutes before guidance session start (name + slottime)', retryPolicy: getRetryPolicy('guidance_pre30min'), opsProducts: ['guidance_booking'] },
        { id: 'jee_mock_test_submit', label: 'Mock test registration', description: 'Immediate WhatsApp after JEE mock test registration from influencer UTM links (name + image).', retryPolicy: getRetryPolicy('jee_mock_test_submit'), opsProducts: ['jee_mock_test'] },
        { id: 'pre4hr', label: '4hr reminder', description: 'Cron + save_step3 use the same deadline-backward window near 4h before slot (see WA_PRE4HR_*).', retryPolicy: getRetryPolicy('pre4hr'), opsProducts: ['guidexpert'] },
        { id: 'meet', label: 'Meet link (~1hr)', description: 'Same deadline-backward window near 1h before slot (see WA_MEET_*).', retryPolicy: getRetryPolicy('meet'), opsProducts: ['guidexpert'] },
        { id: '30min', label: '30 min reminder', description: 'Same deadline-backward window near 30m before slot (see WA_30MIN_*).', retryPolicy: getRetryPolicy('30min'), opsProducts: ['guidexpert'] },
        { id: 'iit_pre2hr', label: 'IIT 2hr before', description: 'Language-specific template 2 hours before IIT demo (Wed/Sat vs Sun).', retryPolicy: getRetryPolicy('iit_pre2hr'), opsProducts: ['iit_counselling'] },
        { id: 'iit_pre45min', label: 'IIT 45 min before', description: 'Language-specific template 45 minutes before IIT demo.', retryPolicy: getRetryPolicy('iit_pre45min'), opsProducts: ['iit_counselling'] },
        { id: 'iit_pre15min', label: 'IIT 15 min before', description: 'Language-specific template 15 minutes before IIT demo.', retryPolicy: getRetryPolicy('iit_pre15min'), opsProducts: ['iit_counselling'] },
      ],
      guidanceWhatsAppHealth,
    },
  });
  } catch (e) {
    console.error('[whatsapp-ops meta]', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getSummary = async (req, res) => {
  try {
    const { from, to } = dateRange(req.query);
    const messageKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    const opsProduct = parseOpsProductQuery(req.query.opsProduct ?? req.query.tenant);
    const result = await opsAggregates.computeSummary({ from, to, messageKind, opsProduct });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }
    res.json({ success: true, data: result.data });
  } catch (e) {
    console.error('[whatsapp-ops summary]', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getCalendarMonthOverview = async (req, res) => {
  try {
    const monthIso = req.query.month || new Date().toISOString().slice(0, 7);
    const messageKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    const opsProduct = parseOpsProductQuery(req.query.opsProduct ?? req.query.tenant);
    const langParse = parsePreferredLanguageFromQuery(req, opsProduct);
    if (langParse.error) {
      return res.status(400).json({ success: false, message: langParse.error });
    }
    const preferredLanguage = langParse.preferredLanguage;
    const [legacy, recipient] = await Promise.all([
      opsAggregates.computeMonthOverview({ monthIso, messageKind, opsProduct }),
      recipientAnalytics.computeRecipientMonthTrend({
        monthIso,
        messageKind,
        opsProduct,
        preferredLanguage
      })
    ]);
    if (legacy.error) {
      return res.status(400).json({ success: false, message: legacy.error });
    }
    if (recipient.error) {
      return res.status(400).json({ success: false, message: recipient.error });
    }
    return res.json({
      success: true,
      data: {
        ...legacy.data,
        schemaVersion: recipient.data.schemaVersion || 3,
        metricsMode: recipient.data.metricsMode || 'recipient_primary_v3',
        metricDefinitions: recipient.data.metricDefinitions || null,
        recipientTrendDays: recipient.data.days || [],
        diagnostic: {
          attemptLevelDays: legacy.data.days || []
        }
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Primary metrics: recipient-based cohort (IST slot day). Attempt rows use the same slot-day join under slotCohortAttemptMetrics.
 */
exports.getCalendarDayOverview = async (req, res) => {
  try {
    const dateIso = req.query.date || new Date().toISOString().slice(0, 10);
    const selectedKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    const opsProduct = parseOpsProductQuery(req.query.opsProduct ?? req.query.tenant);
    const cohortIsIit = opsProduct === 'iit_counselling';
    const slotTimeNorm = recipientAnalytics.normalizeSlotTimeParam(req.query.slotTime);
    if (slotTimeNorm === null) {
      return res.status(400).json({
        success: false,
        message: `Invalid slotTime. Use all, ${recipientAnalytics.ALLOWED_SLOT_TIME_SUFFIXES.join(', ')}.`
      });
    }
    const langParse = parsePreferredLanguageFromQuery(req, opsProduct);
    if (langParse.error) {
      return res.status(400).json({ success: false, message: langParse.error });
    }
    const preferredLanguage = langParse.preferredLanguage;
    const [attemptAgg, recipient] = await Promise.all([
      opsAggregates.computeDayOverview({ dateIso, messageKind: selectedKind, opsProduct }),
      recipientAnalytics.computeRecipientDayOverview({
        dateIso,
        messageKind: selectedKind,
        slotTime: slotTimeNorm,
        opsProduct,
        preferredLanguage
      })
    ]);
    if (attemptAgg.error) {
      return res.status(400).json({ success: false, message: attemptAgg.error });
    }
    if (recipient.error) {
      return res.status(400).json({ success: false, message: recipient.error });
    }
    let recipientSlotTimeBreakdown = null;
    let recipientLanguageBreakdown = null;
    if (slotTimeNorm === 'all') {
      const br = await recipientAnalytics.computeRecipientSlotTimeBreakdown({
        dateIso,
        messageKind: selectedKind,
        opsProduct,
        preferredLanguage
      });
      if (!br.error) recipientSlotTimeBreakdown = br.data;
    }
    if (cohortIsIit && !preferredLanguage) {
      const langBr = await recipientAnalytics.computeRecipientLanguageBreakdown({
        dateIso,
        messageKind: selectedKind,
        slotTime: slotTimeNorm,
        opsProduct,
      });
      if (!langBr.error) recipientLanguageBreakdown = langBr.data;
    }
    const r = recipient.data;
    const cohortIds = Array.isArray(r._cohortSubmissionIds) ? [...r._cohortSubmissionIds] : [];
    const rPublic = { ...r };
    delete rPublic._cohortSubmissionIds;
    const range = rPublic.range || {};
    const debugOn = String(req.query.debug || '').trim() === '1';
    const [failureReasons, templateRank, diagnostics] = await Promise.all([
      recipientAnalytics.computeFailureReasonDistribution({
        cohortSlotDayIso: rPublic.filter?.date || dateIso,
        messageKind: selectedKind,
        formSubmissionIds: cohortIsIit ? null : cohortIds.length ? cohortIds : null,
        iitCounsellingSubmissionIds: cohortIsIit && cohortIds.length ? cohortIds : null,
        opsProduct
      }),
      selectedKind
        ? Promise.resolve([])
        : recipientAnalytics.computeTemplateReliabilityRanking({
            from: range.from,
            to: range.to,
            formSubmissionIds: cohortIsIit ? null : cohortIds.length ? cohortIds : null,
            iitCounsellingSubmissionIds: cohortIsIit && cohortIds.length ? cohortIds : null,
            opsProduct
          }),
      debugOn && cohortIds.length
        ? recipientAnalytics.computeCohortDayDiagnostics({
            dateIso: rPublic.filter?.date || dateIso,
            messageKind: selectedKind,
            cohortSubmissionIds: cohortIds,
            opsProduct
          })
        : Promise.resolve(null)
    ]);
    return res.json({
      success: true,
      data: {
        schemaVersion: rPublic.schemaVersion || 3,
        metricsMode: rPublic.metricsMode || 'recipient_primary_v3',
        metricDefinitions: rPublic.metricDefinitions || null,
        cohortAnchor: rPublic.cohortAnchor,
        filter: rPublic.filter,
        range: rPublic.range,
        bookedSlotsCount: rPublic.bookedSlotsCount,
        recipientTotals: rPublic.recipientTotals,
        exclusionBreakdown: rPublic.exclusionBreakdown,
        retryFunnelByAttempt: rPublic.retryFunnelByAttempt,
        retryFunnelReconciliation: rPublic.retryFunnelReconciliation || [],
        integrityWarnings: rPublic.integrityWarnings || [],
        retryQueue: rPublic.retryQueue,
        charts: {
          failureReasons,
          templateReliability: templateRank
        },
        attemptLevelMetrics: {
          description:
            'Internal diagnostic only — per WhatsAppMessageEvent row. Do not use for success-rate KPIs.',
          overall: attemptAgg.data.overall,
          selectedKindMetrics: attemptAgg.data.selectedKindMetrics,
          byKind: attemptAgg.data.byKind,
          byStatus: attemptAgg.data.byStatus,
          byAttempt: attemptAgg.data.byAttempt,
          retry2Exclusions: attemptAgg.data.retry2Exclusions,
          uniqueRecipientsDeliveredRead: attemptAgg.data.uniqueRecipientsDeliveredRead
        },
        /** @deprecated Use attemptLevelMetrics */
        slotCohortAttemptMetrics: {
          overall: attemptAgg.data.overall,
          selectedKindMetrics: attemptAgg.data.selectedKindMetrics,
          byKind: attemptAgg.data.byKind,
          byStatus: attemptAgg.data.byStatus,
          byAttempt: attemptAgg.data.byAttempt,
          retry2Exclusions: attemptAgg.data.retry2Exclusions,
          uniqueRecipientsDeliveredRead: attemptAgg.data.uniqueRecipientsDeliveredRead
        },
        ...(recipientSlotTimeBreakdown ? { recipientSlotTimeBreakdown } : {}),
        ...(recipientLanguageBreakdown ? { recipientLanguageBreakdown } : {}),
        ...(debugOn && diagnostics && !diagnostics.error
          ? { diagnostics: diagnostics.data }
          : {})
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.listCronRuns = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 25, 100);
    const page = clampInt(req.query.page, 1, 5000);
    const skip = (page - 1) * limit;
    const filter = {};
    const { from, to } = dateRange(req.query);
    if (from) filter.startedAt = { $gte: from, $lte: to };
    if (req.query.jobKey) filter.jobKey = req.query.jobKey;
    if (req.query.success === 'true') filter.success = true;
    if (req.query.success === 'false') filter.success = false;

    const [runs, total] = await Promise.all([
      MessagingCronRun.find(filter).sort({ startedAt: -1 }).skip(skip).limit(limit).lean(),
      MessagingCronRun.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: runs,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
      total
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getCronRunDetail = async (req, res) => {
  try {
    const run = await MessagingCronRun.findById(req.params.id).lean();
    if (!run) return res.status(404).json({ success: false, message: 'Not found' });
    const events = await WhatsAppMessageEvent.find({ cronRunId: run._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data: { run, linkedEvents: events } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.listMessages = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 25, 100);
    const page = clampInt(req.query.page, 1, 5000);
    const skip = (page - 1) * limit;
    const clauses = [];
    const { from, to } = dateRange(req.query);
    const base = {};
    if (from || to) {
      base.createdAt = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {})
      };
    }
    if (req.query.phone) base.phone = String(req.query.phone).replace(/\D/g, '').slice(-10);
    if (req.query.messageKind) base.messageKind = req.query.messageKind;
    if (req.query.status) {
      const parts = String(req.query.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 1) base.status = { $in: parts };
      else base.status = parts[0];
    }
    if (req.query.cronJobKey) base.cronJobKey = req.query.cronJobKey;
    if (req.query.retryGroupId && mongoose.Types.ObjectId.isValid(String(req.query.retryGroupId))) {
      base.retryGroupId = new mongoose.Types.ObjectId(String(req.query.retryGroupId));
    }
    if (req.query.attemptNumber != null && req.query.attemptNumber !== '') {
      const an = parseInt(String(req.query.attemptNumber), 10);
      if (an >= 1 && an <= 3) base.attemptNumber = an;
    }
    if (req.query.retryEligible === 'true') base.retryEligible = true;
    if (req.query.retryEligible === 'false') base.retryEligible = false;
    if (req.query.gupshupMessageId) base.gupshupMessageId = req.query.gupshupMessageId;

    if (req.query.errorCode != null && String(req.query.errorCode).trim()) {
      const code = String(req.query.errorCode).trim().slice(0, 32);
      const codeEsc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clauses.push({
        $or: [
          { webhookErrorCode: code },
          { sendErrorCode: code },
          { errorMessage: new RegExp(`\\(#${codeEsc}\\)`) }
        ]
      });
    }

    const opsProduct = parseOpsProductQuery(req.query.opsProduct ?? req.query.tenant);
    const langParse = parsePreferredLanguageFromQuery(req, opsProduct);
    if (langParse.error) {
      return res.status(400).json({ success: false, message: langParse.error });
    }
    if (langParse.preferredLanguage) {
      Object.assign(base, matchWhatsAppEventsByOpsProduct('iit_counselling'));
      let iitFilter = {
        'iitCounselling.section2Data.preferredLanguage': langParse.preferredLanguage
      };
      const dateIso =
        typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date.trim())
          ? req.query.date.trim()
          : null;
      if (dateIso) {
        const range = istDayRangeFromIso(dateIso);
        if (range) {
          iitFilter = {
            ...iitFilter,
            counsellingSlotInstantUtc: { $gte: range.from, $lte: range.to }
          };
        }
      }
      const iitIds = await IitCounsellingSubmission.distinct('_id', iitFilter);
      if (!iitIds.length) {
        return res.json({
          success: true,
          data: [],
          page,
          limit,
          total: 0,
          totalPages: 0
        });
      }
      base.iitCounsellingSubmissionId = { $in: iitIds };
    } else {
      Object.assign(base, matchWhatsAppEventsByOpsProduct(opsProduct));
    }

    if (Object.keys(base).length) clauses.push(base);

    if (req.query.name && String(req.query.name).trim()) {
      const re = new RegExp(String(req.query.name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const subs = await FormSubmission.find({ fullName: re }).select('_id phone').limit(3000).lean();
      const idSet = subs.map((s) => s._id);
      const phones = subs.map((s) => s.phone);
      clauses.push({
        $or: [{ formSubmissionId: { $in: idSet } }, { phone: { $in: phones } }]
      });
    }

    const filter = clauses.length <= 1 ? (clauses[0] || {}) : { $and: clauses };

    let total;
    let events;
    [events, total] = await Promise.all([
      WhatsAppMessageEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      WhatsAppMessageEvent.countDocuments(filter)
    ]);

    const subIds = [...new Set(events.map((e) => e.formSubmissionId).filter(Boolean))];
    const iitIds = [...new Set(events.map((e) => e.iitCounsellingSubmissionId).filter(Boolean))];
    const [subs, iitSubs] = await Promise.all([
      subIds.length
        ? FormSubmission.find({ _id: { $in: subIds } })
            .select('fullName phone step3Data whatsappDeliveryStatus whatsappLastWebhookAt whatsappLastError whatsappRetryCount whatsappRetryKind lastWhatsappAttemptAt whatsappLastMessageId')
            .lean()
        : [],
      iitIds.length
        ? IitCounsellingSubmission.find({ _id: { $in: iitIds } }).select('fullName phone iitCounselling').lean()
        : [],
    ]);
    const subMap = Object.fromEntries(subs.map((s) => [String(s._id), s]));
    const iitMap = Object.fromEntries(iitSubs.map((s) => [String(s._id), s]));

    const rows = events.map((e) => {
      const fs = e.formSubmissionId ? subMap[String(e.formSubmissionId)] : null;
      const iit = e.iitCounsellingSubmissionId ? iitMap[String(e.iitCounsellingSubmissionId)] : null;
      const eventStatus = e.status || null;
      const deliveryStatus = mapEventStatusToDeliveryStatus(eventStatus);
      const retryCount = Number.isFinite(e.retryCountSnapshot)
        ? e.retryCountSnapshot
        : (Number.isFinite(fs?.whatsappRetryCount) ? fs.whatsappRetryCount : 0);
      const providerErr = resolveProviderErrorDisplay(e);
      const failureReason =
        providerErr.errorReason || e.errorMessage || fs?.whatsappLastError || null;
      const failCopy = describeOpsFailure({
        ...e,
        errorCode: providerErr.errorCode,
        errorReason: providerErr.errorReason,
        errorSource: providerErr.errorSource,
        errorMessage: failureReason,
        lifecycleState: e.status,
      });
      return {
        ...e,
        userName: fs?.fullName || fs?.step1Data?.fullName || iit?.fullName || null,
        preferredLanguage: iit?.iitCounselling?.section2Data?.preferredLanguage || null,
        slotDate: fs?.step3Data?.slotDate || iit?.counsellingSlotInstantUtc || null,
        slotId: fs?.step3Data?.selectedSlot || null,
        submissionDeliveryStatus: fs?.whatsappDeliveryStatus,
        submissionLastWebhookAt: fs?.whatsappLastWebhookAt,
        derivedStatus: fs ? deriveSubmissionWaStatus(fs) : null,
        whatsappRetryCountSnap: fs?.whatsappRetryCount,
        deliveryStatus,
        failureReason: failCopy.detail || failureReason,
        errorCode: providerErr.errorCode,
        errorReason: providerErr.errorReason,
        errorSource: providerErr.errorSource,
        errorHeadline: failCopy.headline,
        errorDetail: failCopy.detail,
        errorCategory: failCopy.category,
        retryCount,
        sentAt: e.sentAt || e.createdAt || null
      };
    });

    res.json({
      success: true,
      data: rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getMessageTimeline = async (req, res) => {
  try {
    const ev = await WhatsAppMessageEvent.findById(req.params.id).lean();
    if (!ev) return res.status(404).json({ success: false, message: 'Not found' });
    const or = [{ phone: ev.phone, receivedAt: { $gte: new Date(ev.createdAt) } }];
    if (ev.gupshupMessageId) or.push({ messageId: ev.gupshupMessageId });

    const webhooks = await WhatsAppWebhookEvent.find({ $or: or })
      .sort({ receivedAt: 1 })
      .limit(200)
      .lean();

    const webhooksEnriched = webhooks.map((w) => {
      const parsed = parseWebhookPayloadForErrors(w.rawPayloadSnippet);
      return {
        ...w,
        parsedErrorCode: parsed.errorCode,
        parsedErrorReason: parsed.errorReason
      };
    });

    let submission = null;
    if (ev.formSubmissionId) {
      submission = await FormSubmission.findById(ev.formSubmissionId).lean();
    }

    res.json({
      success: true,
      data: {
        event: ev,
        webhooks: webhooksEnriched,
        submissionSummary: submission,
        providerError: (() => {
          const pe = resolveProviderErrorDisplay(ev);
          const copy = describeOpsFailure({ ...ev, ...pe, errorCode: pe.errorCode, lifecycleState: ev.status });
          return { ...pe, ...copy };
        })()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.retriesAnalytics = async (req, res) => {
  try {
    const evtMatch = {};
    const { from, to } = dateRange(req.query);
    if (from) evtMatch.createdAt = { $gte: from, $lte: to };

    const [rollup] = await WhatsAppMessageEvent.aggregate([
      { $match: evtMatch },
      {
        $facet: {
          exhaustedSamples: [{
            $match: { status: 'retry_exhausted' }
          }, { $sort: { createdAt: -1 } }, { $limit: 50 }],
          exhaustedCount: [{
            $match: { status: 'retry_exhausted' }
          }, { $count: 'c' }],
          avgRetrySnap: [{
            $group: { _id: null, avg: { $avg: '$retryCountSnapshot' }, n: { $sum: 1 } }
          }],
          failWithRetry: [{
            $match: { retryCountSnapshot: { $gt: 0 } }
          }, { $count: 'c' }],
          kindBreakdown: [{ $group: { _id: '$messageKind', c: { $sum: 1 } } }]
        }
      }
    ]);

    const exhaustedSamples = (rollup.exhaustedSamples || []).map((e) => ({
      phone: e.phone,
      messageKind: e.messageKind,
      errorMessage: e.errorMessage,
      createdAt: e.createdAt,
      retryCountSnapshot: e.retryCountSnapshot
    }));

    const retrySuccessMatch = {
      ...(from ? { createdAt: { $gte: from, $lte: to } } : {}),
      status: { $in: ['submitted', 'sent', 'delivered', 'read'] },
      retryCountSnapshot: { $gt: 0 }
    };

    let successAfterRetriesBySnap = [];
    try {
      successAfterRetriesBySnap = await WhatsAppMessageEvent.aggregate([
        { $match: retrySuccessMatch },
        { $group: { _id: '$retryCountSnapshot', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]);
    } catch {
      successAfterRetriesBySnap = [];
    }

    const exhaustedTotal = rollup.exhaustedCount[0]?.c || 0;

    res.json({
      success: true,
      data: {
        exhaustedCount: exhaustedTotal,
        exhaustedSamples,
        averageRetrySnap: rollup.avgRetrySnap[0]?.avg || null,
        kindBreakdown: rollup.kindBreakdown.map((x) => ({ kind: x._id, count: x.c })),
        successAfterRetriesBySnap,
        totals: {
          exhausted: exhaustedTotal,
          eventsWithRetries: rollup.failWithRetry[0]?.c || 0
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.listWebhooks = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 25, 100);
    const page = clampInt(req.query.page, 1, 5000);
    const skip = (page - 1) * limit;
    const filter = {};
    const { from, to } = dateRange(req.query);
    if (from) filter.receivedAt = { $gte: from, $lte: to };
    if (req.query.phone) filter.phone = String(req.query.phone).replace(/\D/g, '').slice(-10);
    if (req.query.messageId) filter.messageId = req.query.messageId;

    const [rows, total] = await Promise.all([
      WhatsAppWebhookEvent.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit).lean(),
      WhatsAppWebhookEvent.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.failuresRollup = async (req, res) => {
  try {
    const match = { errorMessage: { $nin: [null, ''] } };
    const { from, to } = dateRange(req.query);
    if (from) match.createdAt = { $gte: from, $lte: to };

    const groups = await WhatsAppMessageEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $substrCP: ['$errorMessage', 0, 200] },
          count: { $sum: 1 },
          latest: { $max: '$createdAt' },
          sampleId: { $first: '$_id' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 80 }
    ]);

    res.json({ success: true, data: groups });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

function csvEscape(s) {
  if (s == null) return '';
  const t = String(s).replace(/"/g, '""');
  return `"${t}"`;
}

exports.exportCsv = async (req, res) => {
  try {
    const type = (req.query.type || 'messages').toLowerCase();
    const limit = clampInt(req.query.limit, 5000, 20000);

    let rows = [];
    if (type === 'messages') {
      rows = await WhatsAppMessageEvent.find().sort({ createdAt: -1 }).limit(limit).lean();
    } else if (type === 'cron') {
      rows = await MessagingCronRun.find().sort({ startedAt: -1 }).limit(limit).lean();
    } else if (type === 'webhooks') {
      rows = await WhatsAppWebhookEvent.find().sort({ receivedAt: -1 }).limit(limit).lean();
    } else if (type === 'failures') {
      rows = await WhatsAppMessageEvent.find({ errorMessage: { $nin: [null, ''] } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    } else {
      return res.status(400).json({ success: false, message: 'Invalid type' });
    }

    if (rows.length === 0) {
      res.header('Content-Type', 'text/csv');
      return res.send('');
    }

    const keys = Object.keys(rows[0]).filter((k) => !['__v'].includes(k));
    const headerLine = keys.join(',');
    const lines = rows.map((r) =>
      keys
        .map((k) => {
          let v = r[k];
          if (v instanceof Date) v = v.toISOString();
          if (v && typeof v === 'object') v = JSON.stringify(v);
          return csvEscape(v);
        })
        .join(',')
    );

    const filename = `${type}-export-${Date.now()}.csv`;
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send([headerLine, ...lines].join('\n'));
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

function dispatchKindToSendFn(kind) {
  return manualRecoveryService.dispatchKindToSendFn(kind);
}

exports.manualResend = async (req, res) => {
  try {
    const {
      phone,
      formSubmissionId,
      iitCounsellingSubmissionId,
      messageKind,
      confirmReconcileRisk,
      opsProduct: bodyOpsProduct,
    } = req.body || {};
    const kind = messageKind || 'slot_booked';
    const opsProduct = parseOpsProductQuery(bodyOpsProduct);
    const kindErr = validateMessageKindForOpsProduct(kind, opsProduct);
    if (kindErr) return res.status(400).json({ success: false, message: kindErr });

    const sendFn = dispatchKindToSendFn(kind);
    if (!sendFn) return res.status(400).json({ success: false, message: 'Invalid messageKind' });

    const p =
      phone != null
        ? String(phone).replace(/\D/g, '').slice(-10)
        : null;
    const resolved = await manualRecoveryService.resolveRecipientForRecovery({
      phone: p,
      messageKind: kind,
      opsProduct,
      lineage: {
        formSubmissionId: formSubmissionId || null,
        iitCounsellingSubmissionId: iitCounsellingSubmissionId || null,
      },
    });
    if (resolved.error) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }

    const phone10 = p || resolved.iitSub?.phone || resolved.formSub?.phone;
    if (!phone10) {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }

    const now = new Date();
    const latestEvent = await WhatsAppMessageEvent.findOne({
      messageKind: kind,
      phone: phone10,
    })
      .sort({ createdAt: -1 })
      .select('status reconcileDerivedFailure reconcileFinalityUntil')
      .lean();

    if (latestEvent && isManualRecoveryBlocked(latestEvent, now)) {
      return res.status(409).json({
        success: false,
        code: 'reconcile_grace_active',
        message: 'Recipient is in delayed-DLR reconciliation grace and cannot be manually resent yet.',
      });
    }

    if (latestEvent && isRiskyReconcileRecovery(latestEvent, now)) {
      if (confirmReconcileRisk !== true) {
        return res.status(409).json({
          success: false,
          code: 'reconcile_risk_confirmation_required',
          message: RECONCILE_RECOVERY_RISK_WARNING,
          requiresConfirmation: true,
          riskWarning: RECONCILE_RECOVERY_RISK_WARNING,
        });
      }
    }

    const {
      isIitReminderMessageKind,
      resolveIitReminderTemplateEnvKey,
      resolveIitSlotBookedTemplateEnvKey,
    } = require('../utils/iitCounsellingWhatsApp');

    const IIT_LABEL_TO_SLOT_ID = {
      'Wednesday 6PM': 'WEDNESDAY_6PM',
      'Saturday 6PM': 'SATURDAY_6PM',
      'Sunday 11AM': 'SUNDAY_11AM',
    };

    let r;
    if (resolved.opsProduct === 'iit_counselling' && isIitReminderMessageKind(kind)) {
      const iitSub = resolved.iitSub;
      const slotBooking = iitSub.iitCounselling?.section1Data?.slotBooking || '';
      const preferredLanguage = iitSub.iitCounselling?.section2Data?.preferredLanguage || '';
      const templateEnvKey = resolveIitReminderTemplateEnvKey({
        slotBooking,
        preferredLanguage,
        reminderKind: kind,
      });
      const fullName = iitSub.fullName || iitSub.iitCounselling?.section1Data?.fullName || 'Student';
      r = await safeSendWhatsApp({
        phone10,
        formSubmissionId: null,
        iitCounsellingSubmissionId: iitSub._id,
        vars: { name: fullName },
        retryKind: kind,
        source: 'admin_manual',
        sendFn,
        opsProduct: 'iit_counselling',
        cohortSlotInstantUtc: iitSub.counsellingSlotInstantUtc || null,
        explicitTemplateEnvKey: templateEnvKey || undefined,
      });
    } else if (resolved.opsProduct === 'iit_counselling' && kind === 'slot_booked') {
      const iitSub = resolved.iitSub;
      const slotBooking = String(iitSub.iitCounselling?.section1Data?.slotBooking || '').trim();
      const iitTplKey = resolveIitSlotBookedTemplateEnvKey(slotBooking);
      const fullName = iitSub.fullName || iitSub.iitCounselling?.section1Data?.fullName || 'Student';
      r = await safeSendWhatsApp({
        phone10,
        formSubmissionId: null,
        iitCounsellingSubmissionId: iitSub._id,
        vars: buildSlotNotificationVariables({
          fullName,
          step3Data: {
            slotDate: iitSub.counsellingSlotInstantUtc,
            selectedSlot: IIT_LABEL_TO_SLOT_ID[slotBooking] || '',
          },
        }),
        retryKind: kind,
        source: 'admin_manual',
        sendFn,
        opsProduct: 'iit_counselling',
        cohortSlotInstantUtc: iitSub.counsellingSlotInstantUtc || null,
        ...(iitTplKey ? { explicitTemplateEnvKey: iitTplKey } : {}),
      });
    } else {
      const sub = resolved.formSub;
      const withMeetingLink = kind === 'meet' || kind === '30min';
      const vars = buildSlotNotificationVariables(sub, { withMeetingLink });
      r = await safeSendWhatsApp({
        phone10: sub.phone,
        formSubmissionId: sub._id,
        vars,
        retryKind: kind,
        source: 'admin_manual',
        sendFn,
        opsProduct: 'guidexpert',
      });
    }

    res.json({ success: !!r.success, data: r });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.previewRetries = async (req, res) => {
  try {
    const retryGroupId = req.query.retryGroupId;
    const promoteToAttempt = parseInt(String(req.query.promoteToAttempt || req.query.promote || '2'), 10);
    if (!retryGroupId || !mongoose.Types.ObjectId.isValid(String(retryGroupId))) {
      return res.status(400).json({ success: false, message: 'Valid retryGroupId query param required' });
    }
    const group = await WhatsAppRetryGroup.findById(retryGroupId).select('messageKind').lean();
    if (!group) return res.status(404).json({ success: false, message: 'Retry group not found' });
    if (!isCampaignStrategy(group.messageKind)) {
      return res.json({
        success: true,
        data: {
          retryGroupId,
          promoteToAttempt,
          dupBlocked: true,
          candidateCount: 0,
          phonesSample: [],
          blockedReason: 'slot_booked_uses_immediate_retry_only'
        }
      });
    }
    const data = await previewRetryPromotion(retryGroupId, promoteToAttempt);
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.executeRetries = async (req, res) => {
  try {
    const confirm = req.headers['x-whatsapps-confirm'] || req.headers['x-whatsapp-ops-confirm'];
    if (!confirm || String(confirm).trim().toUpperCase() !== 'RETRY') {
      return res.status(403).json({
        success: false,
        message: 'Send header x-whatsapp-ops-confirm: RETRY'
      });
    }

    const { retryGroupId, promoteToAttempt } = req.body || {};
    let attemptBatchId = req.body && req.body.attemptBatchId;
    if (!retryGroupId || !mongoose.Types.ObjectId.isValid(String(retryGroupId))) {
      return res.status(400).json({ success: false, message: 'retryGroupId required in body' });
    }
    const group = await WhatsAppRetryGroup.findById(retryGroupId).select('messageKind').lean();
    if (!group) return res.status(404).json({ success: false, message: 'Retry group not found' });
    if (!isCampaignStrategy(group.messageKind)) {
      return res.status(400).json({
        success: false,
        message: 'slot_booked is transactional and does not support campaign retry execute'
      });
    }
    const pta = parseInt(String(promoteToAttempt || ''), 10);
    if (pta !== 2 && pta !== 3) {
      return res.status(400).json({ success: false, message: 'promoteToAttempt must be 2 or 3' });
    }
    if (attemptBatchId != null && attemptBatchId !== '' && !mongoose.Types.ObjectId.isValid(String(attemptBatchId))) {
      return res.status(400).json({ success: false, message: 'Invalid attemptBatchId' });
    }
    if (attemptBatchId) {
      attemptBatchId = new mongoose.Types.ObjectId(String(attemptBatchId));
    }

    const data = await executeRetryAttempt({
      retryGroupId,
      nextAttempt: pta,
      attemptBatchId: attemptBatchId || undefined,
      source: 'retry_api',
      cronRunId: null,
      cronJobKey: null,
      requireRegistered: true
    });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.getRetryGroupDetail = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const group = await WhatsAppRetryGroup.findById(id).lean();
    if (!group) return res.status(404).json({ success: false, message: 'Not found' });

    const [c1, c2, c3, next2, next3] = await Promise.all([
      WhatsAppMessageEvent.countDocuments({ retryGroupId: group._id, attemptNumber: 1 }),
      WhatsAppMessageEvent.countDocuments({ retryGroupId: group._id, attemptNumber: 2 }),
      WhatsAppMessageEvent.countDocuments({ retryGroupId: group._id, attemptNumber: 3 }),
      computeRetryCandidates(group._id, 1),
      computeRetryCandidates(group._id, 2)
    ]);

    return res.json({
      success: true,
      data: {
        group,
        retryPolicy: getRetryPolicy(group.messageKind),
        countsByAttempt: { 1: c1, 2: c2, 3: c3 },
        previewNextAttempt2: { candidateCount: next2.candidateCount },
        previewNextAttempt3: { candidateCount: next3.candidateCount }
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

function emptyAttemptBuckets() {
  return {
    targeted: 0,
    submitted: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    inFlight: 0
  };
}

async function computeRetry2Exclusions(match, byAttempt) {
  const failedAtRetry1 = Number((byAttempt?.[2] || byAttempt?.['2'] || {}).failed || 0);
  const targetedAtRetry2 = Number((byAttempt?.[3] || byAttempt?.['3'] || {}).targeted || 0);
  const expectedGap = Math.max(0, failedAtRetry1 - targetedAtRetry2);
  const rows = await WhatsAppMessageEvent.aggregate([
    {
      $match: {
        ...match,
        attemptNumber: 2,
        retryExclusionReason: { $ne: null }
      }
    },
    { $group: { _id: '$retryExclusionReason', count: { $sum: 1 } } }
  ]);
  const byReason = {};
  rows.forEach((r) => {
    byReason[r._id] = r.count || 0;
  });
  const trackedExcluded = Object.values(byReason).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const residualUnclassified = Math.max(0, expectedGap - trackedExcluded);
  if (residualUnclassified > 0) {
    byReason.unclassified = residualUnclassified;
  }
  return {
    retry1Failed: failedAtRetry1,
    retry2Targeted: targetedAtRetry2,
    totalExcluded: expectedGap,
    trackedExcluded,
    byReason
  };
}

exports.getAttemptAnalytics = async (req, res) => {
  try {
    const messageKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    if (!messageKind || !ALLOWED_MESSAGE_KINDS.includes(messageKind)) {
      return res.status(400).json({
        success: false,
        message: `messageKind query param required. Allowed: ${ALLOWED_MESSAGE_KINDS.join(', ')}`
      });
    }
    const dateIso = req.query.date ? String(req.query.date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const opsProduct = parseOpsProductQuery(req.query.opsProduct ?? req.query.tenant);
    const prefix = opsAggregates.slotDayIstPrefixStages(dateIso, messageKind, opsProduct);
    if (!prefix) return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD (IST anchor)' });

    const { range, stages: prefixStages } = prefix;

    const extraMatch = [];
    if (req.query.retryGroupId && mongoose.Types.ObjectId.isValid(String(req.query.retryGroupId))) {
      extraMatch.push({
        $match: { retryGroupId: new mongoose.Types.ObjectId(String(req.query.retryGroupId)) }
      });
    }
    if (req.query.attemptNumber != null && req.query.attemptNumber !== '') {
      const an = parseInt(String(req.query.attemptNumber), 10);
      if (an >= 1 && an <= 3) extraMatch.push({ $match: { attemptNumber: an } });
    }

    const rows = await WhatsAppMessageEvent.aggregate([
      ...prefixStages,
      ...extraMatch,
      {
        $facet: {
          perAttempt: [
            {
              $group: {
                _id: '$attemptNumber',
                targeted: { $sum: 1 },
                submitted: {
                  $sum: {
                    $cond: [{ $in: ['$status', ['submitted', 'sent', 'delivered', 'read']] }, 1, 0]
                  }
                },
                sent: {
                  $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] }
                },
                delivered: {
                  $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] }
                },
                read: { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
                failed: {
                  $sum: { $cond: [{ $in: ['$status', ['failed', 'retry_exhausted']] }, 1, 0] }
                },
                inFlight: {
                  $sum: {
                    $cond: [{ $in: ['$status', ['queued', 'submitted', 'retry_pending', 'sent']] }, 1, 0]
                  }
                }
              }
            }
          ],
          uniqDeliv: [
            { $match: { status: { $in: ['delivered', 'read'] } } },
            { $group: { _id: '$phone' } },
            { $count: 'c' }
          ]
        }
      }
    ]);

    const facet = rows[0] || {};
    const byAttemptRaw = facet.perAttempt || [];
    const byAttempt = {
      1: emptyAttemptBuckets(),
      2: emptyAttemptBuckets(),
      3: emptyAttemptBuckets()
    };
    byAttemptRaw.forEach((row) => {
      const k = row._id;
      if (!byAttempt[k]) return;
      byAttempt[k] = {
        targeted: row.targeted || 0,
        submitted: row.submitted || 0,
        sent: row.sent || 0,
        delivered: row.delivered || 0,
        read: row.read || 0,
        failed: row.failed || 0,
        inFlight: row.inFlight || 0
      };
    });

    const retry2Exclusions = await opsAggregates.computeRetry2ExclusionsForPrefix(
      prefixStages,
      messageKind,
      byAttempt
    );

    return res.json({
      success: true,
      data: {
        cohortAnchor: 'booking_ist_slot_day',
        filter: {
          date: range.isoDate,
          messageKind,
          opsProduct,
          retryGroupId:
            req.query.retryGroupId && mongoose.Types.ObjectId.isValid(String(req.query.retryGroupId))
              ? String(req.query.retryGroupId)
              : null,
          attemptNumber: req.query.attemptNumber || null
        },
        range: { from: range.from, to: range.to },
        retryPolicy: getRetryPolicy(messageKind),
        byAttempt,
        retry2Exclusions,
        uniqueRecipientsDeliveredRead: facet.uniqDeliv?.[0]?.c || 0
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.triggerRetryBatch = async (req, res) => {
  try {
    const confirm = req.headers['x-whatsapps-confirm'] || req.headers['x-whatsapp-ops-confirm'];
    if (!confirm || String(confirm).trim().toUpperCase() !== 'RETRY') {
      return res.status(403).json({
        success: false,
        message: 'Send header x-whatsapp-ops-confirm: RETRY'
      });
    }

    let cronRun = await MessagingCronRun.create({
      jobKey: 'retry_whatsapp',
      startedAt: new Date(),
      success: false,
      trigger: 'manual',
      triggeredBy: req.admin?.username || 'admin',
      stats: {}
    });

    try {
      const batch = await executeRetryWhatsAppBatch(cronRun._id);
      const finishedAt = new Date();
      const durationMs = finishedAt - new Date(cronRun.startedAt).getTime();
      await MessagingCronRun.updateOne(
        { _id: cronRun._id },
        {
          $set: {
            finishedAt,
            durationMs,
            success: true,
            stats: {
              found: batch.found,
              groupsTouched: batch.groupsTouched,
              smsSent: 0,
              smsFailed: 0,
              waAttempted: batch.attempted,
              waSucceeded: batch.succeeded,
              waFailed: batch.failed,
              retriesAttempted: batch.attempted,
              flagsUpdated: 0
            }
          }
        }
      );

      res.json({
        success: true,
        data: batch
      });
    } catch (e) {
      const finishedAt = new Date();
      await MessagingCronRun.updateOne(
        { _id: cronRun._id },
        {
          $set: {
            finishedAt,
            durationMs: finishedAt - new Date(cronRun.startedAt).getTime(),
            success: false,
            errorSummary: e.message
          }
        }
      );
      throw e;
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Compute aggregate(s) for the requested scope and persist a snapshot keyed by
 * deterministic scopeKey. Always writes a single row per scope (upsert), so a
 * subsequent capture refreshes the chart payload while live aggregates stay
 * available on the legacy endpoints.
 *
 * Body / query params:
 *   - scope: 'summary' | 'month' | 'day' | 'all' (defaults to 'summary')
 *   - month: YYYY-MM (when scope=month or all)
 *   - date: YYYY-MM-DD (when scope=day or all)
 *   - slotTime: all | 11AM | 3PM | 6PM | 7PM (when scope=day or all; optional, default all)
 *   - from / to: ISO strings (when scope=summary or all)
 *   - messageKind: optional filter
 */
exports.captureSnapshot = async (req, res) => {
  try {
    const params = { ...req.query, ...(req.body || {}) };
    const scope = String(params.scope || 'summary').toLowerCase();
    const messageKind = params.messageKind ? String(params.messageKind).trim() : null;
    const opsProduct = parseOpsProductQuery(params.opsProduct ?? params.tenant);
    const cohortIsIit = opsProduct === 'iit_counselling';
    const snapLangNorm = recipientAnalytics.normalizePreferredLanguageParam(params.preferredLanguage);
    if (snapLangNorm === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Invalid preferredLanguage. Use Telugu or Hindi.'
      });
    }
    const preferredLanguage = cohortIsIit ? snapLangNorm : null;
    const username = req.admin?.username || null;
    const captures = [];
    const errors = [];

    const captureOne = async (entry) => {
      const { scopeKey, scope: scopeName, payload, range } = entry;
      const doc = await WhatsAppOpsChartSnapshot.findOneAndUpdate(
        { scopeKey },
        {
          $set: {
            scopeKey,
            scope: scopeName,
            messageKind: messageKind || null,
            range,
            payload,
            capturedAt: new Date(),
            capturedBy: username
          }
        },
        { upsert: true, new: true }
      ).lean();
      captures.push({
        scopeKey: doc.scopeKey,
        scope: doc.scope,
        capturedAt: doc.capturedAt,
        messageKind: doc.messageKind || null,
        range: doc.range || {}
      });
    };

    const wantSummary = scope === 'summary' || scope === 'all';
    const wantMonth = scope === 'month' || scope === 'all';
    const wantDay = scope === 'day' || scope === 'all';

    if (wantSummary) {
      const from = opsAggregates.parseBoundaryDate(params.from, 'start');
      const to = opsAggregates.parseBoundaryDate(params.to, 'end') || new Date();
      const summary = await opsAggregates.computeSummary({ from, to, messageKind, opsProduct });
      if (summary.error) {
        errors.push({ scope: 'summary', message: summary.error });
      } else {
        await captureOne({
          scopeKey: opsAggregates.buildScopeKey({
            scope: 'summary',
            messageKind,
            opsProduct,
            fromIso: from ? from.toISOString() : '',
            toIso: to ? to.toISOString() : ''
          }),
          scope: 'summary',
          payload: summary.data,
          range: {
            fromIso: from ? from.toISOString() : null,
            toIso: to ? to.toISOString() : null,
            monthIso: null,
            dateIso: null
          }
        });
      }
    }

    if (wantMonth) {
      const monthIso = params.month || new Date().toISOString().slice(0, 7);
      const [month, recipient] = await Promise.all([
        opsAggregates.computeMonthOverview({ monthIso, messageKind, opsProduct }),
        recipientAnalytics.computeRecipientMonthTrend({
          monthIso,
          messageKind,
          opsProduct,
          preferredLanguage
        })
      ]);
      if (month.error) {
        errors.push({ scope: 'month', message: month.error });
      } else {
        await captureOne({
          scopeKey: opsAggregates.buildScopeKey({
            scope: 'month',
            messageKind,
            monthIso,
            opsProduct,
            preferredLanguage
          }),
          scope: 'month',
          payload: {
            ...month.data,
            schemaVersion: 2,
            recipientTrendDays: recipient.error ? [] : recipient.data.days || []
          },
          range: { monthIso, dateIso: null, fromIso: null, toIso: null }
        });
      }
    }

    if (wantDay) {
      const dateIso = params.date || new Date().toISOString().slice(0, 10);
      const slotT = recipientAnalytics.normalizeSlotTimeParam(params.slotTime);
      if (slotT === null) {
        errors.push({
          scope: 'day',
          message: `Invalid slotTime. Use all, ${recipientAnalytics.ALLOWED_SLOT_TIME_SUFFIXES.join(', ')}.`
        });
      } else {
        const [day, recipient] = await Promise.all([
          opsAggregates.computeDayOverview({ dateIso, messageKind, opsProduct }),
          recipientAnalytics.computeRecipientDayOverview({
            dateIso,
            messageKind,
            slotTime: slotT,
            opsProduct,
            preferredLanguage
          })
        ]);
        if (day.error) {
          errors.push({ scope: 'day', message: day.error });
        } else if (recipient.error) {
          errors.push({ scope: 'day', message: recipient.error });
        } else {
          const rRaw = recipient.data;
          const cohortIds = Array.isArray(rRaw._cohortSubmissionIds) ? [...rRaw._cohortSubmissionIds] : [];
          const r = { ...rRaw };
          delete r._cohortSubmissionIds;
          const range = r.range || {};
          const [failureReasons, templateRank] = await Promise.all([
            recipientAnalytics.computeFailureReasonDistribution({
              cohortSlotDayIso: r.filter?.date || dateIso,
              messageKind,
              formSubmissionIds: cohortIsIit ? null : cohortIds.length ? cohortIds : null,
              iitCounsellingSubmissionIds: cohortIsIit && cohortIds.length ? cohortIds : null,
              opsProduct
            }),
            messageKind
              ? Promise.resolve([])
              : recipientAnalytics.computeTemplateReliabilityRanking({
                  from: range.from,
                  to: range.to,
                  formSubmissionIds: cohortIsIit ? null : cohortIds.length ? cohortIds : null,
                  iitCounsellingSubmissionIds: cohortIsIit && cohortIds.length ? cohortIds : null,
                  opsProduct
                })
          ]);
          await captureOne({
            scopeKey: opsAggregates.buildScopeKey({
              scope: 'day',
              messageKind,
              dateIso,
              slotTime: slotT,
              opsProduct,
              preferredLanguage
            }),
            scope: 'day',
            payload: {
              schemaVersion: 2,
              cohortAnchor: r.cohortAnchor,
              filter: r.filter,
              range: r.range,
              bookedSlotsCount: r.bookedSlotsCount != null ? r.bookedSlotsCount : day.data.bookedSlotsCount,
              recipientTotals: r.recipientTotals,
              exclusionBreakdown: r.exclusionBreakdown,
              retryFunnelByAttempt: r.retryFunnelByAttempt,
              retryQueue: r.retryQueue,
              charts: { failureReasons, templateReliability: templateRank },
              slotCohortAttemptMetrics: {
                overall: day.data.overall,
                selectedKindMetrics: day.data.selectedKindMetrics,
                byKind: day.data.byKind,
                byStatus: day.data.byStatus,
                byAttempt: day.data.byAttempt,
                retry2Exclusions: day.data.retry2Exclusions,
                uniqueRecipientsDeliveredRead: day.data.uniqueRecipientsDeliveredRead
              }
            },
            range: { dateIso, monthIso: null, fromIso: null, toIso: null, slotTime: slotT }
          });
        }
      }
    }

    if (!captures.length && errors.length) {
      return res.status(400).json({ success: false, message: errors[0].message, errors });
    }

    return res.json({
      success: true,
      data: {
        captures,
        capturedAt: captures.length ? captures[0].capturedAt : new Date(),
        capturedBy: username,
        errors: errors.length ? errors : undefined
      }
    });
  } catch (e) {
    console.error('[whatsapp-ops captureSnapshot]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Read the latest snapshot(s). Caller may either:
 *   - pass scopeKey directly, OR
 *   - pass { scope, messageKind, month, date, from, to } to derive scopeKey, OR
 *   - pass scope=all to fetch summary/month/day in one call.
 */
exports.getLatestSnapshot = async (req, res) => {
  try {
    const params = req.query || {};
    const messageKind = params.messageKind ? String(params.messageKind).trim() : null;
    const opsProduct = parseOpsProductQuery(params.opsProduct ?? params.tenant);
    const snapLangNorm = recipientAnalytics.normalizePreferredLanguageParam(params.preferredLanguage);
    if (snapLangNorm === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Invalid preferredLanguage. Use Telugu or Hindi.'
      });
    }
    const preferredLanguage = opsProduct === 'iit_counselling' ? snapLangNorm : null;

    if (params.scopeKey) {
      const doc = await WhatsAppOpsChartSnapshot.findOne({ scopeKey: String(params.scopeKey) }).lean();
      if (!doc) return res.json({ success: true, data: null });
      return res.json({ success: true, data: doc });
    }

    const scope = String(params.scope || 'summary').toLowerCase();
    const requested = scope === 'all' ? ['summary', 'month', 'day'] : [scope];
    const out = {};

    /* eslint-disable no-await-in-loop */
    for (const s of requested) {
      let scopeKey = null;
      if (s === 'summary') {
        const from = opsAggregates.parseBoundaryDate(params.from, 'start');
        const to = opsAggregates.parseBoundaryDate(params.to, 'end') || null;
        scopeKey = opsAggregates.buildScopeKey({
          scope: 'summary',
          messageKind,
          opsProduct,
          fromIso: from ? from.toISOString() : '',
          toIso: to ? to.toISOString() : '',
          preferredLanguage
        });
      } else if (s === 'month') {
        const monthIso = params.month || new Date().toISOString().slice(0, 7);
        scopeKey = opsAggregates.buildScopeKey({
          scope: 'month',
          messageKind,
          monthIso,
          opsProduct,
          preferredLanguage
        });
      } else if (s === 'day') {
        const dateIso = params.date || new Date().toISOString().slice(0, 10);
        const slotT = recipientAnalytics.normalizeSlotTimeParam(params.slotTime);
        const slotForKey = slotT === null ? 'all' : slotT;
        scopeKey = opsAggregates.buildScopeKey({
          scope: 'day',
          messageKind,
          dateIso,
          slotTime: slotForKey,
          opsProduct,
          preferredLanguage
        });
      }
      if (!scopeKey) {
        out[s] = null;
        continue;
      }
      const doc = await WhatsAppOpsChartSnapshot.findOne({ scopeKey }).lean();
      out[s] = doc || null;
    }
    /* eslint-enable no-await-in-loop */

    if (scope === 'all') {
      return res.json({ success: true, data: out });
    }
    return res.json({ success: true, data: out[scope] || null });
  } catch (e) {
    console.error('[whatsapp-ops getLatestSnapshot]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Build the unresolved candidates list for a single template. Read-only.
 * Body / query: { messageKind, from, to }
 */
exports.previewManualRecovery = async (req, res) => {
  try {
    const params = { ...req.query, ...(req.body || {}) };
    const messageKind = params.messageKind ? String(params.messageKind).trim() : null;
    if (!messageKind) {
      return res.status(400).json({ success: false, message: 'messageKind is required' });
    }
    const fromAt = opsAggregates.parseBoundaryDate(params.from, 'start');
    const toAt = opsAggregates.parseBoundaryDate(params.to, 'end');
    const opsProduct = parseOpsProductQuery(params.opsProduct || params.tenant);
    const langParse = parsePreferredLanguageFromQuery(req, opsProduct);
    if (langParse.error) {
      return res.status(400).json({ success: false, message: langParse.error });
    }

    const result = await manualRecoveryService.buildPreview({
      messageKind,
      fromAt,
      toAt,
      opsProduct,
      preferredLanguage: langParse.preferredLanguage,
    });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (e) {
    console.error('[whatsapp-ops previewManualRecovery]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Create a manual recovery job and start async execution.
 * Body: { messageKind, from?, to?, phones? } — when phones present, restrict to those.
 */
exports.startManualRecovery = async (req, res) => {
  try {
    const body = req.body || {};
    const messageKind = body.messageKind ? String(body.messageKind).trim() : null;
    if (!messageKind) {
      return res.status(400).json({ success: false, message: 'messageKind is required' });
    }
    const fromAt = opsAggregates.parseBoundaryDate(body.from, 'start');
    const toAt = opsAggregates.parseBoundaryDate(body.to, 'end');
    const explicitPhones = Array.isArray(body.phones)
      ? body.phones.map((p) => String(p || '').replace(/\D/g, '').slice(-10)).filter(Boolean)
      : null;

    const opsProduct = parseOpsProductQuery(body.opsProduct || body.tenant);
    const langParse = parsePreferredLanguageFromQuery(req, opsProduct);
    if (langParse.error) {
      return res.status(400).json({ success: false, message: langParse.error });
    }

    const preview = await manualRecoveryService.buildPreview({
      messageKind,
      fromAt,
      toAt,
      opsProduct,
      preferredLanguage: langParse.preferredLanguage,
    });
    if (preview.error) {
      return res.status(400).json({ success: false, message: preview.error });
    }
    let candidates = preview.data.candidates || [];
    if (explicitPhones && explicitPhones.length) {
      const allow = new Set(explicitPhones);
      candidates = candidates.filter((c) => allow.has(c.phone));
    }
    if (!candidates.length) {
      return res.status(400).json({
        success: false,
        message: 'No unresolved recipients to recover'
      });
    }

    const riskyCount = candidates.filter((c) => c.requiresConfirmation).length;
    if (riskyCount > 0 && body.confirmRiskyRecovery !== true) {
      return res.status(409).json({
        success: false,
        code: 'reconcile_risk_confirmation_required',
        message: `${riskyCount} recipient(s) require explicit confirmation before bulk recovery.`,
        riskyCount,
        requiresConfirmation: true,
        riskWarning: preview.data.warnings?.[0] || null,
        warnings: preview.data.warnings || []
      });
    }

    const phones = candidates.map((c) => c.phone);
    const LINEAGE_CAP = 500;
    const candidateLineage = candidates.slice(0, LINEAGE_CAP).map((c) => ({
      phone: c.phone,
      lineageId: c.lineageId || null,
      lastEventId: c.eventId || null,
      maxAttemptAtStart: Number(c.maxAttemptAtStart) || Number(c.attemptNumber) || 1,
      candidateCreatedAt: c.createdAt || null,
      iitCounsellingSubmissionId: c.iitCounsellingSubmissionId || null,
      formSubmissionId: c.formSubmissionId || null,
    }));

    const job = await WhatsAppManualRecoveryJob.create({
      status: 'queued',
      messageKind,
      opsProduct: parseOpsProductQuery(body.opsProduct || body.tenant),
      preferredLanguage: langParse.preferredLanguage || null,
      fromAt: fromAt || null,
      toAt: toAt || null,
      candidatePhones: phones,
      candidateLineage,
      createdBy: req.admin?.username || null,
      counters: {
        targeted: phones.length,
        attempted: 0,
        apiAccepted: 0,
        sendFailed: 0,
        skippedAlreadyDelivered: preview.data.skippedAlreadyDelivered || 0,
        skippedGlobalRecentSuccess: preview.data.skippedGlobalRecentSuccess || 0,
        skippedInFlightDuplicate: preview.data.skippedInFlightDuplicate || 0,
        skippedReconcileGrace: preview.data.skippedReconcileGrace || 0,
        skippedReconcilePending: preview.data.skippedReconcilePending || 0,
        skippedAwaitingFinalDlr: preview.data.skippedAwaitingFinalDlr || 0,
        skippedPermanent: 0,
        excluded: 0,
        delivered: 0,
        failed: 0,
        remaining: phones.length
      }
    });

    manualRecoveryService.startJobAsync(job._id);

    return res.json({
      success: true,
      data: {
        jobId: job._id,
        status: job.status,
        targeted: phones.length,
        skippedAlreadyDelivered: preview.data.skippedAlreadyDelivered || 0,
        skippedGlobalRecentSuccess: preview.data.skippedGlobalRecentSuccess || 0,
        skippedInFlightDuplicate: preview.data.skippedInFlightDuplicate || 0,
        skippedReconcileGrace: preview.data.skippedReconcileGrace || 0,
        riskyCount: preview.data.riskyCount || 0
      }
    });
  } catch (e) {
    console.error('[whatsapp-ops startManualRecovery]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.getManualRecoveryJob = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await WhatsAppManualRecoveryJob.findById(id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    /** Recompute post-start counters on read so polled progress reflects the latest
     *  webhook activity even when the worker loop has paused or is between phones. */
    let liveCounters = { ...(doc.counters || {}) };
    if (doc.startedAt) {
      try {
        const post = await manualRecoveryService.computePostStartCounters({
          startedAt: doc.startedAt,
          messageKind: doc.messageKind,
          candidatePhones: doc.candidatePhones || []
        });
        liveCounters = {
          ...liveCounters,
          recovered: post.recovered,
          inFlight: post.inFlight,
          delivered: post.delivered,
          failed: post.failed,
          excluded: post.excluded
        };
      } catch {
        /* fall back to persisted counters */
      }
    }

    const targeted = liveCounters.targeted || (doc.candidatePhones || []).length || 0;
    const recovered = liveCounters.recovered || 0;
    liveCounters.recoveryRatePct = targeted ? Math.round((recovered / targeted) * 1000) / 10 : 0;
    const completed = (liveCounters.attempted || 0)
      + (liveCounters.skippedAlreadyDelivered || 0)
      + (liveCounters.skippedGlobalRecentSuccess || 0)
      + (liveCounters.skippedInFlightDuplicate || 0);
    const percent = targeted ? Math.min(100, Math.round((completed / targeted) * 100)) : 0;

    return res.json({
      success: true,
      data: {
        _id: doc._id,
        status: doc.status,
        messageKind: doc.messageKind,
        counters: liveCounters,
        progressPercent: percent,
        createdAt: doc.createdAt,
        startedAt: doc.startedAt,
        finishedAt: doc.finishedAt,
        lastProgressAt: doc.lastProgressAt,
        cancelRequested: !!doc.cancelRequested,
        errorSummary: doc.errorSummary || null,
        createdBy: doc.createdBy || null,
        from: doc.fromAt || null,
        to: doc.toAt || null,
        candidatePhonesSample: (doc.candidatePhones || []).slice(0, 10),
        candidatePhonesCount: (doc.candidatePhones || []).length
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.listManualRecoveryJobs = async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 25, 100);
    const filter = {};
    if (req.query.messageKind) filter.messageKind = String(req.query.messageKind).trim();
    if (req.query.status) filter.status = String(req.query.status).trim();
    const rows = await WhatsAppManualRecoveryJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({
      success: true,
      data: rows.map((doc) => ({
        _id: doc._id,
        status: doc.status,
        messageKind: doc.messageKind,
        counters: doc.counters || {},
        createdAt: doc.createdAt,
        startedAt: doc.startedAt,
        finishedAt: doc.finishedAt,
        lastProgressAt: doc.lastProgressAt,
        createdBy: doc.createdBy || null,
        candidatePhonesCount: (doc.candidatePhones || []).length
      }))
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.cancelManualRecoveryJob = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await WhatsAppManualRecoveryJob.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (doc.status === 'completed' || doc.status === 'failed' || doc.status === 'cancelled') {
      return res.json({ success: true, data: { _id: doc._id, status: doc.status } });
    }
    doc.cancelRequested = true;
    await doc.save();
    return res.json({ success: true, data: { _id: doc._id, status: doc.status, cancelRequested: true } });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Operational health for the new Health Console.
 * Stable/closed window for charts/tables; today's strip is live-labelled.
 */
exports.getOperationalHealth = async (req, res) => {
  try {
    const messageKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    const asOfDateIso = req.query.date ? String(req.query.date).trim().slice(0, 10) : null;
    const windowDays = req.query.windowDays != null ? parseInt(String(req.query.windowDays), 10) : 14;
    const result = await opsAggregates.computeOperationalHealth({
      asOfDateIso,
      windowDays,
      messageKind
    });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (e) {
    console.error('[whatsapp-ops getOperationalHealth]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Paginated unresolved recipients for the Recovery Console.
 * Returns rows + grouped totals so the UI can paint tab counters in one round-trip.
 */
exports.getReminderJobsSummary = async (req, res) => {
  try {
    const slotDayIst = req.query.slotDayIst ? String(req.query.slotDayIst).trim() : null;
    const messageKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    const { getReminderJobObservability } = require('../utils/waReminderJobObservability');
    const data = await getReminderJobObservability({
      ...(slotDayIst ? { slotDayIst } : {}),
      ...(messageKind ? { messageKind } : {})
    });
    return res.json({ success: true, data });
  } catch (e) {
    console.error('[whatsapp-ops getReminderJobsSummary]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.repairReminderJobs = async (req, res) => {
  try {
    const {
      repairReminderJobLifecycle,
      recoverStuckReminderJobs,
      expireDueReminderJobs
    } = require('../services/whatsappReminderJobLifecycle');
    const messageKinds = req.body?.messageKinds || req.query?.messageKind
      ? [String(req.query.messageKind || req.body.messageKinds[0]).trim()]
      : null;
    const now = new Date();
    const [recover, expire, repair] = await Promise.all([
      recoverStuckReminderJobs({ now, messageKinds, limit: 200 }),
      expireDueReminderJobs({ now, messageKinds, limit: 500 }),
      repairReminderJobLifecycle({ now, messageKinds, limit: 100 })
    ]);
    return res.json({ success: true, data: { recover, expire, repair } });
  } catch (e) {
    console.error('[whatsapp-ops repairReminderJobs]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.getRecipientReminderTimeline = async (req, res) => {
  try {
    const FormSubmission = require('../models/FormSubmission');
    const WhatsAppReminderJob = require('../models/WhatsAppReminderJob');
    const WhatsAppMessageEvent = require('../models/WhatsAppMessageEvent');
    const WhatsAppWebhookEvent = require('../models/WhatsAppWebhookEvent');

    const formSubmissionId = req.query.formSubmissionId
      ? String(req.query.formSubmissionId).trim()
      : null;
    const phone = req.query.phone ? String(req.query.phone).replace(/\D/g, '').slice(-10) : null;

    let submission = null;
    if (formSubmissionId) {
      submission = await FormSubmission.findById(formSubmissionId).lean();
    } else if (phone) {
      submission = await FormSubmission.findOne({ phone }).lean();
    }
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }

    const subId = submission._id;
    const timeline = [];

    timeline.push({
      at: submission.createdAt,
      type: 'booking',
      source: 'form_submission',
      ids: { formSubmissionId: String(subId) },
      summary: `Registration; slot ${submission.step3Data?.slotDate || 'n/a'}`
    });

    const jobs = await WhatsAppReminderJob.find({ formSubmissionId: subId })
      .sort({ messageKind: 1 })
      .lean();
    for (const job of jobs) {
      timeline.push({
        at: job.createdAt,
        type: 'reminder_job_created',
        source: 'whatsapp_reminder_job',
        ids: {
          jobId: String(job._id),
          retryGroupId: job.retryGroupId ? String(job.retryGroupId) : null,
          messageKind: job.messageKind
        },
        summary: `Job ${job.messageKind} state=${job.state} scheduled=${job.scheduledSendAt}`
      });
      if (job.claimedAt) {
        timeline.push({
          at: job.claimedAt,
          type: 'reminder_job_claimed',
          source: 'whatsapp_reminder_job',
          ids: { jobId: String(job._id), claimToken: job.claimToken },
          summary: `Claimed by ${job.claimedBy || 'unknown'}`
        });
      }
      if (job.dispatchedAt) {
        timeline.push({
          at: job.dispatchedAt,
          type: 'reminder_job_dispatched',
          source: 'whatsapp_reminder_job',
          ids: {
            jobId: String(job._id),
            eventId: job.initialMessageEventId ? String(job.initialMessageEventId) : null
          },
          summary: `Dispatched attempt 1 (${job.messageKind})`
        });
      }
      if (job.suppressionReason === 'expired' && job.expiredAt) {
        timeline.push({
          at: job.expiredAt,
          type: 'reminder_job_expired',
          source: 'whatsapp_reminder_job',
          ids: { jobId: String(job._id) },
          summary: 'Expired — no further dispatch'
        });
      }
    }

    const groupIds = jobs.map((j) => j.retryGroupId).filter(Boolean);
    const events = groupIds.length
      ? await WhatsAppMessageEvent.find({ retryGroupId: { $in: groupIds } })
          .sort({ createdAt: 1 })
          .lean()
      : [];

    for (const ev of events) {
      timeline.push({
        at: ev.createdAt,
        type: 'whatsapp_event',
        source: 'whatsapp_message_event',
        ids: {
          eventId: String(ev._id),
          retryGroupId: ev.retryGroupId ? String(ev.retryGroupId) : null,
          messageId: ev.gupshupMessageId || ev.messageId || null
        },
        summary: `Attempt ${ev.attemptNumber} status=${ev.status}${ev.source ? ` source=${ev.source}` : ''}`
      });
    }

    const messageIds = events.map((e) => e.gupshupMessageId || e.messageId).filter(Boolean);
    if (messageIds.length) {
      const webhooks = await WhatsAppWebhookEvent.find({
        $or: [{ messageId: { $in: messageIds } }, { phone: submission.phone }]
      })
        .sort({ receivedAt: 1 })
        .limit(100)
        .lean();
      for (const wh of webhooks) {
        timeline.push({
          at: wh.receivedAt || wh.createdAt,
          type: 'webhook',
          source: 'whatsapp_webhook_event',
          ids: { messageId: wh.messageId || null },
          summary: `Webhook status=${wh.status || wh.eventType || 'update'}`
        });
      }
    }

    timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return res.json({
      success: true,
      data: {
        formSubmissionId: String(subId),
        phone: submission.phone,
        timeline
      }
    });
  } catch (e) {
    console.error('[whatsapp-ops getRecipientReminderTimeline]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.getUnresolvedRecipients = async (req, res) => {
  try {
    const params = req.query || {};
    const messageKind = params.messageKind ? String(params.messageKind).trim() : null;
    const group = params.group ? String(params.group).trim().toLowerCase() : 'all';
    const from = opsAggregates.parseBoundaryDate(params.from, 'start');
    const to = opsAggregates.parseBoundaryDate(params.to, 'end');
    const page = parseInt(String(params.page || '1'), 10) || 1;
    const limit = parseInt(String(params.limit || '50'), 10) || 50;
    const q = params.q != null && String(params.q).trim() ? String(params.q).trim() : null;

    const cohortDateIso = params.cohortDate
      ? String(params.cohortDate).trim()
      : params.cohortDateIso
        ? String(params.cohortDateIso).trim()
        : null;

    const opsProduct = parseOpsProductQuery(params.opsProduct || params.tenant);
    const langParse = parsePreferredLanguageFromQuery(req, opsProduct);
    if (langParse.error) {
      return res.status(400).json({ success: false, message: langParse.error });
    }

    const result = await opsAggregates.computeUnresolvedRecipients({
      from,
      to,
      messageKind,
      group,
      page,
      limit,
      q,
      cohortDateIso,
      opsProduct,
      preferredLanguage: langParse.preferredLanguage,
    });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (e) {
    console.error('[whatsapp-ops getUnresolvedRecipients]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * CSV export grouped by reason for the Recovery Console "Final Unresolved" panel.
 * Streams a single text/csv response; safe for thousands of recipients.
 */
/**
 * CSV: one row per recipient for IST slot-day cohort (canonical buckets).
 */
exports.exportRecipientSummaryCsv = async (req, res) => {
  try {
    const dateIso = String(req.query.date || req.query.dateIso || '').trim();
    const messageKind = req.query.messageKind ? String(req.query.messageKind).trim() : null;
    const slotTime = req.query.slotTime ? String(req.query.slotTime).trim() : 'all';
    const opsProduct = parseOpsProductQuery(req.query.opsProduct || req.query.tenant);

    const result = await recipientAnalytics.computeRecipientSummaryExportRows({
      dateIso,
      messageKind,
      slotTime,
      opsProduct
    });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }

    const escapeCell = (v) => {
      if (v == null) return '';
      const s = String(v);
      const inner = s.replace(/"/g, '""');
      const trimmed = s.trimStart();
      const mustQuote = /[",\r\n\t]/.test(s) || /^[=+\-@]/.test(trimmed);
      return mustQuote ? `"${inner}"` : inner;
    };
    const header =
      'slotDayIst,phone,messageKind,lineageId,canonicalBucket,canonicalExclusionReason,canonicalFailureReason,everDelivered,finalPermanentFailed,reconcilePending,transientUnresolved';
    const lines = (result.data.rows || []).map((r) =>
      [
        escapeCell(r.slotDayIst),
        escapeCell(r.phone),
        escapeCell(r.messageKind),
        escapeCell(r.lineageId),
        escapeCell(r.canonicalBucket),
        escapeCell(r.canonicalExclusionReason),
        escapeCell(r.canonicalFailureReason),
        escapeCell(r.everDelivered ? '1' : '0'),
        escapeCell(r.finalPermanentFailed ? '1' : '0'),
        escapeCell(r.reconcilePending ? '1' : '0'),
        escapeCell(r.transientUnresolved ? '1' : '0')
      ].join(',')
    );
    const csvBody = [header, ...lines].join('\r\n');
    const filename = `recipient-summary-${dateIso || 'day'}-${messageKind || 'all'}-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    return res.send(`\uFEFF${csvBody}`);
  } catch (e) {
    console.error('[whatsapp-ops exportRecipientSummaryCsv]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};

exports.exportUnresolvedCsv = async (req, res) => {
  try {
    const params = req.query || {};
    const messageKind = params.messageKind ? String(params.messageKind).trim() : null;
    const group = params.group ? String(params.group).trim().toLowerCase() : 'all';
    const from = opsAggregates.parseBoundaryDate(params.from, 'start');
    const to = opsAggregates.parseBoundaryDate(params.to, 'end');
    const q = params.q != null && String(params.q).trim() ? String(params.q).trim() : null;
    const cohortDateIso = params.cohortDate
      ? String(params.cohortDate).trim()
      : params.cohortDateIso
        ? String(params.cohortDateIso).trim()
        : null;

    const result = await opsAggregates.computeUnresolvedRecipients({
      from,
      to,
      messageKind,
      group,
      page: 1,
      limit: 200,
      q,
      cohortDateIso
    });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }

    /** Re-run the aggregation in pages to stream all rows. We bound to 5000 hard. */
    const pages = result.data.totalPages || 1;
    const rows = [...result.data.rows];
    for (let p = 2; p <= pages && rows.length < 5000; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      const next = await opsAggregates.computeUnresolvedRecipients({
        from,
        to,
        messageKind,
        group,
        page: p,
        limit: 200,
        q,
        cohortDateIso
      });
      if (next?.data?.rows?.length) rows.push(...next.data.rows);
    }

    /** Sort grouped by exclusionCategory, then reason, then phone for operator copy/paste UX. */
    rows.sort((a, b) => {
      const c = String(a.exclusionCategory || '').localeCompare(String(b.exclusionCategory || ''));
      if (c !== 0) return c;
      const r = String(a.reason || '').localeCompare(String(b.reason || ''));
      if (r !== 0) return r;
      return String(a.phone || '').localeCompare(String(b.phone || ''));
    });

    /** `91` + 10-digit mobile; CSV with phone + name (deduped by phone, first row wins). */
    const to91Line = (v) => {
      const d = String(v || '').replace(/\D/g, '');
      if (d.length < 10) return '';
      const national10 = d.slice(-10);
      if (!/^\d{10}$/.test(national10)) return '';
      return `91${national10}`;
    };
    const escapeCell = (v) => {
      if (v == null) return '';
      const s = String(v);
      const inner = s.replace(/"/g, '""');
      const trimmed = s.trimStart();
      const mustQuote = /[",\r\n\t]/.test(s) || /^[=+\-@]/.test(trimmed);
      return mustQuote ? `"${inner}"` : inner;
    };
    const header =
      'phone,name,messageKind,canonicalBucket,canonicalExclusionReason,retriesAttempted,retryGroupId,exclusionReason,operatorReason,errorCode,errorReason,errorSource,eventRows';
    const seen = new Set();
    const lines = [];
    for (const r of rows) {
      const phone = to91Line(r.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      const name = r.name != null ? String(r.name) : '';
      const mk = r.messageKind != null ? String(r.messageKind) : '';
      const attempts = r.lastAttemptNumber != null ? String(r.lastAttemptNumber) : '';
      const rg = r.retryGroupId != null ? String(r.retryGroupId) : '';
      const excl = r.exclusionReason != null ? String(r.exclusionReason) : '';
      const opReason = r.reason != null ? String(r.reason) : '';
      const hist = r.retryHistoryCount != null ? String(r.retryHistoryCount) : '';
      const errCode = r.errorCode != null ? String(r.errorCode) : '';
      const errReason = r.errorReason != null ? String(r.errorReason) : '';
      const errSrc = r.errorSource != null ? String(r.errorSource) : '';
      lines.push(
        [
          escapeCell(phone),
          escapeCell(name),
          escapeCell(mk),
          escapeCell(r.canonicalBucket || ''),
          escapeCell(r.canonicalExclusionReason || opReason),
          escapeCell(attempts),
          escapeCell(rg),
          escapeCell(excl),
          escapeCell(opReason),
          escapeCell(errCode),
          escapeCell(errReason),
          escapeCell(errSrc),
          escapeCell(hist)
        ].join(',')
      );
    }
    const csvBody = [header, ...lines].join('\r\n');

    const filename = `unresolved-phones-${messageKind || 'all'}-${group}-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    return res.send(`\uFEFF${csvBody}`);
  } catch (e) {
    console.error('[whatsapp-ops exportUnresolvedCsv]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
};
