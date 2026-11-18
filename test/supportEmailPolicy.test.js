'use strict';

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'support-policy-secret';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const requireAdmin = require('../middleware/requireAdmin');
const { createSupportEmailAdminRouter } = require('../routes/supportEmailAdminRoutes');
const Admin = require('../models/Admin');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const SupportEmailAuditLog = require('../models/SupportEmailAuditLog');
const SupportEmail = require('../models/SupportEmail');
const SupportTicket = require('../models/SupportTicket');
const GoogleSheetsSyncJob = require('../models/GoogleSheetsSyncJob');
const { APPROVED_MAILBOX } = require('../services/supportEmail/mailboxScopeService');
const { isBulkProcessingEnabled, getProcessingConfig } = require('../services/supportEmail/processingConfig');
const { runProcessingBatch } = require('../services/supportEmail/pipelineService');
const { runSingleEmailTest } = require('../services/supportEmail/singleEmailTestService');
const dashboard = require('../services/supportEmail/adminDashboardService');

const ACTIVATION = '2026-11-18T00:00:00.000Z';

let server;
let baseUrl;
let superToken;
let agentToken;

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${options.token || superToken}` };
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  return { status: response.status, data };
}

function approvedBody(overrides = {}) {
  return {
    mailbox: APPROVED_MAILBOX,
    enabled: false,
    activationAt: ACTIVATION,
    approveActivation: true,
    ...overrides
  };
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
  const superAdmin = await Admin.create({ username: 'policy-super', password: 'secret12', name: 'Root', isSuperAdmin: true, sectionAccess: [] });
  const agent = await Admin.create({ username: 'policy-agent', password: 'secret12', name: 'Agent', isSuperAdmin: false, sectionAccess: ['support-email'] });
  superToken = jwt.sign({ adminId: superAdmin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
  agentToken = jwt.sign({ adminId: agent._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await teardownTestDb();
});

test('only the exact value 1 enables the bulk worker, and 0 keeps it off', () => {
  assert.equal(isBulkProcessingEnabled({}), false);
  assert.equal(isBulkProcessingEnabled({ SUPPORT_EMAIL_PROCESSING_ENABLED: '0' }), false);
  assert.equal(isBulkProcessingEnabled({ SUPPORT_EMAIL_PROCESSING_ENABLED: 'false' }), false);
  assert.equal(isBulkProcessingEnabled({ SUPPORT_EMAIL_PROCESSING_ENABLED: 'true' }), false);
  assert.equal(isBulkProcessingEnabled({ SUPPORT_EMAIL_PROCESSING_ENABLED: '' }), false);
  assert.equal(isBulkProcessingEnabled({ SUPPORT_EMAIL_PROCESSING_ENABLED: ' 1 ' }), true);
  assert.equal(getProcessingConfig({ enabled: '0' }).enabled, false);
  assert.equal(getProcessingConfig({ enabled: false }).enabled, false);
  assert.equal(getProcessingConfig({ enabled: true }).enabled, true);
  process.env.SUPPORT_EMAIL_PROCESSING_ENABLED = '0';
  assert.equal(getProcessingConfig().enabled, false);
  process.env.SUPPORT_EMAIL_PROCESSING_ENABLED = '1';
  assert.equal(getProcessingConfig().enabled, true);
  delete process.env.SUPPORT_EMAIL_PROCESSING_ENABLED;
});

test('a disabled flag makes the bulk worker return without processing', async () => {
  process.env.SUPPORT_EMAIL_PROCESSING_ENABLED = '0';
  const outcome = await runProcessingBatch();
  assert.equal(outcome.enabled, false);
  assert.equal(outcome.processed, 0);
  delete process.env.SUPPORT_EMAIL_PROCESSING_ENABLED;
});

test('creating a policy requires the approved mailbox, a real timestamp, and explicit approval', async () => {
  assert.equal((await api('/api/admin/support-email/ingestion-policy', { method: 'POST', token: agentToken, body: approvedBody({ enabled: true }) })).status, 403);

  const badEnabled = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody({ enabled: 'yes' }) });
  assert.equal(badEnabled.status, 400);
  assert.equal(badEnabled.data.message, 'enabled_required');

  const unapproved = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody({ approveActivation: false }) });
  assert.equal(unapproved.status, 400);
  assert.equal(unapproved.data.message, 'activation_not_approved');

  const wrong = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody({ mailbox: 'other@niatindia.com' }) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.message, 'invalid_mailbox');

  const badTime = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody({ activationAt: 'not-a-date' }) });
  assert.equal(badTime.status, 400);
  assert.equal(badTime.data.message, 'activation_invalid');

  const noTime = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody({ activationAt: '' }) });
  assert.equal(noTime.status, 400);
  assert.equal(noTime.data.message, 'activation_missing');

  const created = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody() });
  assert.equal(created.status, 201);
  assert.equal(created.data.policy.mailbox, APPROVED_MAILBOX);
  assert.equal(created.data.policy.enabled, false);
  assert.equal(new Date(created.data.policy.activationAt).toISOString(), ACTIVATION);
  assert.ok(created.data.policy.activationApprovedAt);
  assert.equal(await EmailIngestionPolicy.countDocuments(), 1);
  const audit = await SupportEmailAuditLog.findOne({ action: 'ingestion_policy_created' }).lean();
  assert.equal(audit.metadata.enabled, false);
  assert.equal(audit.metadata.activationAt, ACTIVATION);
  assert.equal(String(audit.adminId), (await Admin.findOne({ username: 'policy-super' }))._id.toString());
});

test('a second policy for the same mailbox is rejected and an update keeps one row', async () => {
  await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody() });
  const duplicate = await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody({ enabled: true }) });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.message, 'policy_exists');
  assert.equal(await EmailIngestionPolicy.countDocuments(), 1);

  const next = '2026-11-18T06:30:00.000Z';
  const blocked = await api('/api/admin/support-email/ingestion-policy', { method: 'PATCH', body: approvedBody({ enabled: true, activationAt: next }) });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.message, 'boundary_change_not_confirmed');
  const unchanged = await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX }).lean();
  assert.equal(unchanged.enabled, false);
  assert.equal(new Date(unchanged.activationAt).toISOString(), ACTIVATION);

  const updated = await api('/api/admin/support-email/ingestion-policy', { method: 'PATCH', body: approvedBody({ enabled: true, activationAt: next, confirmBoundaryChange: true }) });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.policy.enabled, true);
  assert.equal(new Date(updated.data.policy.activationAt).toISOString(), next);
  assert.equal(await EmailIngestionPolicy.countDocuments(), 1);
  const boundaryAudit = await SupportEmailAuditLog.findOne({ action: 'ingestion_policy_activation_changed' }).lean();
  assert.equal(boundaryAudit.metadata.beforeActivationAt, ACTIVATION);
  assert.equal(boundaryAudit.metadata.activationAt, next);
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'ingestion_policy_updated' }), 0);
});

test('a new policy document is disabled unless enabled is set', () => {
  assert.equal(new EmailIngestionPolicy({ mailbox: APPROVED_MAILBOX, activationAt: new Date() }).enabled, false);
});

test('readiness names the missing policy, invalid activation, and unverified Exchange scope', async () => {
  const empty = await api('/api/admin/support-email/health');
  const policyItem = empty.data.health.items.find((row) => row.key === 'mailbox_policy');
  const bulk = empty.data.health.items.find((row) => row.key === 'bulk_processing');
  const scope = empty.data.health.items.find((row) => row.key === 'exchange_scope');
  const graph = empty.data.health.items.find((row) => row.key === 'graph_auth');
  assert.equal(policyItem.verified, false);
  assert.match(policyItem.detail, /Missing policy/);
  assert.equal(bulk.verified, true);
  assert.match(bulk.detail, /Global processing is disabled/);
  assert.equal(scope.verified, false);
  assert.equal(scope.value, 'MAILBOX_SCOPE_UNVERIFIED');
  assert.equal(graph.verified, 'unknown');

  await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody() });
  const disabled = await api('/api/admin/support-email/single-email-test/readiness');
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.readiness.checks.find((row) => row.key === 'policy').code, 'policy_disabled');
  assert.equal(disabled.data.readiness.blockers.includes('policy_disabled'), true);
  assert.equal(disabled.data.readiness.blockers.includes('MAILBOX_SCOPE_UNVERIFIED'), true);
  assert.equal(disabled.data.readiness.blockers.includes('bulk_processing_enabled'), false);

  await EmailIngestionPolicy.updateOne({ mailbox: APPROVED_MAILBOX }, { $set: { enabled: true }, $unset: { activationAt: '' } });
  const health = await dashboard.health();
  assert.match(health.items.find((row) => row.key === 'mailbox_policy').detail, /Missing activation timestamp/);
});

test('messages before the approved activation time are rejected and the worker stays off', async () => {
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED = '1';
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX = APPROVED_MAILBOX;
  process.env.SUPPORT_EMAIL_PROCESSING_ENABLED = '0';
  await api('/api/admin/support-email/ingestion-policy', {
    method: 'POST',
    body: approvedBody({ enabled: true, activationAt: '2026-11-18T12:00:00.000Z' })
  });
  const calls = [];
  const graph = {
    calls,
    async get(url) {
      calls.push(String(url));
      return {
        id: 'AAMkAGPolicyBoundary0001',
        internetMessageId: '<boundary@example.com>',
        conversationId: 'conversation-boundary',
        receivedDateTime: '2026-11-18T11:59:59.000Z',
        subject: 'Too early',
        body: { contentType: 'text', content: 'Sent before activation.' },
        hasAttachments: false,
        from: { emailAddress: { name: 'Student', address: 'student@example.com' } },
        toRecipients: [{ emailAddress: { address: APPROVED_MAILBOX } }]
      };
    }
  };
  const admin = await Admin.findOne({ username: 'policy-super' });
  await assert.rejects(
    () => runSingleEmailTest({
      graphMessageId: 'AAMkAGPolicyBoundary0001',
      graphClient: graph,
      authService: { validateConfig() {}, async getAccessToken() { return 'token'; }, tokenExpiresAt: Date.now() + 1000 },
      admin
    }),
    (error) => error.code === 'historical_message'
  );
  assert.equal(calls.length, 1);
  assert.equal(await SupportEmail.countDocuments(), 0);
  assert.equal(await SupportTicket.countDocuments(), 0);
  assert.equal(await GoogleSheetsSyncJob.countDocuments(), 0);
  assert.equal((await runProcessingBatch()).enabled, false);
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED;
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX;
  delete process.env.SUPPORT_EMAIL_PROCESSING_ENABLED;
});

test('a Kolkata wall time is stored in UTC, shown in IST, and stays disabled', async () => {
  const created = await api('/api/admin/support-email/ingestion-policy', {
    method: 'POST',
    body: {
      mailbox: APPROVED_MAILBOX,
      activationAt: '2026-11-18T10:00',
      timeZone: 'Asia/Kolkata',
      approveActivation: true
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.policy.enabled, false);
  assert.equal(created.data.policy.status, 'disabled');
  assert.equal(new Date(created.data.policy.activationAt).toISOString(), '2026-11-18T04:30:00.000Z');
  assert.equal(created.data.policy.activationLocal, '2026-11-18 10:00 IST');
  assert.equal(created.data.policy.activationTimeZone, 'Asia/Kolkata');
  assert.equal(created.data.policy.configuredBy.name, 'Root');
  assert.ok(created.data.policy.activationApprovedAt);

  const health = await dashboard.health();
  const policy = health.ingestion.policies[0];
  const item = health.items.find((row) => row.key === 'mailbox_policy');
  assert.equal(policy.status, 'disabled');
  assert.equal(policy.activationLocal, '2026-11-18 10:00 IST');
  assert.equal(policy.configuredBy.name, 'Root');
  assert.match(item.detail, /Policy status: disabled/);
  assert.match(item.detail, /2026-11-18 10:00 IST/);
  assert.equal(health.ingestion.mailboxScope, 'MAILBOX_SCOPE_UNVERIFIED');

  const wrongZone = await api('/api/admin/support-email/ingestion-policy', {
    method: 'PATCH',
    body: { mailbox: APPROVED_MAILBOX, activationAt: '2026-11-18T11:00', timeZone: 'America/New_York', approveActivation: true, confirmBoundaryChange: true }
  });
  assert.equal(wrongZone.status, 400);
  assert.equal(wrongZone.data.message, 'activation_invalid');
  assert.equal((await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX })).activationAt.toISOString(), '2026-11-18T04:30:00.000Z');
});

test('enabling processing does not move the activation timestamp, and an omitted timestamp is kept', async () => {
  await api('/api/admin/support-email/ingestion-policy', { method: 'POST', body: approvedBody() });
  const before = await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX }).lean();
  const enabled = await api('/api/admin/support-email/ingestion-policy', {
    method: 'PATCH',
    body: { mailbox: APPROVED_MAILBOX, enabled: true }
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.policy.enabled, true);
  assert.equal(new Date(enabled.data.policy.activationAt).toISOString(), ACTIVATION);
  const afterEnable = await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX }).lean();
  assert.equal(new Date(afterEnable.activationApprovedAt).toISOString(), new Date(before.activationApprovedAt).toISOString());
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'ingestion_policy_updated' }), 1);
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'ingestion_policy_activation_changed' }), 0);

  const same = await api('/api/admin/support-email/ingestion-policy', {
    method: 'PATCH',
    body: { mailbox: APPROVED_MAILBOX, activationAt: ACTIVATION, approveActivation: true }
  });
  assert.equal(same.status, 200);
  assert.equal(same.data.policy.enabled, true);
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'ingestion_policy_activation_changed' }), 0);

  assert.equal((await api('/api/admin/support-email/ingestion-policy', {
    method: 'PATCH',
    token: agentToken,
    body: { mailbox: APPROVED_MAILBOX, enabled: false }
  })).status, 403);
  assert.equal((await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX })).enabled, true);
});

test('a message received at the activation instant is eligible and one millisecond earlier is not', async () => {
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED = '1';
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX = APPROVED_MAILBOX;
  process.env.SUPPORT_EMAIL_PROCESSING_ENABLED = '0';
  await api('/api/admin/support-email/ingestion-policy', {
    method: 'POST',
    body: approvedBody({ enabled: true, activationAt: '2026-11-18T12:00:00.000Z' })
  });
  const admin = await Admin.findOne({ username: 'policy-super' });
  const authService = { validateConfig() {}, async getAccessToken() { return 'token'; }, tokenExpiresAt: Date.now() + 1000 };
  const classification = JSON.stringify({
    category: 'feedback',
    subcategory: 'complaint',
    intent: 'complaint',
    priority: 'high',
    urgency: 'medium',
    sentiment: 'negative',
    summary: 'The student reported rude counsellor behaviour.',
    studentIdentifiers: { name: '', email: '', phone: '', rollNumber: '', course: '' },
    recommendedAction: 'Review the complaint.',
    confidence: 0.91,
    needsHumanReview: false
  });
  function client(receivedDateTime, id) {
    return {
      async get() {
        return {
          id,
          internetMessageId: `<${id}@example.com>`,
          conversationId: 'conversation-boundary',
          receivedDateTime,
          subject: 'Boundary',
          body: { contentType: 'text', content: 'The counsellor was rude during the call.' },
          hasAttachments: false,
          from: { emailAddress: { name: 'Student', address: 'student@example.com' } },
          toRecipients: [{ emailAddress: { address: APPROVED_MAILBOX } }]
        };
      }
    };
  }
  const accepted = await runSingleEmailTest({
    graphMessageId: 'AAMkAGPolicyEqual0001',
    graphClient: client('2026-11-18T12:00:00.000Z', 'AAMkAGPolicyEqual0001'),
    authService,
    admin,
    chatCompletion: async () => ({ content: classification, model: 'test-model' })
  });
  assert.ok(accepted.ticket.id);
  assert.equal(accepted.sheets, 'skipped_test_mode');
  assert.equal(await GoogleSheetsSyncJob.countDocuments(), 0);
  assert.equal((await runProcessingBatch()).enabled, false);

  await assert.rejects(
    () => runSingleEmailTest({
      graphMessageId: 'AAMkAGPolicyBefore0001',
      graphClient: client('2026-11-18T11:59:59.999Z', 'AAMkAGPolicyBefore0001'),
      authService,
      admin,
      chatCompletion: async () => ({ content: classification, model: 'test-model' })
    }),
    (error) => error.code === 'historical_message'
  );
  assert.equal(await SupportEmail.countDocuments(), 1);
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED;
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX;
  delete process.env.SUPPORT_EMAIL_PROCESSING_ENABLED;
});
