'use strict';

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'support-e2e-secret';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const requireAdmin = require('../middleware/requireAdmin');
const { createSupportEmailAdminRouter } = require('../routes/supportEmailAdminRoutes');
const Admin = require('../models/Admin');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const SupportEmail = require('../models/SupportEmail');
const SupportEmailAiRun = require('../models/SupportEmailAiRun');
const SupportEmailAuditLog = require('../models/SupportEmailAuditLog');
const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');
const SupportEmailRun = require('../models/SupportEmailRun');
const SupportTicket = require('../models/SupportTicket');
const GoogleSheetsSyncJob = require('../models/GoogleSheetsSyncJob');
const GraphSubscription = require('../models/GraphSubscription');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const { enqueueJob } = require('../services/supportEmail/queueService');
const { runProcessingBatch } = require('../services/supportEmail/pipelineService');
const { createTicketForEmail } = require('../services/supportEmail/ticketService');
const dashboard = require('../services/supportEmail/adminDashboardService');
const { APPROVED_MAILBOX } = require('../services/supportEmail/mailboxScopeService');

let server;
let baseUrl;
let token;
let superToken;

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${options.token || token}` };
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  return { status: response.status, data };
}

function classification(overrides = {}) {
  return JSON.stringify({
    category: 'admissions',
    subcategory: 'eligibility',
    intent: 'ask_about_admission',
    priority: 'medium',
    urgency: 'medium',
    sentiment: 'neutral',
    summary: 'Student asked about admission.',
    studentIdentifiers: { name: '', email: '', phone: '', rollNumber: '', course: '' },
    recommendedAction: 'Ask admissions to review eligibility.',
    confidence: 0.95,
    needsHumanReview: false,
    ...overrides
  });
}

async function seedEmail(extra = {}) {
  return SupportEmail.create({
    graphMessageId: `msg-${Date.now()}-${Math.random()}`,
    receivedDateTime: extra.receivedDateTime || new Date(),
    conversationId: `conversation-${Math.random()}`,
    subject: extra.subject || 'Admission question',
    from: { name: 'Asha Rao', address: 'asha@example.com' },
    toRecipients: [{ name: 'Support', address: APPROVED_MAILBOX }],
    ccRecipients: [{ name: 'Lead', address: 'lead@example.com' }],
    internetMessageId: `<${Math.random()}@example.com>`,
    hasAttachments: false,
    metadata: { mailbox: APPROVED_MAILBOX, folder: 'inbox' },
    ...extra
  });
}

before(async () => {
  await setupTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/support-email', requireAdmin, createSupportEmailAdminRouter());
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await clearTestDb();
  delete process.env.SUPPORT_EMAIL_PROCESSING_ENABLED;
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED;
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX;
  const admin = await Admin.create({ username: 'e2e-agent', password: 'secret12', name: 'Agent', isSuperAdmin: false, sectionAccess: ['support-email'] });
  const superAdmin = await Admin.create({ username: 'e2e-super', password: 'secret12', name: 'Root', isSuperAdmin: true, sectionAccess: [] });
  token = jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
  superToken = jwt.sign({ adminId: superAdmin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await teardownTestDb();
});

test('mail flows fetch to AI to ticket with no Google Sheets work, and completes', async () => {
  const email = await seedEmail();
  await enqueueJob({ emailId: email._id, stage: 'fetch' });
  const graphCalls = [];
  const outcome = await runProcessingBatch({
    enabled: true,
    batchSize: 10,
    timeBudgetMs: 10000,
    graphClient: {
      async get(url) {
        graphCalls.push(String(url));
        return {
          id: email.graphMessageId,
          body: { contentType: 'text', content: 'Am I eligible for the BTech seat?' },
          hasAttachments: false
        };
      }
    },
    chatCompletion: async () => ({ content: classification(), model: 'test-model' }),
    sheetId: 'must-not-be-used',
    sheetsClient: { async appendRow() { throw new Error('sheets_credentials_missing'); } }
  });
  assert.equal(outcome.deadLetter, 0);
  assert.equal(outcome.retried, 0);
  const fresh = await SupportEmail.findById(email._id).lean();
  assert.equal(fresh.pipeline.state, 'completed');
  assert.equal(fresh.pipeline.sheets, 'not_used');
  assert.equal(await SupportTicket.countDocuments(), 1);
  assert.equal(await GoogleSheetsSyncJob.countDocuments(), 0);
  assert.equal(await SupportEmailProcessingJob.countDocuments({ stage: 'sheets' }), 0);
  assert.equal(await SupportEmailProcessingJob.countDocuments({ lastError: /sheets/ }), 0);
  assert.equal(graphCalls.length, 1);
});

test('ticket creation is idempotent and never re-enters a sheets step', async () => {
  const email = await seedEmail({ 'pipeline.fetch': 'fetched', 'pipeline.attachments': 'extracted', 'pipeline.ai': 'classified' });
  await SupportEmailAiRun.create({ emailId: email._id, stage: 'ai', model: 'm', promptKey: 'k', promptVersion: 'v1.3', inputHash: 'h', parsed: JSON.parse(classification()), confidence: 0.95, outcome: 'success' });
  const first = await createTicketForEmail(email._id);
  const second = await createTicketForEmail(email._id);
  assert.equal(String(first.ticketId), String(second.ticketId));
  assert.equal(first.enqueue, undefined);
  assert.equal(await SupportTicket.countDocuments(), 1);
});

async function rawTicket(fields) {
  const email = await seedEmail({ subject: fields.subject || 'Seed' });
  await SupportTicket.collection.insertOne({
    ticketNumber: fields.ticketNumber,
    dedupeKey: `dedupe-${Math.random()}`,
    emailIds: [email._id],
    primaryEmailId: email._id,
    requester: { name: 'Asha', email: 'asha@example.com' },
    priority: 'medium',
    sentiment: 'neutral',
    status: 'open',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields.raw
  });
  return SupportTicket.findOne({ ticketNumber: fields.ticketNumber }).lean();
}

test('an unknown or missing category is stored, aggregated, filtered and shown as other for review', async () => {
  assert.equal(new SupportTicket({}).category, 'other');

  const noRun = await seedEmail({ 'pipeline.fetch': 'fetched', 'pipeline.attachments': 'extracted', 'pipeline.ai': 'classified' });
  await SupportEmailAiRun.create({ emailId: noRun._id, stage: 'ai', model: 'm', promptKey: 'k', promptVersion: 'v1.3', inputHash: 'h', parsed: { category: 'astrology', confidence: 0.99 }, confidence: 0.99, outcome: 'success' });
  const created = await createTicketForEmail(noRun._id);
  const stored = await SupportTicket.findById(created.ticketId).lean();
  assert.equal(stored.category, 'other');
  assert.equal(stored.status, 'needs_review');

  const bare = await seedEmail({ 'pipeline.fetch': 'fetched', 'pipeline.attachments': 'extracted', 'pipeline.ai': 'classified' });
  const bareTicket = await createTicketForEmail(bare._id);
  const bareStored = await SupportTicket.findById(bareTicket.ticketId).lean();
  assert.equal(bareStored.category, 'other');
  assert.equal(bareStored.status, 'needs_review');

  const legacyMissing = await rawTicket({ ticketNumber: 'GX-L1' });
  const legacyUnknown = await rawTicket({ ticketNumber: 'GX-L2', raw: { category: 'legacy_value' } });
  await rawTicket({ ticketNumber: 'GX-L3', raw: { category: 'billing' } });
  assert.equal(legacyMissing.category, undefined);

  const overview = await api('/api/admin/support-email/overview?preset=today');
  const byCategory = Object.fromEntries(overview.data.overview.categories.map((row) => [row.category, row.count]));
  assert.equal(byCategory.other, 4);
  assert.equal(byCategory.billing, 1);
  assert.equal(Object.keys(byCategory).every((key) => key !== 'null' && key !== 'undefined'), true);
  assert.equal(overview.data.overview.categories.reduce((sum, row) => sum + row.count, 0), overview.data.overview.totals.tickets);

  const list = await api('/api/admin/support-email/tickets?category=other&limit=50');
  assert.equal(list.data.total, 4);
  assert.equal(list.data.tickets.every((row) => row.category === 'other'), true);

  const detail = await api(`/api/admin/support-email/tickets/${legacyUnknown._id}`);
  assert.equal(detail.data.ticket.category, 'other');
  const detailMissing = await api(`/api/admin/support-email/tickets/${legacyMissing._id}`);
  assert.equal(detailMissing.data.ticket.category, 'other');
  const detailCreated = await api(`/api/admin/support-email/tickets/${created.ticketId}`);
  assert.equal(detailCreated.data.ticket.classification.category, 'other');
  assert.equal(detailCreated.data.ticket.classification.needsHumanReview, true);
});

test('ticket detail returns history, recipients, retries and never raw AI output', async () => {
  const email = await seedEmail({ 'pipeline.fetch': 'fetched', 'pipeline.attachments': 'extracted', 'pipeline.ai': 'classified' });
  await SupportEmailAiRun.create({
    emailId: email._id, stage: 'ai', model: 'test-model', promptKey: 'k', promptVersion: 'v1.3', inputHash: 'h',
    rawResponse: 'RAW-MODEL-SECRET', parsed: JSON.parse(classification()), confidence: 0.95, outcome: 'success', latencyMs: 120
  });
  const { ticketId } = await createTicketForEmail(email._id);
  await SupportEmailProcessingJob.create({ emailId: email._id, stage: 'ai', state: 'dead_letter', attempts: 3, maxAttempts: 3, lastError: 'ai_timeout', deadLetterReason: 'ai_timeout' });
  const admin = await Admin.findOne({ username: 'e2e-agent' });
  await dashboard.reviewTicket(String(ticketId), admin, { priority: 'high', note: 'Escalated' });

  const detail = await api(`/api/admin/support-email/tickets/${ticketId}`);
  const ticket = detail.data.ticket;
  assert.equal(detail.status, 200);
  assert.deepEqual(ticket.recipients.to.map((row) => row.email), [APPROVED_MAILBOX]);
  assert.deepEqual(ticket.recipients.cc.map((row) => row.email), ['lead@example.com']);
  assert.ok(ticket.internetMessageId);
  assert.equal(ticket.retry.totalAttempts, 3);
  assert.equal(ticket.retry.lastError, 'ai_timeout');
  assert.equal(ticket.processingHistory.some((row) => row.kind === 'job' && row.state === 'dead_letter'), true);
  const ai = ticket.processingHistory.find((row) => row.kind === 'ai_run');
  assert.equal(ai.model, 'test-model');
  assert.equal(ai.promptVersion, 'v1.3');
  assert.equal(JSON.stringify(detail.data).includes('RAW-MODEL-SECRET'), false);
  const review = ticket.auditHistory.find((row) => row.action === 'ticket_reviewed');
  assert.equal(review.actor, 'Agent');
  assert.equal(review.details.after.priority, 'high');
  assert.equal(Object.prototype.hasOwnProperty.call(ticket, 'sheets'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ticket.pipeline, 'sheets'), false);
});

test('overview returns recent tickets and recent failures inside the chosen range', async () => {
  const email = await seedEmail({ subject: 'Recent ticket' });
  await SupportTicket.collection.insertOne({
    ticketNumber: 'GX-R1', dedupeKey: 'r1', emailIds: [email._id], primaryEmailId: email._id,
    requester: { name: 'A', email: 'a@example.com' }, category: 'billing', priority: 'high', sentiment: 'neutral',
    status: 'open', createdAt: new Date(), updatedAt: new Date()
  });
  await SupportEmailProcessingJob.create({ emailId: email._id, stage: 'ai', state: 'failed', attempts: 2, maxAttempts: 5, lastError: 'ai_timeout' });
  const old = await seedEmail({ subject: 'Old', receivedDateTime: new Date(Date.now() - 40 * 86400000) });
  await SupportEmailProcessingJob.create({ emailId: old._id, stage: 'fetch', state: 'failed', attempts: 1, maxAttempts: 5, lastError: 'old_error' });
  await SupportEmailProcessingJob.updateOne({ emailId: old._id }, { $set: { updatedAt: new Date(Date.now() - 40 * 86400000) } }, { timestamps: false });

  const seven = await api('/api/admin/support-email/overview?preset=7d');
  assert.equal(seven.data.overview.recentTickets[0].ticketNumber, 'GX-R1');
  assert.equal(seven.data.overview.recentTickets[0].subject, 'Recent ticket');
  assert.equal(seven.data.overview.recentFailures.length, 1);
  assert.equal(seven.data.overview.recentFailures[0].reason, 'ai_timeout');
  const today = await api('/api/admin/support-email/overview?preset=today');
  assert.equal(today.status, 200);
  const day = new Date(Date.now() - 41 * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() - 39 * 86400000).toISOString().slice(0, 10);
  const custom = await api(`/api/admin/support-email/overview?preset=custom&from=${day}&to=${end}`);
  assert.equal(custom.data.overview.recentFailures[0].reason, 'old_error');
  assert.equal(custom.data.overview.recentTickets.length, 0);
});

test('ticket list filters by received date, searches, shows processing status and paginates a bounded page', async () => {
  const make = async (number, subject, daysAgo, state) => {
    const received = new Date(Date.now() - daysAgo * 86400000);
    const email = await seedEmail({ subject, receivedDateTime: received, pipeline: { state, fetch: 'fetched', attachments: 'extracted', ai: 'classified', ticket: 'created' } });
    await SupportTicket.collection.insertOne({
      ticketNumber: number, dedupeKey: number, emailIds: [email._id], primaryEmailId: email._id,
      requester: { name: 'A', email: 'a@example.com' }, category: 'admissions', priority: 'low', sentiment: 'neutral',
      status: 'open', createdAt: new Date(), updatedAt: new Date()
    });
  };
  await make('GX-D1', 'Fresh enquiry', 0, 'completed');
  await make('GX-D2', 'Older enquiry', 10, 'processing');
  await make('GX-D3', 'Ancient enquiry', 40, 'failed');
  const ymd = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const recent = await api(`/api/admin/support-email/tickets?from=${ymd(2)}`);
  assert.deepEqual(recent.data.tickets.map((row) => row.ticketNumber), ['GX-D1']);
  assert.equal(recent.data.tickets[0].processingStatus, 'completed');

  const window = await api(`/api/admin/support-email/tickets?from=${ymd(12)}&to=${ymd(8)}`);
  assert.deepEqual(window.data.tickets.map((row) => row.ticketNumber), ['GX-D2']);
  assert.equal(window.data.tickets[0].processingStatus, 'processing');

  const bySubject = await api('/api/admin/support-email/tickets?q=ancient');
  assert.equal(bySubject.data.total, 1);
  assert.equal(bySubject.data.tickets[0].processingStatus, 'failed');
  const byTicket = await api('/api/admin/support-email/tickets?q=GX-D1');
  assert.equal(byTicket.data.total, 1);

  const paged = await api('/api/admin/support-email/tickets?limit=2&page=2');
  assert.equal(paged.data.total, 3);
  assert.equal(paged.data.pages, 2);
  assert.equal(paged.data.tickets.length, 1);
  const huge = await api('/api/admin/support-email/tickets?limit=5000');
  assert.equal(huge.data.limit, 50);
  const badDate = await api('/api/admin/support-email/tickets?from=nonsense');
  assert.equal(badDate.status, 400);
  const reversed = await api(`/api/admin/support-email/tickets?from=${ymd(1)}&to=${ymd(5)}`);
  assert.equal(reversed.status, 400);
});

test('jobs endpoint reports queue counts, last error, and does not start a worker', async () => {
  const email = await seedEmail();
  await SupportEmailProcessingJob.create({ emailId: email._id, stage: 'ai', state: 'dead_letter', attempts: 5, maxAttempts: 5, lastError: 'ai_timeout', deadLetterReason: 'ai_timeout' });
  await SupportEmailProcessingJob.create({ emailId: email._id, stage: 'fetch', state: 'pending', attempts: 0, maxAttempts: 5 });
  await SupportEmailProcessingJob.create({ emailId: email._id, stage: 'ticket', state: 'processing', attempts: 1, maxAttempts: 5 });
  const jobs = await api('/api/admin/support-email/jobs');
  assert.equal(jobs.data.counts.pending, 1);
  assert.equal(jobs.data.counts.processing, 1);
  assert.equal(jobs.data.counts.dead_letter, 1);
  assert.equal(jobs.data.startsWorker, false);
  assert.equal(jobs.data.jobs[0].lastError, 'ai_timeout');
  assert.equal(Object.prototype.hasOwnProperty.call(jobs.data, 'sheetFailures'), false);
  const sheets = await SupportEmailProcessingJob.create({ emailId: email._id, stage: 'sheets', state: 'dead_letter', attempts: 5, maxAttempts: 5 });
  const retry = await api(`/api/admin/support-email/jobs/${sheets._id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 409);
  assert.equal(retry.data.message, 'stage_disconnected');
  assert.equal(process.env.SUPPORT_EMAIL_PROCESSING_ENABLED, undefined);
});

