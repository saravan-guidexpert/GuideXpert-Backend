const express = require('express');
const router = express.Router();
const FormSubmission = require('../models/FormSubmission');
const MessagingCronRun = require('../models/MessagingCronRun');
const { CRON_JOB_KEYS } = MessagingCronRun;
const { executeRetryWhatsAppBatch } = require('../services/retryWhatsAppBatch');
const { isOsviConfigured } = require('../utils/osviService');
const { processOsviOutboundForPhone } = require('../utils/osviOutboundProcessor');
const { hasCronSecretConfigured, isValidCronSecret } = require('../utils/cronSecret');
const {
  cronFailurePayload,
  logDbError,
  safeErrorSummary,
} = require('../utils/mongoRetry');
const {
  dispatchDueReminderJobs,
  cronJobKeyForKind
} = require('../services/whatsappReminderJobDispatcher');

function verifyCronSecret(req, res, next) {
  if (!hasCronSecretConfigured()) {
    console.error('[Cron] No cron secret — set GUIDEXPERT_CRON_SECRET or CRON_SECRET');
    return res.status(500).json({ success: false, message: 'Cron not configured' });
  }

  const queryKey = req.query.key;
  const headerKey = req.headers['x-cron-key'];
  const authHeader = req.headers.authorization || req.headers.Authorization;
  let bearerKey;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    bearerKey = authHeader.slice(7).trim();
  }

  const providedKey = queryKey || headerKey || bearerKey;

  if (!isValidCronSecret(providedKey)) {
    console.warn(
      JSON.stringify({
        event: 'cron_auth_failed',
        path: req.path,
        mode: bearerKey ? 'bearer' : headerKey ? 'x-cron-key' : queryKey ? 'query' : 'none',
      })
    );
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const authMode = bearerKey ? 'bearer' : (headerKey ? 'x-cron-key' : 'query');
  console.log('[Cron] Authenticated request', {
    path: req.path,
    mode: authMode,
    userAgent: req.headers['user-agent'] || 'unknown'
  });

  next();
}

async function startCronRun(jobKey) {
  return MessagingCronRun.create({
    jobKey,
    startedAt: new Date(),
    success: false,
    trigger: 'cron',
    stats: {}
  });
}

async function finishCronRun(run, baseStats, overrides = {}) {
  const finishedAt = new Date();
  const durationMs = run && run.startedAt ? finishedAt - new Date(run.startedAt).getTime() : null;
  const mergedStats = { ...baseStats, ...(overrides.stats || {}) };
  await MessagingCronRun.updateOne(
    { _id: run._id },
    {
      $set: {
        finishedAt,
        durationMs,
        stats: mergedStats,
        success: overrides.success !== undefined ? overrides.success : true,
        errorSummary: overrides.errorSummary ?? null
      }
    }
  );
}

async function failCron(res, error, label, cronRun) {
  logDbError(label, error);
  if (cronRun) {
    await finishCronRun(
      cronRun,
      { found: 0, waAttempted: 0, waSucceeded: 0, waFailed: 0, smsSent: 0, smsFailed: 0 },
      { success: false, errorSummary: safeErrorSummary(error) }
    ).catch(() => {});
  }
  const { status, body } = cronFailurePayload(error);
  return res.status(status).json(body);
}

/**
 * P3: dispatch due WhatsAppReminderJob rows for one campaign kind.
 */
async function runReminderJobCron(req, res, messageKind) {
  let cronRun = null;
  const jobKey = cronJobKeyForKind(messageKind);
  try {
    cronRun = await startCronRun(jobKey);
    const now = new Date();
    const stats = await dispatchDueReminderJobs({
      messageKinds: [messageKind],
      now,
      cronRunId: cronRun._id,
      cronJobKey: jobKey
    });

    const payload = {
      scheduler: 'reminder_job_v3',
      messageKind,
      nowIso: now.toISOString(),
      ...stats
    };

    await finishCronRun(
      cronRun,
      {
        found: stats.jobsClaimed,
        eligibleAfterInitialSendLease: stats.jobsClaimed,
        smsSent: 0,
        smsFailed: 0,
        waAttempted: stats.jobsDispatched + stats.jobsFailed,
        waSucceeded: stats.jobsDispatched,
        waFailed: stats.jobsFailed,
        retriesAttempted: 0,
        flagsUpdated: stats.jobsDispatched,
        ...stats
      },
      { success: true }
    );

    return res.status(200).json({
      success: true,
      message: `${messageKind} reminder jobs processed`,
      stats: payload
    });
  } catch (error) {
    return failCron(res, error, `[Cron] Error in ${jobKey}:`, cronRun);
  }
}

