'use strict';

/**
 * Phase 2B — ambiguous Microsoft Graph subscription recovery.
 *
 * These tests drive SubscriptionService.createSubscription / syncSubscriptionHealth,
 * which enter the real recovery workflow. They assert Graph call counts, MongoDB
 * subscription rows, operation state and reservation ownership.
 */

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'ambiguous-recovery-admin-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const GraphSubscription = require('../models/GraphSubscription');
const GraphSubscriptionOperation = require('../models/GraphSubscriptionOperation');
const SupportEmailAuditLog = require('../models/SupportEmailAuditLog');
const Admin = require('../models/Admin');
const requireAdmin = require('../middleware/requireAdmin');
const { createSupportEmailAdminRouter } = require('../routes/supportEmailAdminRoutes');
const {
  SubscriptionService,
  HASH_SCHEMES,
  hashClientState,
  formatGraphResource,
  reservationKeyFor
} = require('../services/supportEmail/subscriptionService');
const { GraphClient, GraphClientError } = require('../services/supportEmail/graphClient');

const NOTIFICATION_URL = 'https://api.example.com/api/support-email/webhooks/graph';
const SECRET = 'ambiguous-recovery-hmac-secret-32b';
let adminServer = null;
let adminBaseUrl = '';
let currentAdminService = null;

class RecordingGraph {
  constructor() {
    this.requests = [];
    this.remote = [];
    this.failPost = null;
    this.pages = null;
    this.byId = new Map();
    this.detailFailures = new Map();
    this.listClientStateOverride = undefined;
    this.holdFirstLookup = false;
    this.hold = Promise.resolve();
    this.lookups = 0;
  }

  async request({ url, method = 'GET', data }) {
    const normalized = String(method).toUpperCase();
    this.requests.push({ url, method: normalized });

    if (normalized === 'POST' && url === '/subscriptions') {
      if (this.failPost) {
        const created = this.failPost(data);
        if (created) this.remote = [created];
        const err = new Error('timeout of 15000ms exceeded');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return {
        id: 'sub-created',
        resource: data.resource,
        notificationUrl: data.notificationUrl,
        lifecycleNotificationUrl: data.lifecycleNotificationUrl,
        changeType: data.changeType,
        expirationDateTime: data.expirationDateTime
      };
    }

    if (normalized === 'GET' && url === '/subscriptions') {
      this.lookups += 1;
      if (this.holdFirstLookup && this.lookups === 1) await this.hold;
      if (this.pages) return this.pages.shift();
      return { value: this.remote.map((item) => this.listItem(item)) };
    }

    if (normalized === 'GET' && url.startsWith('/subscriptions/')) {
      this.lookups += 1;
      if (this.holdFirstLookup && this.lookups === 1) await this.hold;
      const id = decodeURIComponent(url.slice('/subscriptions/'.length));
      if (this.detailFailures && this.detailFailures.has(id)) {
        const failure = this.detailFailures.get(id);
        const err = new Error(failure.message || 'candidate detail failed');
        err.statusCode = failure.statusCode || 500;
        throw err;
      }
      if (this.byId.has(id)) return this.byId.get(id);
      const found = this.remote.find((item) => item.id === id);
      if (found) return found;
      const err = new Error('not found');
      err.statusCode = 404;
      throw err;
    }

    if (normalized === 'DELETE') return {};
    throw new Error(`Unhandled ${normalized} ${url}`);
  }

  listItem(item) {
    const copy = { ...item };
    copy.clientState = this.listClientStateOverride === undefined ? null : this.listClientStateOverride;
    return copy;
  }

  postCount() {
    return this.requests.filter((request) => request.method === 'POST').length;
  }

  deleteCount() {
    return this.requests.filter((request) => request.method === 'DELETE').length;
  }
}

function remoteFor(data, id) {
  return {
    id,
    resource: data.resource,
    notificationUrl: data.notificationUrl,
    lifecycleNotificationUrl: data.lifecycleNotificationUrl,
    changeType: data.changeType,
    clientState: data.clientState,
    expirationDateTime: data.expirationDateTime
  };
}

function serviceFor(client, extras = {}) {
  return new SubscriptionService({
    graphClient: client,
    notificationUrl: NOTIFICATION_URL,
    recoveryPolicy: {
      requiredAbsenceObservations: 3,
      minRecheckDelayMs: 60 * 1000,
      recoveryClaimMs: 60 * 1000,
      leaseBufferMs: 1000,
      manualHoldMs: 60 * 60 * 1000
    },
    ...extras
  });
}

async function seedAmbiguous({
  mailbox,
  operationId,
  subscriptionId = null,
  clientState = 'known-client-state',
  leaseExpiresAt = new Date(Date.now() - 60 * 1000),
  graphPostDispatchedAt = new Date(Date.now() - 120 * 1000),
  state = 'failed',
  failureClassification = 'ambiguous'
}) {
  return GraphSubscriptionOperation.create({
    operationId,
    mailbox,
    folder: 'inbox',
    resource: formatGraphResource(mailbox, 'inbox'),
    notificationUrl: NOTIFICATION_URL,
    lifecycleUrl: NOTIFICATION_URL,
    changeType: 'created,updated',
    state,
    failureClassification,
    subscriptionId,
    clientStateHash: hashClientState(clientState, SECRET, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'primary',
    leaseExpiresAt,
    graphPostDispatchedAt,
    reservationKey: reservationKeyFor(mailbox, 'inbox'),
    requestedExpirationMinutes: 4200
  });
}

function matchingRemote({ mailbox, id, clientState, expiresInMs = 4000 * 60 * 1000 }) {
  return {
    id,
    resource: formatGraphResource(mailbox, 'inbox'),
    notificationUrl: NOTIFICATION_URL,
    lifecycleNotificationUrl: NOTIFICATION_URL,
    changeType: 'updated, created',
    clientState,
    expirationDateTime: new Date(Date.now() + expiresInMs).toISOString()
  };
}

test.before(async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = SECRET;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  process.env.ADMIN_JWT_SECRET = 'ambiguous-recovery-admin-secret';
  delete process.env.NODE_ENV;
  await setupTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/support-email', requireAdmin, createSupportEmailAdminRouter({
    getSubscriptionService: () => currentAdminService
  }));
  adminServer = app.listen(0);
  adminBaseUrl = `http://127.0.0.1:${adminServer.address().port}`;
});

