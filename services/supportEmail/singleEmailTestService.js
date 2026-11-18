'use strict';

const crypto = require('crypto');
const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const GraphSubscription = require('../../models/GraphSubscription');
const EmailSyncCursor = require('../../models/EmailSyncCursor');
const SupportEmail = require('../../models/SupportEmail');
const SupportEmailAuditLog = require('../../models/SupportEmailAuditLog');
const SupportEmailRun = require('../../models/SupportEmailRun');
const GoogleSheetsSyncJob = require('../../models/GoogleSheetsSyncJob');
const { APPROVED_MAILBOX, mailboxScopeStatus } = require('./mailboxScopeService');
const { checkGraphAuthentication } = require('./graphHealthService');
const { GraphClient } = require('./graphClient');
const { createGraphGateway, setPipelineStage, codedError } = require('./bodyProcessingService');
const { sanitizeEmailBody } = require('./bodySanitizer');
const { ingestEmailMessage } = require('./emailIngestionService');
const { processAttachments } = require('./attachmentService');
const { classifyEmail } = require('./classificationService');
const { createTicketForEmail } = require('./ticketService');
const { getProcessingConfig } = require('./processingConfig');
const { PROMPT_VERSION } = require('./prompts/emailClassification.v1');
const { STAGES } = require('../../constants/supportEmail');
const SupportTicket = require('../../models/SupportTicket');

const LOCK_KEY = 'single-email-test';
const TEST_MODE = 'single-email';
const MESSAGE_ID = /^[A-Za-z0-9_+=/-]{16,512}$/;

function fail(code, status) {
  const error = codedError(code);
  error.status = status;
  return error;
}

function assertMessageId(graphMessageId) {
  const value = String(graphMessageId || '').trim();
  if (!MESSAGE_ID.test(value) || /[?$]|\s|delta|\/messages/i.test(value)) {
    throw fail('invalid_message_id', 400);
  }
  return value;
}

async function acquireLock(now) {
  const lockExpiresAt = new Date(now.getTime() + 120000);
  const lockToken = crypto.randomBytes(16).toString('hex');
  const taken = await SupportEmailRun.findOneAndUpdate(
    { runKey: LOCK_KEY, activeLock: true, lockExpiresAt: { $lte: now } },
    { $set: { startedAt: now, finishedAt: null, lockExpiresAt, lockToken, success: null, errorSummary: null } },
    { new: true }
  );
  if (taken) return taken;
  try {
    return await SupportEmailRun.create({
      runKey: LOCK_KEY,
      activeLock: true,
      startedAt: now,
      lockExpiresAt,
      lockToken,
      success: null,
      stats: { testMode: TEST_MODE }
    });
  } catch (error) {
    if (error && error.code === 11000) return null;
    throw error;
  }
}

async function releaseLock(lock, success, errorSummary) {
  if (!lock || !lock.lockToken) return;
  await SupportEmailRun.updateOne(
    { _id: lock._id, lockToken: lock.lockToken },
    { $set: { activeLock: false, lockToken: null, finishedAt: new Date(), success, errorSummary: errorSummary || null } }
  );
}

async function storedMailboxReport() {
  const policy = await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX }).lean();
  const subscription = await GraphSubscription.findOne({ mailbox: APPROVED_MAILBOX }).sort({ expirationDateTime: -1 }).lean();
  const cursor = await EmailSyncCursor.findOne({ mailbox: APPROVED_MAILBOX, folder: 'inbox' }).lean();
  return {
    policy: policy ? {
      mailbox: policy.mailbox,
      enabled: policy.enabled === true,
      activationAt: policy.activationAt
    } : null,
    subscription: subscription ? {
      mailbox: subscription.mailbox,
      status: subscription.status,
      expiresAt: subscription.expirationDateTime,
      resourceMatchesMailbox: String(subscription.resource || '').toLowerCase().includes(APPROVED_MAILBOX),
      notificationUrlPresent: Boolean(subscription.notificationUrl),
      lifecycleUrlPresent: Boolean(subscription.lifecycleUrl),
      liveProbe: 'not_run'
    } : null,
    cursor: cursor ? {
      syncStatus: cursor.syncStatus,
      lastSuccessfulSyncAt: cursor.lastSuccessfulSyncAt,
      hasDeltaLink: Boolean(cursor.deltaLink)
    } : null
  };
}

async function readiness(deps = {}) {
  const scope = mailboxScopeStatus(deps.env || process.env);
  const graph = await checkGraphAuthentication(deps.authService);
  const stored = await storedMailboxReport();
  const processingEnabled = process.env.SUPPORT_EMAIL_PROCESSING_ENABLED === '1';
  const blockers = [];
  if (scope.status !== 'VERIFIED') blockers.push('MAILBOX_SCOPE_UNVERIFIED');
  if (!graph.ok) blockers.push('graph_token_failed');
  if (!stored.policy) blockers.push('policy_missing');
  else if (!stored.policy.enabled) blockers.push('policy_disabled');
  else if (stored.policy.mailbox !== APPROVED_MAILBOX) blockers.push('wrong_mailbox');
  else if (!(stored.policy.activationAt instanceof Date) && !stored.policy.activationAt) blockers.push('activation_missing');
  if (processingEnabled) blockers.push('global_processing_enabled');
  return {
    testMode: TEST_MODE,
    approvedMailbox: APPROVED_MAILBOX,
    promptVersion: PROMPT_VERSION,
    mailboxScope: scope,
    graphToken: { ok: graph.ok, code: graph.code, expiresInMs: graph.expiresInMs || 0 },
    processingEnabled,
    ...stored,
    blockers
  };
}