function item(items, key) {
  return items.find((row) => row.key === key);
}

test('health separates verified from unknown and never calls unknown healthy', async () => {
  const empty = await api('/api/admin/support-email/health');
  const items = empty.data.health.items;
  assert.equal(item(items, 'graph_auth').verified, 'unknown');
  assert.equal(item(items, 'webhook').verified, 'unknown');
  assert.equal(item(items, 'last_sync').verified, 'unknown');
  assert.equal(item(items, 'last_processing_run').verified, 'unknown');
  assert.equal(item(items, 'mailbox_policy').verified, false);
  assert.equal(item(items, 'subscription').verified, false);
  assert.equal(item(items, 'exchange_scope').verified, false);
  assert.equal(item(items, 'exchange_scope').value, 'MAILBOX_SCOPE_UNVERIFIED');
  assert.match(item(items, 'exchange_scope').detail, /Exchange Online application RBAC/);
  assert.equal(item(items, 'database').verified, mongoose.connection.readyState === 1);
  assert.equal(item(items, 'database').verified, true);
  assert.equal(item(items, 'storage').verified, true);
  assert.equal(empty.data.health.summary.unknown >= 4, true);
  assert.equal(empty.data.health.items.every((row) => [true, false, 'unknown'].includes(row.verified)), true);
});