test.beforeEach(async () => {
  await clearTestDb();
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = SECRET;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  delete process.env.NODE_ENV;
});

test.after(async () => {
  if (adminServer) await new Promise((resolve) => adminServer.close(resolve));
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  await teardownTestDb();
});

test('1-4. lost Graph response is adopted by the next worker after lease expiry', async () => {
  const mailbox = 'lost-response@example.com';
  const client = new RecordingGraph();
  client.failPost = (data) => remoteFor(data, 'sub-lost-response');
  const svc = serviceFor(client);

  await assert.rejects(() => svc.createSubscription({ mailbox }), (err) => err.code === 'ETIMEDOUT');
  assert.strictEqual(client.postCount(), 1);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);

  const ambiguous = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(ambiguous.failureClassification, 'ambiguous');
  assert.ok(ambiguous.graphPostDispatchedAt);
  assert.ok(ambiguous.reservationKey);
  await GraphSubscriptionOperation.updateOne(
    { operationId: ambiguous.operationId },
    { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } }
  );

  const recovered = await svc.createSubscription({ mailbox });
  assert.strictEqual(recovered.adopted, true);
  assert.strictEqual(recovered.created, false);
  assert.strictEqual(client.postCount(), 1, 'Recovery must not POST');
  assert.strictEqual(client.deleteCount(), 0);

  const local = await GraphSubscription.find({ mailbox }).lean();
  assert.strictEqual(local.length, 1);
  assert.strictEqual(local[0].subscriptionId, 'sub-lost-response');
  assert.strictEqual(local[0].status, 'active');
  assert.strictEqual(local[0].clientState, undefined);

  const op = await GraphSubscriptionOperation.findOne({ operationId: ambiguous.operationId }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  assert.strictEqual(op.subscriptionId, 'sub-lost-response');
});

test('5. multiple identity matches are not adopted and the reservation stays held', async () => {
  const mailbox = 'multi-match@example.com';
  const clientState = 'shared-client-state';
  await seedAmbiguous({ mailbox, operationId: 'op-multi', clientState });
  const client = new RecordingGraph();
  client.remote = [
    matchingRemote({ mailbox, id: 'sub-multi-a', clientState }),
    matchingRemote({ mailbox, id: 'sub-multi-b', clientState })
  ];
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.adopted, false);
  assert.strictEqual(result.manualRecoveryRequired, true);
  assert.strictEqual(result.reason, 'multiple_matches');
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-multi' }).lean();
  assert.strictEqual(op.state, 'failed');
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
});

