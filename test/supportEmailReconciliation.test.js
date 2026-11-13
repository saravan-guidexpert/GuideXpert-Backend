'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  setupTestDb,
  clearTestDb,
  teardownTestDb
} = require('./supportEmail/harness');

const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const GraphSubscription = require('../models/GraphSubscription');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');

const {
  reconcileMailbox,
  runAllReconciliations,
  RECONCILIATION_INTERVAL_MS
} = require('../services/supportEmail/reconciliationService');
const { SubscriptionService } = require('../services/supportEmail/subscriptionService');

class MockGraphClient {
  constructor() {
    this.requests = [];
  }

  async get(url, options = {}) {
    return this.request({ ...options, url, method: 'GET' });
  }

  async post(url, data, options = {}) {
    return this.request({ ...options, url, method: 'POST', data });
  }

  async request({ url, method = 'GET', data }) {
    this.requests.push({ url, method, data });
    if (url === '/subscriptions' && method === 'POST') {
      return {
        id: `sub-${Date.now()}`,
        resource: data.resource,
        expirationDateTime: new Date(Date.now() + 4200 * 60 * 1000).toISOString()
      };
    }
    return {
      value: [],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/messages/delta?token=fresh-token-123'
    };
  }
}

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
});

test.after(async () => {
  await teardownTestDb();
});

// ==========================================
// 1. Single Mailbox Reconciliation Tests
// ==========================================

test('1. reconcileMailbox skips when policy is disabled or missing', async () => {
  const mailbox = 'disabled@guidexpert.com';
  // Policy exists but enabled = false
  await EmailIngestionPolicy.create({ mailbox, enabled: false, activationAt: new Date() });

  const result = await reconcileMailbox({ mailbox, folder: 'inbox' });

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'policy_disabled_or_missing');
});