test('health turns verified only after the matching evidence exists', async () => {
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED = '1';
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX = APPROVED_MAILBOX;
  await EmailIngestionPolicy.create({ mailbox: APPROVED_MAILBOX, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-1', mailbox: APPROVED_MAILBOX, folder: 'inbox', resource: `users/${APPROVED_MAILBOX}/mailFolders('inbox')/messages`,
    changeType: 'created', notificationUrl: 'https://example.com/n', lifecycleUrl: 'https://example.com/l', clientStateHash: 'hash',
    status: 'active', expirationDateTime: new Date(Date.now() + 86400000)
  });
  await EmailSyncCursor.create({ mailbox: APPROVED_MAILBOX, folder: 'inbox', syncStatus: 'idle', lastSuccessfulSyncAt: new Date() });
  await SupportEmailRun.create({ runKey: 'phase3-process', activeLock: false, startedAt: new Date(), finishedAt: new Date(), success: true });
  await SupportEmailAuditLog.create({ action: 'graph_auth_diagnostic', targetType: 'graph_authentication', targetId: 'graph', metadata: { ok: true, code: 'graph_token_ok' } });

  const health = (await api('/api/admin/support-email/health')).data.health;
  assert.equal(item(health.items, 'graph_auth').verified, true);
  assert.equal(item(health.items, 'mailbox_policy').verified, true);
  assert.equal(item(health.items, 'exchange_scope').verified, true);
  assert.equal(item(health.items, 'exchange_scope').value, 'VERIFIED');
  assert.equal(item(health.items, 'last_processing_run').verified, true);
  assert.equal(item(health.items, 'queue').verified, true);
  assert.equal(item(health.items, 'subscription').verified, true);
  assert.equal(item(health.items, 'last_sync').verified, true);

  await SupportEmailAuditLog.create({ action: 'graph_auth_diagnostic', targetType: 'graph_authentication', targetId: 'graph', metadata: { ok: false, code: 'graph_token_failed' } });
  const failed = (await api('/api/admin/support-email/health')).data.health;
  assert.equal(item(failed.items, 'graph_auth').verified, false);
});