test('6. Graph enumeration failure keeps the operation unresolved', async () => {
  const mailbox = 'enum-fail@example.com';
  await seedAmbiguous({ mailbox, operationId: 'op-enum-fail' });
  const client = new RecordingGraph();
  client.request = async ({ url, method = 'GET' }) => {
    client.requests.push({ url, method: String(method).toUpperCase() });
    const err = new Error('graph unavailable');
    err.statusCode = 503;
    throw err;
  };
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.reason, 'enumeration_incomplete');
  assert.strictEqual(result.adopted, false);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-enum-fail' }).lean();
  assert.strictEqual(op.state, 'failed');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.strictEqual(op.absenceObservations, 0);
  assert.ok(op.recoveryAttempts >= 1);

  const again = await svc.createSubscription({ mailbox });
  assert.strictEqual(again.reason, 'active_reservation');
  assert.strictEqual(client.requests.filter((request) => request.method === 'GET').length, 1);
});

test('7. pagination failure halfway does not adopt from the pages already read', async () => {
  const mailbox = 'page-fail@example.com';
  const clientState = 'page-client-state';
  await seedAmbiguous({ mailbox, operationId: 'op-page-fail', clientState });
  const client = new RecordingGraph();
  const visible = matchingRemote({ mailbox, id: 'sub-page-visible', clientState });
  client.request = async ({ url, method = 'GET' }) => {
    client.requests.push({ url, method: String(method).toUpperCase() });
    if (url === '/subscriptions') {
      return {
        value: [{ ...visible, clientState: null }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=page2'
      };
    }
    const err = new Error('page 2 failed');
    err.statusCode = 500;
    throw err;
  };
  const svc = serviceFor(client);
  const result = await svc.createSubscription({ mailbox });

  assert.strictEqual(result.reason, 'enumeration_incomplete');
  assert.strictEqual(result.adopted, false);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);
  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-page-fail' }).lean();
  assert.strictEqual(op.absenceObservations, 0);
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.notStrictEqual(op.state, 'abandoned');
});

test('8. the first complete enumeration with no match does not authorize another POST', async () => {
  const mailbox = 'first-miss@example.com';
  await seedAmbiguous({ mailbox, operationId: 'op-first-miss' });
  const client = new RecordingGraph();
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.reason, 'not_found_remotely');
  assert.strictEqual(result.absenceObservations, 1);
  assert.strictEqual(result.manualRecoveryRequired, false);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-first-miss' }).lean();
  assert.strictEqual(op.recoveryState, 'awaiting_recheck');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.ok(new Date(op.nextRecoveryAt).getTime() > Date.now());
});

test('9. a later enumeration, after the recheck delay, adopts the subscription', async () => {
  const mailbox = 'delayed-adopt@example.com';
  const clientState = 'delayed-client-state';
  let clock = Date.now();
  await seedAmbiguous({
    mailbox,
    operationId: 'op-delayed',
    clientState,
    leaseExpiresAt: new Date(clock - 1000)
  });
  const client = new RecordingGraph();
  const svc = serviceFor(client, {
    nowFn: () => new Date(clock),
    recoveryPolicy: {
      requiredAbsenceObservations: 3,
      minRecheckDelayMs: 1000,
      recoveryClaimMs: 60 * 1000,
      leaseBufferMs: 1000,
      manualHoldMs: 60 * 60 * 1000
    }
  });

  const first = await svc.createSubscription({ mailbox });
  assert.strictEqual(first.reason, 'not_found_remotely');
  assert.strictEqual(first.absenceObservations, 1);
  const getsAfterFirst = client.requests.filter((request) => request.method === 'GET').length;

  const tooSoon = await svc.createSubscription({ mailbox });
  assert.strictEqual(tooSoon.reason, 'active_reservation');
  assert.strictEqual(client.requests.filter((request) => request.method === 'GET').length, getsAfterFirst);
  assert.strictEqual(client.postCount(), 0);

  clock += 1001;
  client.remote = [matchingRemote({ mailbox, id: 'sub-delayed', clientState })];
  const adopted = await svc.createSubscription({ mailbox });
  assert.strictEqual(adopted.adopted, true);
  assert.strictEqual(adopted.subscription.subscriptionId, 'sub-delayed');
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-delayed' }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox, status: 'active' }), 1);
});

test('10. a known subscriptionId is recovered by exact lookup and not by adopting a different id', async () => {
  const mailbox = 'known-id@example.com';
  const clientState = 'known-id-client-state';
  await seedAmbiguous({
    mailbox,
    operationId: 'op-known-id',
    clientState,
    subscriptionId: 'sub-known-id'
  });
  const client = new RecordingGraph();
  client.byId.set('sub-known-id', matchingRemote({ mailbox, id: 'sub-known-id', clientState }));
  client.remote = [matchingRemote({ mailbox, id: 'sub-other', clientState })];
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.adopted, true);
  assert.strictEqual(result.subscription.subscriptionId, 'sub-known-id');
  assert.ok(client.requests.some((request) => request.method === 'GET' && request.url === '/subscriptions/sub-known-id'));
  assert.strictEqual(client.requests.filter((request) => request.url === '/subscriptions').length, 0);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-known-id' }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  assert.strictEqual(await GraphSubscription.countDocuments({ subscriptionId: 'sub-other' }), 0);
});