test('2. reconcileMailbox repairs missing subscription via health check', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const result = await reconcileMailbox({
    mailbox,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  // Health check should have created a subscription
  assert.ok(result.subscription);
  assert.strictEqual(result.subscription.created, true);

  const subDoc = await GraphSubscription.findOne({ mailbox });
  assert.ok(subDoc);
  assert.strictEqual(subDoc.status, 'active');
});

test('3. reconcileMailbox skips sync if cursor is fresh and no pending sync', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  // Cursor was synced 2 minutes ago (well within 15m interval)
  const recentSync = new Date(Date.now() - 2 * 60 * 1000);
  await EmailSyncCursor.create({
    mailbox,
    folder: 'inbox',
    deltaLink: 'https://graph.microsoft.com/delta-link-token',
    lastSuccessfulSyncAt: recentSync,
    baselineCompletedAt: recentSync,
    hasPendingSync: false,
    syncStatus: 'idle'
  });

  // Active healthy subscription
  await GraphSubscription.create({
    subscriptionId: 'sub-active-1',
    mailbox,
    folder: 'inbox',
    resource: "users/support%40guidexpert.com/mailFolders('inbox')/messages",
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'abc',
    status: 'active'
  });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  const result = await reconcileMailbox({
    mailbox,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(result.synced, false);
  assert.strictEqual(result.reason, 'already_up_to_date');
});

test('4. reconcileMailbox recovers missed webhook when hasPendingSync is true', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  // Cursor has pending sync signaled by missed webhook
  const recentSync = new Date(Date.now() - 2 * 60 * 1000);
  await EmailSyncCursor.create({
    mailbox,
    folder: 'inbox',
    deltaLink: 'https://graph.microsoft.com/delta-link-token',
    lastSuccessfulSyncAt: recentSync,
    baselineCompletedAt: recentSync,
    hasPendingSync: true,
    syncRequestVersion: 3,
    lastSyncedVersion: 1,
    syncStatus: 'idle'
  });

  await GraphSubscription.create({
    subscriptionId: 'sub-active-2',
    mailbox,
    folder: 'inbox',
    resource: "users/support%40guidexpert.com/mailFolders('inbox')/messages",
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'abc',
    status: 'active'
  });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  const result = await reconcileMailbox({
    mailbox,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(result.synced, true);
  assert.ok(result.syncResult);
  assert.strictEqual(result.syncResult.executed, true);

  // Verify cursor pending sync flag cleared after successful coalesced sync
  const cursorAfter = await EmailSyncCursor.findOne({ mailbox });
  assert.strictEqual(cursorAfter.hasPendingSync, false);
  assert.strictEqual(cursorAfter.syncStatus, 'idle');
});

test('5. reconcileMailbox recovers crashed worker with expired lease', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  // Cursor stuck in 'syncing' with expired lease 5 minutes ago
  const leaseExpired = new Date(Date.now() - 5 * 60 * 1000);
  await EmailSyncCursor.create({
    mailbox,
    folder: 'inbox',
    deltaLink: 'https://graph.microsoft.com/delta-link-token',
    lastSuccessfulSyncAt: new Date(Date.now() - 30 * 60 * 1000),
    baselineCompletedAt: new Date(Date.now() - 30 * 60 * 1000),
    syncStatus: 'syncing',
    syncLeaseExpiresAt: leaseExpired,
    syncLockToken: 'stale-crashed-worker-token'
  });

  await GraphSubscription.create({
    subscriptionId: 'sub-active-3',
    mailbox,
    folder: 'inbox',
    resource: "users/support%40guidexpert.com/mailFolders('inbox')/messages",
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'abc',
    status: 'active'
  });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  const result = await reconcileMailbox({
    mailbox,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(result.synced, true);
  assert.strictEqual(result.syncResult.executed, true);

  // Lock recovered and released to idle
  const cursorAfter = await EmailSyncCursor.findOne({ mailbox });
  assert.strictEqual(cursorAfter.syncStatus, 'idle');
  assert.strictEqual(cursorAfter.syncLockToken, null);
});

test('6. reconcileMailbox recovers periodic stale interval (>15m)', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  // Last sync was 20 minutes ago (> 15m default threshold)
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
  await EmailSyncCursor.create({
    mailbox,
    folder: 'inbox',
    deltaLink: 'https://graph.microsoft.com/delta-link-token',
    lastSuccessfulSyncAt: twentyMinsAgo,
    baselineCompletedAt: twentyMinsAgo,
    hasPendingSync: false,
    syncStatus: 'idle'
  });

  await GraphSubscription.create({
    subscriptionId: 'sub-active-4',
    mailbox,
    folder: 'inbox',
    resource: "users/support%40guidexpert.com/mailFolders('inbox')/messages",
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'abc',
    status: 'active'
  });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  const result = await reconcileMailbox({
    mailbox,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(result.synced, true);
  assert.strictEqual(result.syncResult.executed, true);
});

test('7. reconcileMailbox marks pending SupportEmailWebhookEvent records as processed', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  // Seed webhook event in 'received' state
  await SupportEmailWebhookEvent.create({
    eventId: 'evt-rec-1',
    subscriptionId: 'sub-active-5',
    changeType: 'created',
    resource: "users/support%40guidexpert.com/mailFolders('inbox')/messages",
    clientStateHash: 'abc',
    dedupeKey: 'evt-rec-1',
    status: 'received',
    receivedAt: new Date(),
    metadata: { mailbox }
  });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  await reconcileMailbox({
    mailbox,
    graphClient: mockGraph,
    subscriptionSvc: subSvc,
    forceSync: true
  });

  const eventAfter = await SupportEmailWebhookEvent.findOne({ dedupeKey: 'evt-rec-1' });
  assert.ok(eventAfter);
  assert.strictEqual(eventAfter.status, 'processed');
  assert.ok(eventAfter.processedAt);
});

// ==========================================
// 2. Batch Reconciliation & Budget Limits
// ==========================================

test('8. runAllReconciliations processes all enabled policies and skips disabled', async () => {
  await EmailIngestionPolicy.create({ mailbox: 'mb1@guidexpert.com', enabled: true, activationAt: new Date() });
  await EmailIngestionPolicy.create({ mailbox: 'mb2@guidexpert.com', enabled: true, activationAt: new Date() });
  await EmailIngestionPolicy.create({ mailbox: 'mb-disabled@guidexpert.com', enabled: false, activationAt: new Date() });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  const summary = await runAllReconciliations({
    batchBudgetMs: 45000,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(summary.totalPolicies, 2);
  assert.strictEqual(summary.processedCount, 2);
  assert.strictEqual(summary.results.length, 2);
});

test('9. runAllReconciliations terminates early when batchBudgetMs is exhausted', async () => {
  await EmailIngestionPolicy.create({ mailbox: 'mb1@guidexpert.com', enabled: true, activationAt: new Date() });
  await EmailIngestionPolicy.create({ mailbox: 'mb2@guidexpert.com', enabled: true, activationAt: new Date() });
  await EmailIngestionPolicy.create({ mailbox: 'mb3@guidexpert.com', enabled: true, activationAt: new Date() });

  const mockGraph = new MockGraphClient();
  const subSvc = new SubscriptionService({ graphClient: mockGraph });

  // Set tiny 0ms budget so it aborts after first policy check
  const summary = await runAllReconciliations({
    batchBudgetMs: 0,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(summary.totalPolicies, 3);
  // Should have processed at most 0 or 1 items before timing out
  assert.ok(summary.processedCount < 3);
});

test('10. runAllReconciliations isolates errors in individual mailboxes', async () => {
  await EmailIngestionPolicy.create({ mailbox: 'failing@guidexpert.com', enabled: true, activationAt: new Date() });
  await EmailIngestionPolicy.create({ mailbox: 'healthy@guidexpert.com', enabled: true, activationAt: new Date() });

  const mockGraph = new MockGraphClient();
  // Fail specifically on failing mailbox
  const subSvc = {
    async syncSubscriptionHealth({ mailbox }) {
      if (mailbox === 'failing@guidexpert.com') {
        throw new Error('Graph connectivity timeout');
      }
      return { healthy: true };
    }
  };

  const summary = await runAllReconciliations({
    batchBudgetMs: 45000,
    graphClient: mockGraph,
    subscriptionSvc: subSvc
  });

  assert.strictEqual(summary.processedCount, 2);
  assert.strictEqual(summary.results[1].mailbox, 'healthy@guidexpert.com');
  assert.strictEqual(summary.results[1].synced, true);
});

// ==========================================
// 3. Cron Route Authentication Tests
// ==========================================

function createMockExpressResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(content) {
      this.body = content;
      return this;
    }
  };
}

test('11. cron route rejects unauthorized request when secret is missing or invalid', async () => {
  const cronRoutes = require('../routes/cronRoutes');
  process.env.CRON_SECRET = 'super-secret-cron-token-12345';

  const routeHandler = cronRoutes.stack.find(
    layer => layer.route && layer.route.path === '/support-email-reconcile'
  );
  assert.ok(routeHandler, 'Expected /support-email-reconcile route layer to exist');

  // Find verifyCronSecret middleware and final handler in the route stack
  const [authMiddleware, execHandler] = routeHandler.route.stack.map(s => s.handle);

  const req = {
    path: '/api/cron/support-email-reconcile',
    query: {},
    headers: { authorization: 'Bearer invalid-token' }
  };
  const res = createMockExpressResponse();
  let nextCalled = false;

  await authMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.success, false);
});

test('12. cron route accepts authorized request with valid CRON_SECRET and returns summary', async () => {
  const cronRoutes = require('../routes/cronRoutes');
  const secret = 'valid-test-cron-token-123';
  process.env.CRON_SECRET = secret;

  await EmailIngestionPolicy.create({ mailbox: 'cron-mb@guidexpert.com', enabled: true, activationAt: new Date() });

  const routeHandler = cronRoutes.stack.find(
    layer => layer.route && layer.route.path === '/support-email-reconcile'
  );
  const [authMiddleware, execHandler] = routeHandler.route.stack.map(s => s.handle);

  const req = {
    path: '/api/cron/support-email-reconcile',
    query: {},
    headers: { authorization: `Bearer ${secret}` }
  };
  const res = createMockExpressResponse();
  let nextCalled = false;

  await authMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true);

  // Call the execution handler
  await execHandler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.outcome);
  assert.strictEqual(res.body.outcome.totalPolicies, 1);
});