test('webhook rows count as verified only when no error is recorded', async () => {
  const base = { subscriptionId: 'sub-w', resource: 'users/x/messages/1', changeType: 'created', receivedAt: new Date() };
  await SupportEmailWebhookEvent.create({ ...base, dedupeKey: 'ok-1', status: 'processed' });
  let health = (await api('/api/admin/support-email/health')).data.health;
  assert.equal(item(health.items, 'webhook').verified, true);
  await SupportEmailWebhookEvent.create({ ...base, dedupeKey: 'bad-1', status: 'failed', errorCategory: 'invalid_client_state', receivedAt: new Date(Date.now() + 1000) });
  health = (await api('/api/admin/support-email/health')).data.health;
  assert.equal(item(health.items, 'webhook').verified, false);
});

test('the Graph token test records its result without returning the token and is Super Admin only', async () => {
  const denied = await api('/api/admin/support-email/graph-authentication');
  assert.equal(denied.status, 403);
  const allowed = await api('/api/admin/support-email/graph-authentication', { token: superToken });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.stringify(allowed.data).includes('eyJ'), false);
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'graph_auth_diagnostic' }), 1);
  const health = (await api('/api/admin/support-email/health')).data.health;
  assert.equal(item(health.items, 'graph_auth').verified, allowed.data.graph.ok === true);
});