test('11. MongoDB adoption failure retains the reservation and does not complete the operation', async () => {
  const mailbox = 'persist-fail@example.com';
  const clientState = 'persist-client-state';
  await seedAmbiguous({ mailbox, operationId: 'op-persist', clientState });
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-persist', clientState })];
  const svc = serviceFor(client);
  const original = GraphSubscription.findOneAndUpdate;
  GraphSubscription.findOneAndUpdate = () => ({
    lean: async () => {
      throw new Error('MongoDB write failed');
    }
  });

  try {
    const result = await svc.createSubscription({ mailbox });
    assert.strictEqual(result.reason, 'persistence_failed');
    assert.strictEqual(result.adopted, false);
  } finally {
    GraphSubscription.findOneAndUpdate = original;
  }

  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);
  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-persist' }).lean();
  assert.strictEqual(op.state, 'failed');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.notStrictEqual(op.state, 'completed');
  assert.strictEqual(op.recoveryClaimedBy, null);
});

test('12. concurrent recovery workers cannot release each others reservation', async () => {
  const mailbox = 'concurrent-recover@example.com';
  const clientState = 'concurrent-client-state';
  await seedAmbiguous({ mailbox, operationId: 'op-concurrent', clientState });
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-concurrent', clientState })];
  let releaseLookup;
  client.holdFirstLookup = true;
  client.hold = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const svc = serviceFor(client);

  const first = svc.createSubscription({ mailbox });
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const claimed = await GraphSubscriptionOperation.findOne({ operationId: 'op-concurrent' }).lean();
    if (claimed && claimed.recoveryClaimedBy && claimed.recoveryState === 'enumerating') break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const second = await svc.createSubscription({ mailbox });
  const midpoint = await GraphSubscriptionOperation.findOne({ operationId: 'op-concurrent' }).lean();
  assert.strictEqual(second.adopted, false);
  assert.strictEqual(second.reason, 'recovery_in_progress');
  assert.ok(midpoint.reservationKey, 'The waiting worker must still own the reservation');
  assert.ok(midpoint.recoveryClaimedBy);

  releaseLookup();
  const winner = await first;
  assert.strictEqual(winner.adopted, true);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox, status: 'active' }), 1);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-concurrent' }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  assert.strictEqual(await GraphSubscriptionOperation.countDocuments({ mailbox }), 1);
});

test('13. createSubscription issues one POST when GraphClient sees an ambiguous subscription failure', async () => {
  const mailbox = 'no-retry-post@example.com';
  let calls = 0;
  const graphClient = new GraphClient({
    authService: { getAccessToken: async () => 'token', clearCachedToken() {} },
    httpRequester: async () => {
      calls += 1;
      const err = new Error('timeout of 15000ms exceeded');
      err.code = 'ECONNRESET';
      throw err;
    },
    maxRetries: 4,
    baseBackoffMs: 1,
    sleepFn: async () => {}
  });
  const svc = serviceFor(graphClient);

  await assert.rejects(
    () => svc.createSubscription({ mailbox }),
    (err) => err instanceof GraphClientError && err.ambiguousOutcome === true
  );
  assert.strictEqual(calls, 1);
  const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(op.failureClassification, 'ambiguous');
  assert.ok(op.graphPostDispatchedAt);
  assert.ok(op.reservationKey);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);
});

test('14. a confirmed Graph rejection releases the reservation and the next create POSTs once', async () => {
  const mailbox = 'confirmed-reject@example.com';
  const client = new RecordingGraph();
  let reject = true;
  const original = client.request.bind(client);
  client.request = async (options) => {
    if (options.method === 'POST' && reject) {
      client.requests.push({ url: options.url, method: 'POST' });
      const err = new Error('Invalid notification URL');
      err.statusCode = 400;
      throw err;
    }
    return original(options);
  };
  const svc = serviceFor(client);

  await assert.rejects(() => svc.createSubscription({ mailbox }), (err) => err.statusCode === 400);
  const rejected = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(rejected.failureClassification, 'confirmed_rejection');
  assert.strictEqual(rejected.reservationKey, null);

  reject = false;
  const created = await svc.createSubscription({ mailbox });
  assert.strictEqual(created.created, true);
  assert.strictEqual(client.postCount(), 2);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox, status: 'active' }), 1);
});