async function runSingleEmailTest({ graphMessageId, admin, graphClient, authService, chatCompletion } = {}) {
  const messageId = assertMessageId(graphMessageId);
  const now = new Date();
  const lock = await acquireLock(now);
  if (!lock) throw fail('test_in_progress', 409);

  const calls = [];
  let succeeded = false;
  try {
    const prior = await SupportEmailAuditLog.findOne({
      action: 'single_email_test',
      targetId: messageId,
      'metadata.outcome': 'completed'
    }).lean();
    if (prior) {
      const error = fail('duplicate_test_request', 409);
      error.ticketId = prior.metadata && prior.metadata.ticketId ? String(prior.metadata.ticketId) : null;
      throw error;
    }

    const report = await readiness({ authService });
    if (report.blockers.length) {
      const error = fail(report.blockers[0], 409);
      error.readiness = report;
      throw error;
    }

    const policy = await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX, enabled: true }).lean();
    if (!policy || policy.mailbox !== APPROVED_MAILBOX) throw fail('wrong_mailbox', 409);

    const transport = graphClient || new GraphClient();
    const guarded = {
      get(url, options) {
        const path = String(url);
        calls.push(path);
        if (/\/messages\/?(\?|$)/.test(path) || /delta|subscriptions|sendMail|createReply|move/i.test(path)) {
          throw fail('mailbox_list_forbidden', 409);
        }
        return transport.get(url, options);
      },
      // Attachment bytes for the one selected message only. Nothing else may be streamed.
      async openByteStream(url, options) {
        const path = String(url);
        const allowed = `/users/${encodeURIComponent(APPROVED_MAILBOX)}/messages/${encodeURIComponent(messageId)}/attachments/`;
        if (!path.startsWith(allowed) || /\.\.|[?]/.test(path.slice(allowed.length)) || !/\/\$value$/.test(path)) {
          throw fail('mailbox_list_forbidden', 409);
        }
        calls.push(path);
        if (typeof transport.openByteStream !== 'function') throw fail('attachment_stream_unavailable', 409);
        return transport.openByteStream(url, options);
      }
    };
    const gateway = createGraphGateway(guarded);
    const message = await gateway.getMessage(APPROVED_MAILBOX, messageId);
    if (!message || message['@removed']) throw fail('message_unavailable', 404);
    const receivedAt = new Date(message.receivedDateTime);
    if (!message.receivedDateTime || Number.isNaN(receivedAt.getTime()) || receivedAt < new Date(policy.activationAt)) {
      throw fail('historical_message', 422);
    }

    const ingested = await ingestEmailMessage({
      graphMessage: message,
      mailbox: APPROVED_MAILBOX,
      activationAt: policy.activationAt,
      queueSvc: { async enqueueJob() { return { skipped: TEST_MODE }; } }
    });
    if (ingested.isHistorical) throw fail('historical_message', 422);
    const email = await SupportEmail.findById(ingested.email && ingested.email._id);
    if (!email) throw fail('email_missing', 500);
    email.metadata = { ...(email.metadata || {}), testMode: TEST_MODE, mailbox: APPROVED_MAILBOX };
    email.markModified('metadata');
    if (email.bodyText && email.pipeline.fetch !== 'fetched') {
      const sanitized = sanitizeEmailBody({
        content: email.bodyText,
        contentType: 'text',
        maxText: getProcessingConfig({ enabled: false }).maxBodyTextLength,
        maxHtml: getProcessingConfig({ enabled: false }).maxBodyHtmlSnippetLength
      });
      email.bodyText = sanitized.text || email.bodyText;
      await setPipelineStage(email, STAGES.FETCH, 'fetched');
      if (!email.hasAttachments) await setPipelineStage(email, STAGES.ATTACHMENTS, 'extracted');
    }
    const config = getProcessingConfig({ enabled: false });
    if (email.hasAttachments && email.pipeline.attachments === 'pending') {
      await processAttachments(email._id, { graphClient: guarded, config });
    }
    const classification = await classifyEmail(email._id, { config, chatCompletion });
    const ticketResult = await createTicketForEmail(email._id, { sheetsState: 'skipped_test_mode' });
    const ticket = await SupportTicket.findById(ticketResult.ticketId).lean();
    const sheetJobs = await GoogleSheetsSyncJob.countDocuments({ ticketId: ticket && ticket._id });
    if (sheetJobs !== 0) throw fail('sheets_job_created', 500);

    await SupportEmailAuditLog.create({
      adminId: admin && admin._id,
      action: 'single_email_test',
      targetType: 'graph_message',
      targetId: messageId,
      metadata: {
        outcome: 'completed',
        testMode: TEST_MODE,
        ticketId: ticket ? String(ticket._id) : null,
        promptVersion: PROMPT_VERSION,
        graphGets: calls.length,
        attachmentGets: calls.filter((path) => /\/attachments/.test(path)).length
      }
    });

    succeeded = true;
    return {
      testMode: TEST_MODE,
      promptVersion: PROMPT_VERSION,
      graphMessageId: messageId,
      graphGets: calls.length,
      ticket: ticket ? {
        id: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        category: ticket.category,
        priority: ticket.priority,
        sentiment: ticket.sentiment,
        confidence: ticket.confidence,
        status: ticket.status
      } : null,
      classification: classification.classification || null,
      sheets: 'skipped_test_mode',
      review: Boolean(classification.classification && classification.classification.needsHumanReview)
    };
  } finally {
    await releaseLock(lock, succeeded, null);
  }
}

module.exports = {
  APPROVED_MAILBOX,
  TEST_MODE,
  readiness,
  runSingleEmailTest,
  assertMessageId
};