router.get('/send-reminders', verifyCronSecret, (req, res) =>
  runReminderJobCron(req, res, 'pre4hr')
);

router.get('/send-meetlinks', verifyCronSecret, (req, res) =>
  runReminderJobCron(req, res, 'meet')
);

router.get('/send-30min-reminders', verifyCronSecret, (req, res) =>
  runReminderJobCron(req, res, '30min')
);

router.get('/send-guidance-reminders', verifyCronSecret, async (req, res) => {
  let cronRun = null;
  const jobKey = CRON_JOB_KEYS.SEND_GUIDANCE_REMINDERS;
  const { GUIDANCE_REMINDER_MESSAGE_KINDS } = require('../models/WhatsAppReminderJob');
  const { runGuidanceReminderRepairs } = require('../services/guidanceReminderRepairService');
  try {
    cronRun = await startCronRun(jobKey);
    const now = new Date();
    const repairStats = await runGuidanceReminderRepairs({ now, limit: 200 });
    const stats = await dispatchDueReminderJobs({
      messageKinds: [...GUIDANCE_REMINDER_MESSAGE_KINDS],
      now,
      cronRunId: cronRun._id,
      cronJobKey: jobKey,
    });

    const payload = {
      scheduler: 'guidance_reminder_job_v1',
      messageKinds: GUIDANCE_REMINDER_MESSAGE_KINDS,
      nowIso: now.toISOString(),
      repair: repairStats,
      ...stats,
    };

    await finishCronRun(
      cronRun,
      {
        found: stats.jobsClaimed,
        waAttempted: stats.jobsDispatched + stats.jobsFailed,
        waSucceeded: stats.jobsDispatched,
        waFailed: stats.jobsFailed,
        ...stats,
      },
      { success: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Guidance reminder jobs processed',
      stats: payload,
    });
  } catch (error) {
    return failCron(res, error, '[Cron] Error in send-guidance-reminders:', cronRun);
  }
});

router.get('/send-iit-reminders', verifyCronSecret, async (req, res) => {
  let cronRun = null;
  const jobKey = CRON_JOB_KEYS.SEND_IIT_REMINDERS;
  const { IIT_REMINDER_MESSAGE_KINDS } = require('../models/WhatsAppReminderJob');
  try {
    cronRun = await startCronRun(jobKey);
    const now = new Date();
    const stats = await dispatchDueReminderJobs({
      messageKinds: [...IIT_REMINDER_MESSAGE_KINDS],
      now,
      cronRunId: cronRun._id,
      cronJobKey: jobKey,
    });

    const payload = {
      scheduler: 'iit_reminder_job_v1',
      messageKinds: IIT_REMINDER_MESSAGE_KINDS,
      nowIso: now.toISOString(),
      ...stats,
    };

    await finishCronRun(
      cronRun,
      {
        found: stats.jobsClaimed,
        waAttempted: stats.jobsDispatched + stats.jobsFailed,
        waSucceeded: stats.jobsDispatched,
        waFailed: stats.jobsFailed,
        ...stats,
      },
      { success: true }
    );

    return res.status(200).json({
      success: true,
      message: 'IIT reminder jobs processed',
      stats: payload,
    });
  } catch (error) {
    return failCron(res, error, '[Cron] Error in send-iit-reminders:', cronRun);
  }
});

router.get('/send-iit-telugu-sms', verifyCronSecret, async (req, res) => {
  let cronRun = null;
  const jobKey = CRON_JOB_KEYS.SEND_IIT_TELUGU_SMS;
  const { IIT_TELUGU_SMS_MESSAGE_KINDS } = require('../models/IitTeluguSmsReminderJob');
  const { dispatchDueIitTeluguSmsJobs } = require('../services/iitTeluguSmsReminderDispatcher');
  try {
    cronRun = await startCronRun(jobKey);
    const now = new Date();
    const stats = await dispatchDueIitTeluguSmsJobs({
      messageKinds: [...IIT_TELUGU_SMS_MESSAGE_KINDS],
      now,
      cronRunId: cronRun._id,
      cronJobKey: jobKey,
    });

    const payload = {
      scheduler: 'iit_telugu_sms_job_v1',
      messageKinds: IIT_TELUGU_SMS_MESSAGE_KINDS,
      nowIso: now.toISOString(),
      ...stats,
    };

    await finishCronRun(
      cronRun,
      {
        found: stats.jobsClaimed,
        smsSent: stats.jobsDispatched,
        smsFailed: stats.jobsFailed,
        waAttempted: 0,
        waSucceeded: 0,
        waFailed: 0,
        ...stats,
      },
      { success: true }
    );

    return res.status(200).json({
      success: true,
      message: 'IIT Telugu SMS jobs processed',
      stats: payload,
    });
  } catch (error) {
    return failCron(res, error, '[Cron] Error in send-iit-telugu-sms:', cronRun);
  }
});