test('15. expired pending work is reusable only when no POST was dispatched', async () => {
  const neverSent = 'pending-never-sent@example.com';
  await GraphSubscriptionOperation.create({
    operationId: 'op-never-sent',
    mailbox: neverSent,
    folder: 'inbox',
    resource: formatGraphResource(neverSent, 'inbox'),
    notificationUrl: NOTIFICATION_URL,
    state: 'pending',
    leaseExpiresAt: new Date(Date.now() - 1000),
    reservationKey: reservationKeyFor(neverSent, 'inbox'),
    requestedExpirationMinutes: 4200
  });
  const neverSentClient = new RecordingGraph();
  const neverSentResult = await serviceFor(neverSentClient).createSubscription({ mailbox: neverSent });
  assert.strictEqual(neverSentResult.created, true);
  assert.strictEqual(neverSentClient.postCount(), 1);
  const abandoned = await GraphSubscriptionOperation.findOne({ operationId: 'op-never-sent' }).lean();
  assert.strictEqual(abandoned.state, 'abandoned');
  assert.strictEqual(abandoned.reservationKey, null);

  const dispatched = 'pending-dispatched@example.com';
  await seedAmbiguous({
    mailbox: dispatched,
    operationId: 'op-dispatched',
    state: 'pending',
    failureClassification: null
  });
  const dispatchedClient = new RecordingGraph();
  const blocked = await serviceFor(dispatchedClient).createSubscription({ mailbox: dispatched });
  assert.strictEqual(blocked.created, false);
  assert.strictEqual(dispatchedClient.postCount(), 0);
  const stillHeld = await GraphSubscriptionOperation.findOne({ operationId: 'op-dispatched' }).lean();
  assert.notStrictEqual(stillHeld.state, 'abandoned');
  assert.strictEqual(stillHeld.reservationKey, reservationKeyFor(dispatched, 'inbox'));
});

test('bounded rechecks end in manual recovery and still do not POST', async () => {
  const mailbox = 'manual-terminal@example.com';
  let clock = Date.now();
  await seedAmbiguous({
    mailbox,
    operationId: 'op-manual',
    leaseExpiresAt: new Date(clock - 1000)
  });
  const client = new RecordingGraph();
  const svc = serviceFor(client, {
    nowFn: () => new Date(clock),
    recoveryPolicy: {
      requiredAbsenceObservations: 2,
      minRecheckDelayMs: 1000,
      recoveryClaimMs: 60000,
      leaseBufferMs: 1000,
      manualHoldMs: 3600000
    }
  });

  const first = await svc.createSubscription({ mailbox });
  assert.strictEqual(first.absenceObservations, 1);
  clock += 1001;
  const second = await svc.createSubscription({ mailbox });
  assert.strictEqual(second.manualRecoveryRequired, true);
  assert.strictEqual(second.reason, 'manual_required');
  const gets = client.requests.filter((request) => request.method === 'GET').length;

  clock += 5000;
  const third = await svc.createSubscription({ mailbox });
  assert.strictEqual(third.manualRecoveryRequired, true);
  assert.strictEqual(third.created, false);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(client.requests.filter((request) => request.method === 'GET').length, gets);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-manual' }).lean();
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);
});

test('a configuration match with the wrong clientState is not adopted and is not logged', async () => {
  const mailbox = 'wrong-client-state@example.com';
  const clientState = 'correct-client-state-secret-value';
  await seedAmbiguous({ mailbox, operationId: 'op-wrong-state', clientState });
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-wrong-state', clientState: 'different-client-state-secret' })];
  const svc = serviceFor(client);
  const previous = process.env.SUPPORT_EMAIL_TELEMETRY_LOGS;
  process.env.SUPPORT_EMAIL_TELEMETRY_LOGS = '1';
  const lines = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));

  try {
    const result = await svc.createSubscription({ mailbox });
    assert.strictEqual(result.reason, 'insufficient_match');
    assert.strictEqual(result.manualRecoveryRequired, true);
    assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-wrong-state'));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.SUPPORT_EMAIL_TELEMETRY_LOGS;
    else process.env.SUPPORT_EMAIL_TELEMETRY_LOGS = previous;
  }

  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);
  const serialized = lines.join('\n');
  assert.equal(serialized.includes(clientState), false);
  assert.equal(serialized.includes('different-client-state-secret'), false);
  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-wrong-state' }).lean();
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.strictEqual(op.recoveryState, 'manual_required');
});

