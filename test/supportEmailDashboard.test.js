'use strict';

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'support-dashboard-secret';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const requireAdmin = require('../middleware/requireAdmin');
const { createSupportEmailAdminRouter } = require('../routes/supportEmailAdminRoutes');
const Admin = require('../models/Admin');
const SupportEmail = require('../models/SupportEmail');
const SupportTicket = require('../models/SupportTicket');
const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');
const SupportEmailAttachment = require('../models/SupportEmailAttachment');
const SupportEmailAuditLog = require('../models/SupportEmailAuditLog');
const SupportTicketEvent = require('../models/SupportTicketEvent');
const { storeAttachment } = require('../services/supportEmail/attachmentStorage');
const GraphSubscription = require('../models/GraphSubscription');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');

let server;
let baseUrl;
let token;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.auth !== false && !headers.authorization) headers.authorization = `Bearer ${token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let data = null;
  try { data = JSON.parse(text); } catch (error) { data = text; }
  return { status: response.status, data, buffer, headers: response.headers };
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
  const admin = await Admin.create({
    username: 'support-dashboard',
    password: 'secret12',
    name: 'Support Admin',
    isSuperAdmin: false,
    sectionAccess: ['support-email']
  });
  token = jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await teardownTestDb();
});

async function seedTicket(overrides = {}) {
  const email = await SupportEmail.create({
    graphMessageId: overrides.messageId || `msg-${Math.random()}`,
    receivedDateTime: overrides.receivedAt || new Date(),
    conversationId: overrides.conversationId || 'conversation-1',
    subject: overrides.subject || 'Fee receipt',
    from: { name: overrides.senderName || 'Asha Rao', address: overrides.sender || 'asha@example.com' },
    bodyText: overrides.body || 'Where is my receipt?',
    pipeline: overrides.pipeline || { state: 'completed', fetch: 'fetched', attachments: 'extracted', ai: 'classified', ticket: 'created', sheets: 'synced' },
    metadata: { mailbox: 'support@example.com' }
  });
  const ticket = await SupportTicket.create({
    ticketNumber: overrides.ticketNumber || 'GX-1001',
    dedupeKey: overrides.dedupeKey || `dedupe-${Math.random()}`,
    emailIds: [email._id],
    primaryEmailId: email._id,
    requester: { name: 'Asha Rao', email: 'asha@example.com', phone: '9999999999' },
    category: overrides.category || 'billing',
    priority: overrides.priority || 'high',
    status: overrides.status || 'needs_review',
    enquiry: { summary: 'Student asked for a fee receipt.' }
  });
  return { email, ticket };
}

test('dashboard metrics come from stored mail and reject a bad range', async () => {
  await seedTicket();
  await seedTicket({
    messageId: 'failed-message',
    ticketNumber: 'GX-1002',
    dedupeKey: 'dedupe-failed',
    subject: 'Portal down',
    priority: 'urgent',
    status: 'open',
    category: 'technical',
    pipeline: { state: 'failed', fetch: 'failed', ai: 'pending', ticket: 'pending', sheets: 'pending', attachments: 'pending' }
  });
  const overview = await api('/api/admin/support-email/overview?preset=today');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.overview.totals.emails, 2);
  assert.equal(overview.data.overview.totals.processed, 1);
  assert.equal(overview.data.overview.totals.failed, 1);
  assert.equal(overview.data.overview.totals.tickets, 2);
  assert.equal(overview.data.overview.totals.needsReview, 1);
  assert.equal(overview.data.overview.totals.urgent, 1);
  assert.ok(overview.data.overview.categories.some((row) => row.category === 'billing'));
  const missing = await api('/api/admin/support-email/overview', { auth: false });
  assert.equal(missing.status, 401);
  const bad = await api('/api/admin/support-email/overview?preset=year');
  assert.equal(bad.status, 400);
});

test('ticket search, filters and pagination stay bounded', async () => {
  await seedTicket({ ticketNumber: 'GX-2001', subject: 'Admission query', sender: 'student@example.com', senderName: 'Student One', priority: 'low', status: 'open', category: 'admissions' });
  await seedTicket({ messageId: 'second', ticketNumber: 'GX-2002', dedupeKey: 'second', subject: 'Fee receipt', priority: 'urgent', status: 'needs_review', category: 'billing' });
  const filtered = await api('/api/admin/support-email/tickets?q=receipt&priority=urgent&status=needs_review&sort=priority&page=1&limit=1');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.total, 1);
  assert.equal(filtered.data.tickets[0].ticketNumber, 'GX-2002');
  assert.equal(filtered.data.tickets[0].subject, 'Fee receipt');
  assert.equal(JSON.stringify(filtered.data).includes('9999999999'), false);
  const empty = await api('/api/admin/support-email/tickets?q=does-not-exist');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.tickets, []);
});

test('ticket detail hides secrets and a review is audited', async () => {
  const { ticket } = await seedTicket();
  const detail = await api(`/api/admin/support-email/tickets/${ticket._id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.ticket.subject, 'Fee receipt');
  assert.equal(detail.data.ticket.bodyText.includes('receipt'), true);
  assert.equal(JSON.stringify(detail.data).includes('9999999999'), false);
  assert.equal(JSON.stringify(detail.data).includes('clientState'), false);
  const reviewed = await api(`/api/admin/support-email/tickets/${ticket._id}/review`, {
    method: 'PATCH',
    body: { category: 'general', priority: 'medium', status: 'in_progress', note: 'Checked the receipt queue.' }
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.ticket.status, 'in_progress');
  assert.equal(await SupportTicketEvent.countDocuments({ ticketId: ticket._id, type: 'comment_added' }), 1);
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'ticket_reviewed' }), 1);
  const outsider = await Admin.create({ username: 'outsider', password: 'secret12', isSuperAdmin: false, sectionAccess: ['leads'] });
  const deniedToken = jwt.sign({ adminId: outsider._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
  const denied = await api(`/api/admin/support-email/tickets/${ticket._id}/review`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${deniedToken}` },
    body: { status: 'closed' }
  });
  assert.equal(denied.status, 403);
  assert.equal((await SupportTicket.findById(ticket._id)).status, 'in_progress');
});

test('retry requeues only failed or dead-letter jobs and attachment download stays private', async () => {
  const { email, ticket } = await seedTicket();
  const dead = await SupportEmailProcessingJob.create({
    emailId: email._id,
    stage: 'sheets',
    state: 'dead_letter',
    attempts: 5,
    maxAttempts: 5,
    deadLetterReason: 'sheets_write_failed',
    claimToken: 'old-token'
  });
  const live = await SupportEmailProcessingJob.create({
    emailId: email._id,
    stage: 'fetch',
    state: 'processing',
    claimToken: 'live-token',
    leaseExpiresAt: new Date(Date.now() + 60000)
  });
  const denied = await api(`/api/admin/support-email/jobs/${live._id}/retry`, { method: 'POST' });
  assert.equal(denied.status, 409);
  assert.equal((await SupportEmailProcessingJob.findById(live._id)).state, 'processing');
  const retried = await api(`/api/admin/support-email/jobs/${dead._id}/retry`, { method: 'POST' });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.job.state, 'pending');
  assert.equal((await SupportEmailProcessingJob.findById(dead._id)).claimToken, null);
  const jobs = await api('/api/admin/support-email/jobs');
  assert.equal(jobs.data.jobs.some((row) => row.id === String(dead._id)), false);

  const storageKey = await storeAttachment(Buffer.from('%PDF-1.4 receipt'), { filename: 'receipt.pdf', mimeType: 'application/pdf' });
  const attachment = await SupportEmailAttachment.create({
    emailId: email._id,
    graphAttachmentId: 'file-1',
    name: 'receipt.pdf',
    contentType: 'application/pdf',
    size: 14,
    storageKey,
    scanStatus: 'clean',
    extractStatus: 'extracted',
    extractedText: 'Fee receipt text'
  });
  const detail = await api(`/api/admin/support-email/tickets/${ticket._id}`);
  assert.equal(detail.data.ticket.attachments[0].extractedText, 'Fee receipt text');
  assert.equal(detail.data.ticket.attachments[0].scannedPdfSupported, false);
  const file = await api(`/api/admin/support-email/attachments/${attachment._id}`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(file.buffer.includes(Buffer.from('%PDF-1.4')), true);
  const anonymous = await api(`/api/admin/support-email/attachments/${attachment._id}`, { auth: false });
  assert.equal(anonymous.status, 401);
});

test('health reports operations without subscription secrets', async () => {
  await GraphSubscription.create({
    subscriptionId: 'sub-1',
    mailbox: 'support@example.com',
    folder: 'inbox',
    resource: '/users/support/mailFolders/inbox/messages',
    expirationDateTime: new Date(Date.now() + 3600000),
    clientStateHash: 'super-secret-client-state',
    status: 'active'
  });
  await SupportEmailWebhookEvent.create({
    subscriptionId: 'sub-1',
    resource: '/users/support/mailFolders/inbox/messages',
    changeType: 'created',
    dedupeKey: 'dedupe-health',
    clientStateHash: 'super-secret-client-state',
    status: 'processed'
  });
  const health = await api('/api/admin/support-email/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.health.subscriptions[0].healthy, true);
  assert.equal(health.data.health.webhook.status, 'processed');
  assert.equal(JSON.stringify(health.data).includes('super-secret-client-state'), false);
  assert.equal(JSON.stringify(health.data).includes('clientState'), false);
  const empty = await api('/api/admin/support-email/jobs');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.jobs, []);
});