router.get('/retry-whatsapp', verifyCronSecret, async (req, res) => {
  let cronRun = null;
  try {
    console.log('[Cron] Starting retry WhatsApp job...');
    cronRun = await startCronRun('retry_whatsapp');

    const batch = await executeRetryWhatsAppBatch(cronRun._id);
    console.log('[Cron] Retry WhatsApp batch result', {
      cronRunId: String(cronRun._id),
      found: batch.found || 0,
      groupsTouched: batch.groupsTouched || 0,
      attempted: batch.attempted || 0,
      succeeded: batch.succeeded || 0,
      failed: batch.failed || 0,
      reconcileStale: batch.reconcileStale || null,
      slotBookedImmediate: batch.slotBookedImmediate || null
    });

    await finishCronRun(
      cronRun,
      {
        found: batch.found,
        smsSent: 0,
        smsFailed: 0,
        waAttempted: batch.attempted,
        waSucceeded: batch.succeeded,
        waFailed: batch.failed,
        retriesAttempted: batch.attempted,
        flagsUpdated: 0,
        reconcileStale: batch.reconcileStale || null
      },
      { success: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Retry WhatsApp batch completed',
      stats: batch
    });
  } catch (error) {
    return failCron(res, error, '[Cron] retry-whatsapp:', cronRun);
  }
});

router.get('/osvi-outbound-due', verifyCronSecret, async (req, res) => {
  try {
    if (!isOsviConfigured()) {
      return res.status(200).json({
        success: true,
        message: 'OSVI not configured',
        processed: 0
      });
    }

    const now = new Date();
    const due = await FormSubmission.find({
      osviOutboundCallStatus: 'pending',
      osviOutboundScheduledAt: { $lte: now }
    })
      .limit(50)
      .lean();

    const results = [];

    for (const doc of due) {
      const r = await processOsviOutboundForPhone(doc.phone);
      results.push({
        phoneSuffix: doc.phone.slice(-4),
        ...r
      });
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${due.length} OSVI outbound job(s)`,
      processed: due.length,
      results
    });
  } catch (error) {
    return failCron(res, error, '[Cron] osvi-outbound-due:');
  }
});

router.get('/process-chatbot-inbound', verifyCronSecret, async (req, res) => {
  try {
    const { replayPendingInbound } = require('../services/chatbot/whatsappInboundService');
    const { expireStaleHandoffs } = require('../services/chatbot/handoffService');
    const [replay, expired] = await Promise.all([
      replayPendingInbound(parseInt(req.query.replayLimit || '30', 10) || 30),
      expireStaleHandoffs(parseInt(req.query.expireLimit || '50', 10) || 50),
    ]);
    return res.status(200).json({
      success: true,
      replay,
      expired,
    });
  } catch (error) {
    return failCron(res, error, '[Cron] process-chatbot-inbound:');
  }
});

router.get('/analytics/evaluate-alerts', verifyCronSecret, async (req, res) => {
  try {
    const { evaluateAllAlerts } = require('../services/analytics/smartAlertsService');
    const stats = await evaluateAllAlerts();
    return res.status(200).json({ success: true, data: stats });
  } catch (error) {
    return failCron(res, error, '[Cron] analytics/evaluate-alerts:');
  }
});

router.get('/analytics/daily-report', verifyCronSecret, async (req, res) => {
  try {
    const { generateDailyReport } = require('../services/analytics/executiveReportService');
    const data = await generateDailyReport({
      reportDate: req.query?.reportDate,
      force: req.query?.force === 'true',
      deliveryStatus: 'generated',
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return failCron(res, error, '[Cron] analytics/daily-report:');
  }
});

router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Cron service is healthy',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