test('list clientState null is not a mismatch when the detail GET returns the stored secret', async () => {
  const mailbox = 'list-null-client-state@example.com';
  const clientState = 'detail-matching-client-state';
  await seedAmbiguous({ mailbox, operationId: 'op-list-null', clientState });
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-list-null', clientState })];
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  const listCall = client.requests.find((request) => request.url === '/subscriptions');
  assert.ok(listCall, 'Recovery must list subscriptions');
  assert.strictEqual(client.listItem(client.remote[0]).clientState, null);
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-list-null'));
  assert.strictEqual(result.adopted, true);
  assert.strictEqual(result.subscription.subscriptionId, 'sub-list-null');
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox, status: 'active' }), 1);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-list-null' }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
});

test('an unexpected clientState on the list is ignored when the detail GET matches', async () => {
  const mailbox = 'unexpected-list-client-state@example.com';
  const clientState = 'detail-only-client-state';
  await seedAmbiguous({ mailbox, operationId: 'op-unexpected-list', clientState });
  const client = new RecordingGraph();
  client.listClientStateOverride = 'list-value-that-must-not-be-verified';
  client.remote = [matchingRemote({ mailbox, id: 'sub-unexpected-list', clientState })];
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(client.listItem(client.remote[0]).clientState, 'list-value-that-must-not-be-verified');
  assert.strictEqual(result.adopted, true);
  assert.strictEqual(result.subscription.subscriptionId, 'sub-unexpected-list');
  assert.strictEqual(client.postCount(), 0);
});

test('a detail GET that omits clientState keeps the reservation for manual recovery', async () => {
  const mailbox = 'detail-omits-client-state@example.com';
  const clientState = 'omitted-on-detail';
  await seedAmbiguous({ mailbox, operationId: 'op-detail-omit', clientState });
  const listed = matchingRemote({ mailbox, id: 'sub-detail-omit', clientState });
  const client = new RecordingGraph();
  client.remote = [listed];
  const detail = { ...listed };
  delete detail.clientState;
  client.byId.set(listed.id, detail);
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.reason, 'client_state_unavailable');
  assert.strictEqual(result.manualRecoveryRequired, true);
  assert.strictEqual(result.adopted, false);
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-detail-omit'));
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-detail-omit' }).lean();
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
});

test('a failed candidate detail GET keeps the reservation for manual recovery', async () => {
  const mailbox = 'detail-fails@example.com';
  await seedAmbiguous({ mailbox, operationId: 'op-detail-fail', clientState: 'detail-fail-secret' });
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-detail-fail', clientState: 'detail-fail-secret' })];
  client.detailFailures.set('sub-detail-fail', { statusCode: 503, message: 'detail unavailable' });
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.reason, 'detail_lookup_failed');
  assert.strictEqual(result.manualRecoveryRequired, true);
  assert.strictEqual(result.adopted, false);
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-detail-fail'));
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 0);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-detail-fail' }).lean();
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
});

test('multiple configuration candidates are each loaded before one verified match is adopted', async () => {
  const mailbox = 'individual-candidates@example.com';
  const clientState = 'individual-candidate-secret';
  await seedAmbiguous({ mailbox, operationId: 'op-individual', clientState });
  const client = new RecordingGraph();
  client.remote = [
    matchingRemote({ mailbox, id: 'sub-individual-match', clientState }),
    matchingRemote({ mailbox, id: 'sub-individual-other', clientState: 'someone-else-secret' })
  ];
  const svc = serviceFor(client);

  const result = await svc.createSubscription({ mailbox });
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-individual-match'));
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-individual-other'));
  assert.strictEqual(result.adopted, true);
  assert.strictEqual(result.subscription.subscriptionId, 'sub-individual-match');
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 1);
  assert.strictEqual(await GraphSubscription.countDocuments({ subscriptionId: 'sub-individual-other' }), 0);
});

test('HTTP 409 starts discovery and keeps the reservation when the detail cannot be verified', async () => {
  const mailbox = 'conflict-discover@example.com';
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-conflict', clientState: 'conflict-secret' })];
  client.detailFailures.set('sub-conflict', { statusCode: 503, message: 'detail unavailable' });
  const original = client.request.bind(client);
  client.request = async (options) => {
    if (String(options.method || 'GET').toUpperCase() === 'POST') {
      client.requests.push({ url: options.url, method: 'POST' });
      const err = new Error('Conflict clientState=super-secret-value Subscription Id sub-conflict already exists');
      err.statusCode = 409;
      err.response = { status: 409, data: { error: { message: 'super-secret-value' } } };
      throw err;
    }
    return original(options);
  };
  const svc = serviceFor(client);
  const previous = process.env.SUPPORT_EMAIL_TELEMETRY_LOGS;
  process.env.SUPPORT_EMAIL_TELEMETRY_LOGS = '1';
  const lines = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));

  let result;
  try {
    result = await svc.createSubscription({ mailbox, clientState: 'conflict-secret' });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.SUPPORT_EMAIL_TELEMETRY_LOGS;
    else process.env.SUPPORT_EMAIL_TELEMETRY_LOGS = previous;
  }

  assert.strictEqual(result.adopted, false);
  assert.strictEqual(result.created, false);
  assert.strictEqual(result.reason, 'detail_lookup_failed');
  assert.strictEqual(client.postCount(), 1);
  assert.ok(client.requests.some((request) => request.method === 'GET' && request.url === '/subscriptions'));
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-conflict'));
  const serialized = lines.join('\n');
  assert.equal(serialized.includes('super-secret-value'), false);

  const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(op.failureClassification, 'ambiguous');
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.equal(JSON.stringify(op).includes('super-secret-value'), false);
  assert.notStrictEqual(op.state, 'completed');
});

test('HTTP 409 does not authorize another POST', async () => {
  const mailbox = 'conflict-no-repost@example.com';
  const client = new RecordingGraph();
  const original = client.request.bind(client);
  client.request = async (options) => {
    if (String(options.method || 'GET').toUpperCase() === 'POST') {
      client.requests.push({ url: options.url, method: 'POST' });
      const err = new Error('duplicate subscription');
      err.statusCode = 409;
      throw err;
    }
    return original(options);
  };
  const svc = serviceFor(client);

  const first = await svc.createSubscription({ mailbox, clientState: 'conflict-no-repost-secret' });
  assert.strictEqual(first.created, false);
  assert.strictEqual(client.postCount(), 1);
  const held = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.ok(held.reservationKey);
  assert.notStrictEqual(held.failureClassification, 'confirmed_rejection');

  const second = await svc.createSubscription({ mailbox, clientState: 'conflict-no-repost-secret' });
  assert.strictEqual(second.created, false);
  assert.notStrictEqual(second.adopted, true);
  assert.strictEqual(client.postCount(), 1);
  const stillHeld = await GraphSubscriptionOperation.findOne({ operationId: held.operationId }).lean();
  assert.strictEqual(stillHeld.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.notStrictEqual(stillHeld.state, 'completed');
});

test('a crash after the subscription upsert is finished by the next recovery without another POST', async () => {
  const mailbox = 'completion-crash@example.com';
  const clientState = 'completion-crash-secret';
  await seedAmbiguous({ mailbox, operationId: 'op-completion-crash', clientState });
  const stored = matchingRemote({ mailbox, id: 'sub-completion-crash', clientState });
  const client = new RecordingGraph();
  client.remote = [stored];
  const svc = serviceFor(client);
  const original = GraphSubscriptionOperation.findOneAndUpdate;
  GraphSubscriptionOperation.findOneAndUpdate = function findOneAndUpdate(filter, update, options) {
    if (update && update.$set && update.$set.state === 'completed') {
      return { lean: async () => { throw new Error('operation completion failed'); } };
    }
    return original.call(this, filter, update, options);
  };

  let failed;
  try {
    failed = await svc.createSubscription({ mailbox });
  } finally {
    GraphSubscriptionOperation.findOneAndUpdate = original;
  }

  assert.strictEqual(failed.reason, 'completion_failed');
  assert.strictEqual(failed.adopted, false);
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ subscriptionId: 'sub-completion-crash' }), 1);
  const midway = await GraphSubscriptionOperation.findOne({ operationId: 'op-completion-crash' }).lean();
  assert.notStrictEqual(midway.state, 'completed');
  assert.strictEqual(midway.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.strictEqual(midway.recoveryClaimedBy, null);

  client.byId.set(stored.id, stored);
  client.remote = [];
  const finished = await svc.createSubscription({ mailbox });
  assert.strictEqual(finished.adopted, true);
  assert.strictEqual(finished.subscription.subscriptionId, 'sub-completion-crash');
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);
  assert.strictEqual(await GraphSubscription.countDocuments({ mailbox }), 1);

  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-completion-crash' }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  assert.strictEqual(op.subscriptionId, 'sub-completion-crash');
});

async function adminRequest(token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${adminBaseUrl}/api/admin/support-email/subscriptions/recovery`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

test('an operator without super-admin access cannot recover manual_required', async () => {
  const mailbox = 'manual-unauthorized@example.com';
  const clientState = 'manual-unauthorized-secret';
  await seedAmbiguous({ mailbox, operationId: 'op-manual-unauthorized', clientState });
  await GraphSubscriptionOperation.updateOne(
    { operationId: 'op-manual-unauthorized' },
    { $set: { recoveryState: 'manual_required' } }
  );
  const client = new RecordingGraph();
  client.remote = [matchingRemote({ mailbox, id: 'sub-manual-unauthorized', clientState })];
  currentAdminService = serviceFor(client);
  const admin = await Admin.create({
    username: 'support-email-operator',
    password: 'secret12',
    name: 'Support Operator',
    isSuperAdmin: false,
    sectionAccess: ['leads']
  });
  const token = jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });

  const missing = await adminRequest(null, { operationId: 'op-manual-unauthorized' });
  assert.strictEqual(missing.status, 401);
  const forbidden = await adminRequest(token, { operationId: 'op-manual-unauthorized' });
  assert.strictEqual(forbidden.status, 403);

  const blocked = await currentAdminService.recoverAmbiguousOperation({
    operationId: 'op-manual-unauthorized',
    reservationKey: reservationKeyFor(mailbox, 'inbox')
  });
  assert.strictEqual(blocked.reason, 'manual_required');
  const health = await currentAdminService.syncSubscriptionHealth({ mailbox });
  assert.strictEqual(health.manualRecoveryRequired, true);
  assert.strictEqual(health.created, false);

  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.requests.filter((request) => request.method === 'GET').length, 0);
  assert.strictEqual(await SupportEmailAuditLog.countDocuments({ action: 'subscription_manual_recovery' }), 0);
  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-manual-unauthorized' }).lean();
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.notStrictEqual(op.state, 'completed');
});

test('an authorized operator can retry manual recovery only after detail verification', async () => {
  const mailbox = 'manual-authorized@example.com';
  const clientState = 'manual-authorized-secret';
  await seedAmbiguous({ mailbox, operationId: 'op-manual-authorized', clientState });
  await GraphSubscriptionOperation.updateOne(
    { operationId: 'op-manual-authorized' },
    { $set: { recoveryState: 'manual_required' } }
  );
  const listed = matchingRemote({ mailbox, id: 'sub-manual-authorized', clientState });
  const client = new RecordingGraph();
  client.remote = [listed];
  client.byId.set(listed.id, { ...listed, clientState: 'different-operator-secret' });
  const svc = serviceFor(client);
  currentAdminService = svc;
  const admin = await Admin.create({
    username: 'support-email-super',
    password: 'secret12',
    name: 'Support Super',
    isSuperAdmin: true,
    sectionAccess: []
  });
  const token = jwt.sign({ adminId: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' });

  const refused = await adminRequest(token, { operationId: 'op-manual-authorized' });
  assert.strictEqual(refused.status, 200);
  assert.strictEqual(refused.data.adopted, false);
  assert.strictEqual(refused.data.reason, 'insufficient_match');
  assert.strictEqual(client.postCount(), 0);
  assert.ok(client.requests.some((request) => request.url === '/subscriptions/sub-manual-authorized'));
  let op = await GraphSubscriptionOperation.findOne({ operationId: 'op-manual-authorized' }).lean();
  assert.strictEqual(op.recoveryState, 'manual_required');
  assert.strictEqual(op.reservationKey, reservationKeyFor(mailbox, 'inbox'));

  client.byId.set(listed.id, listed);
  const adopted = await adminRequest(token, { operationId: 'op-manual-authorized' });
  assert.strictEqual(adopted.status, 200);
  assert.strictEqual(adopted.data.adopted, true);
  assert.strictEqual(adopted.data.subscription.subscriptionId, 'sub-manual-authorized');
  assert.strictEqual(client.postCount(), 0);
  assert.strictEqual(client.deleteCount(), 0);

  op = await GraphSubscriptionOperation.findOne({ operationId: 'op-manual-authorized' }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  const audits = await SupportEmailAuditLog.find({ action: 'subscription_manual_recovery', targetId: 'op-manual-authorized' }).sort({ createdAt: 1 }).lean();
  assert.strictEqual(audits.length, 2);
  assert.strictEqual(String(audits[0].adminId), String(admin._id));
  assert.strictEqual(audits[0].metadata.outcome, 'insufficient_match');
  assert.strictEqual(audits[0].metadata.adopted, false);
  assert.strictEqual(String(audits[1].adminId), String(admin._id));
  assert.strictEqual(audits[1].metadata.outcome, 'adopted');
  assert.strictEqual(audits[1].metadata.adopted, true);
  assert.equal(JSON.stringify(audits).includes(clientState), false);
});
