'use strict';

/**
 * Phase 2B — Distributed creation reservation, ambiguous outcome and reconciliation safety tests.
 *
 * These tests exercise the real MongoDB (in-memory) unique partial index used for single-flight
 * reservation acquisition. They intentionally inject Graph timeouts, HTTP failures, MongoDB write
 * failures and concurrent workers instead of only testing happy paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');

const GraphSubscription = require('../models/GraphSubscription');
const GraphSubscriptionOperation = require('../models/GraphSubscriptionOperation');
const {
  SubscriptionService,
  HASH_SCHEMES,
  formatGraphResource,
  classifyGraphError,
  reservationKeyFor,
  calculateCreationLeaseMs,
  releaseCreationReservation,
  acquireCreationReservation
} = require('../services/supportEmail/subscriptionService');

const { GraphClient } = require('../services/supportEmail/graphClient');

const NOTIFICATION_URL = 'https://api.example.com/api/support-email/webhooks/graph';

class ControlledGraphClient {
  constructor({ postHandler = null, remoteSubscriptions = [] } = {}) {
    this.requests = [];
    this.postHandler = postHandler;
    this.remoteSubscriptions = remoteSubscriptions;
    this.timeoutMs = 15000;
    this.maxRetries = 3;
    this.maxBackoffMs = 30000;
    this.deleteCalls = new Set();
  }

  async request({ url, method = 'GET', data }) {
    const normalizedMethod = method.toUpperCase();
    this.requests.push({ url, method: normalizedMethod, data });

    if (normalizedMethod === 'POST' && url === '/subscriptions') {
      if (this.postHandler) return this.postHandler(data);
      return {
        id: `sub-created-${this.requests.length}`,
        resource: data.resource,
        expirationDateTime: data.expirationDateTime
      };
    }

    if (normalizedMethod === 'GET' && url === '/subscriptions') {
      return { value: this.remoteSubscriptions };
    }

    if (normalizedMethod === 'DELETE' && url.startsWith('/subscriptions/')) {
      const id = url.replace('/subscriptions/', '');
      if (this.deleteCalls.has(id)) {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
      }
      this.deleteCalls.add(id);
      return {};
    }

    if (normalizedMethod === 'PATCH' && url.startsWith('/subscriptions/')) {
      return {
        id: url.replace('/subscriptions/', ''),
        expirationDateTime: data.expirationDateTime
      };
    }

    throw new Error(`Unhandled Graph request: ${normalizedMethod} ${url}`);
  }
}

function remoteSubscription({ id, mailbox, folder = 'inbox', expiresInMs = 4000 * 60 * 1000 }) {
  return {
    id,
    resource: formatGraphResource(mailbox, folder),
    notificationUrl: NOTIFICATION_URL,
    expirationDateTime: new Date(Date.now() + expiresInMs).toISOString()
  };
}

async function createReservationOperation({
  mailbox,
  folder = 'inbox',
  operationId,
  state = 'pending',
  failureClassification = null,
  subscriptionId = null,
  leaseExpiresAt = new Date(Date.now() + 120 * 1000),
  withReservationKey = true
}) {
  return GraphSubscriptionOperation.create({
    operationId,
    mailbox,
    folder,
    resource: formatGraphResource(mailbox, folder),
    notificationUrl: NOTIFICATION_URL,
    state,
    failureClassification,
    subscriptionId,
    leaseExpiresAt,
    reservationKey: withReservationKey ? reservationKeyFor(mailbox, folder) : null,
    requestedExpirationMinutes: 4200
  });
}

function createService(client) {
  return new SubscriptionService({ graphClient: client, notificationUrl: NOTIFICATION_URL });
}

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test.before(async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'reservation-suite-hmac-secret-32-bytes';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  delete process.env.NODE_ENV;
  await setupTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'reservation-suite-hmac-secret-32-bytes';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS;
  delete process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID;
  delete process.env.NODE_ENV;
});

test.after(async () => {
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  await teardownTestDb();
});

// ---------------------------------------------------------------------------
// 1-5. Active reservation blocking semantics
// ---------------------------------------------------------------------------

test('R1. active pending reservation blocks normal creation', async () => {
  const mailbox = 'r1@example.com';
  await createReservationOperation({ mailbox, operationId: 'op-r1' });

  const client = new ControlledGraphClient();
  const svc = createService(client);
  const result = await svc.createSubscription({ mailbox });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.inFlight, true);
  assert.strictEqual(result.operationId, 'op-r1');
  assert.strictEqual(client.requests.length, 0, 'No Graph POST while reservation is active');
});

test('R2. active pending reservation blocks forced creation', async () => {
  const mailbox = 'r2@example.com';
  await createReservationOperation({ mailbox, operationId: 'op-r2' });

  const client = new ControlledGraphClient();
  const svc = createService(client);
  const result = await svc.createSubscription({ mailbox, force: true });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.inFlight, true);
  assert.strictEqual(client.requests.length, 0, 'force:true must not bypass an active reservation');
});

test('R3. active ambiguous failure blocks normal creation', async () => {
  const mailbox = 'r3@example.com';
  await createReservationOperation({
    mailbox,
    operationId: 'op-r3',
    state: 'failed',
    failureClassification: 'ambiguous',
    leaseExpiresAt: new Date(Date.now() + 90 * 1000)
  });

  const client = new ControlledGraphClient();
  const svc = createService(client);
  const result = await svc.createSubscription({ mailbox });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.inFlight, true);
  assert.strictEqual(client.requests.length, 0);
});

test('R4. active ambiguous failure blocks forced creation', async () => {
  const mailbox = 'r4@example.com';
  await createReservationOperation({
    mailbox,
    operationId: 'op-r4',
    state: 'failed',
    failureClassification: 'ambiguous',
    leaseExpiresAt: new Date(Date.now() + 90 * 1000)
  });

  const client = new ControlledGraphClient();
  const svc = createService(client);
  const result = await svc.createSubscription({ mailbox, force: true });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.inFlight, true);
  assert.strictEqual(client.requests.length, 0);
});

test('R5. confirmed rejection does not block retry and releases its reservation', async () => {
  const mailbox = 'r5@example.com';

  const failingClient = new ControlledGraphClient({
    postHandler: () => {
      const err = new Error('Bad request');
      err.statusCode = 400;
      throw err;
    }
  });
  const svc = createService(failingClient);

  await assert.rejects(() => svc.createSubscription({ mailbox }), (err) => err.statusCode === 400);

  const rejectedOp = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(rejectedOp.state, 'failed');
  assert.strictEqual(rejectedOp.failureClassification, 'confirmed_rejection');
  assert.strictEqual(rejectedOp.reservationKey, null, 'Confirmed rejection must release the reservation');
  assert.ok(new Date(rejectedOp.leaseExpiresAt).getTime() < Date.now());

  const retryClient = new ControlledGraphClient();
  const retrySvc = createService(retryClient);
  const retry = await retrySvc.createSubscription({ mailbox });

  assert.strictEqual(retry.created, true);
  assert.strictEqual(retryClient.requests.filter((r) => r.method === 'POST').length, 1);
});

// ---------------------------------------------------------------------------
// 6-7. Expired reservations and concurrent acquisition
// ---------------------------------------------------------------------------

test('R6. expired ambiguous operation enters recovery and does not POST again', async () => {
  const mailbox = 'r6@example.com';
  await createReservationOperation({
    mailbox,
    operationId: 'op-r6-expired',
    state: 'failed',
    failureClassification: 'ambiguous',
    leaseExpiresAt: new Date(Date.now() - 60 * 1000)
  });

  const client = new ControlledGraphClient();
  const svc = createService(client);
  const result = await svc.createSubscription({ mailbox });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.inFlight, true);
  assert.strictEqual(client.requests.filter((r) => r.method === 'POST').length, 0);
  assert.ok(client.requests.some((r) => r.method === 'GET'), 'Recovery must inspect Graph before any new POST');

  const expiredOp = await GraphSubscriptionOperation.findOne({ operationId: 'op-r6-expired' }).lean();
  assert.notStrictEqual(expiredOp.state, 'abandoned');
  assert.strictEqual(expiredOp.state, 'failed');
  assert.strictEqual(expiredOp.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.strictEqual(expiredOp.failureClassification, 'ambiguous');
  assert.ok(expiredOp.absenceObservations >= 1);
});

test('R7. two concurrent workers cannot both acquire the creation reservation', async () => {
  const mailbox = 'r7@example.com';

  let resolvePost;
  const postPromise = new Promise((resolve) => {
    resolvePost = resolve;
  });

  const client = new ControlledGraphClient({
    postHandler: () => postPromise
  });
  const svc = createService(client);

  // Worker 1 acquires the reservation and is held inside the Graph POST.
  const worker1 = svc.createSubscription({ mailbox });
  await waitFor(() => client.requests.some((r) => r.method === 'POST'));

  // Worker 2 starts while worker 1 is still in flight.
  const worker2 = svc.createSubscription({ mailbox });
  const result2 = await worker2;

  assert.strictEqual(result2.created, false);
  assert.strictEqual(result2.inFlight, true);

  resolvePost({
    id: 'sub-r7-single',
    expirationDateTime: new Date(Date.now() + 4200 * 60 * 1000).toISOString()
  });
  const result1 = await worker1;

  assert.strictEqual(result1.created, true);
  assert.strictEqual(client.requests.filter((r) => r.method === 'POST').length, 1, 'Exactly one Graph POST');

  const activeSubs = await GraphSubscription.countDocuments({ mailbox, status: 'active' });
  assert.strictEqual(activeSubs, 1);
});

test('R7b. simultaneously started workers still produce at most one Graph POST', async () => {
  const mailbox = 'r7b@example.com';
  const client = new ControlledGraphClient();
  const svc = createService(client);

  const results = await Promise.all([
    svc.createSubscription({ mailbox }),
    svc.createSubscription({ mailbox })
  ]);

  const posted = client.requests.filter((r) => r.method === 'POST').length;
  assert.ok(posted <= 1, `At most one Graph POST may occur, got ${posted}`);
  assert.strictEqual(results.filter((r) => r.created === true).length, 1);
});

test('R7c. a worker cannot release another worker reservation', async () => {
  const mailbox = 'r7c@example.com';
  await createReservationOperation({ mailbox, operationId: 'op-r7c' });

  const released = await releaseCreationReservation({
    operationId: 'op-r7c',
    reservationKey: 'wrong-owner-key',
    updates: { state: 'completed' }
  });
  assert.strictEqual(released, null, 'Wrong owner key must not release the reservation');

  const stillHeld = await GraphSubscriptionOperation.findOne({ operationId: 'op-r7c' }).lean();
  assert.strictEqual(stillHeld.reservationKey, reservationKeyFor(mailbox, 'inbox'));
  assert.strictEqual(stillHeld.state, 'pending');
});

test('R7d. lease duration exceeds the complete Graph retry window', () => {
  const leaseMs = calculateCreationLeaseMs({ timeoutMs: 15000, maxRetries: 3, maxBackoffMs: 30000 });
  const worstCaseRequestWindowMs = 15000 * 4 + 30000 * 3;
  assert.ok(
    leaseMs > worstCaseRequestWindowMs,
    `Lease ${leaseMs}ms must exceed request+retry window ${worstCaseRequestWindowMs}ms`
  );
  assert.ok(leaseMs >= 2 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// 8-11. Ambiguous Graph outcomes and persistence failures
// ---------------------------------------------------------------------------

test('R8. Graph creates remotely but the response times out: reservation protects the remote subscription', async () => {
  const mailbox = 'r8@example.com';
  let remoteId = null;

  const client = new ControlledGraphClient({
    postHandler: (data) => {
      // Simulate Graph processing the POST and then the socket timing out.
      remoteId = 'sub-r8-created-but-timeout';
      client.remoteSubscriptions = [
        {
          id: remoteId,
          resource: data.resource,
          notificationUrl: NOTIFICATION_URL,
          expirationDateTime: new Date(Date.now() + 4100 * 60 * 1000).toISOString()
        }
      ];
      const err = new Error('timeout of 15000ms exceeded');
      err.code = 'ETIMEDOUT';
      throw err;
    }
  });
  const svc = createService(client);

  await assert.rejects(() => svc.createSubscription({ mailbox }), (err) => err.code === 'ETIMEDOUT');

  const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(op.state, 'failed');
  assert.strictEqual(op.failureClassification, 'ambiguous');
  assert.ok(op.reservationKey, 'Ambiguous failure must retain the reservation');
  assert.ok(new Date(op.leaseExpiresAt).getTime() > Date.now(), 'Lease must remain active');

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true });
  assert.strictEqual(recon.deletedRemoteCount, 0);
  assert.strictEqual(recon.inFlightRemoteCount, 1);
  assert.strictEqual(client.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('R9. immediate retry after a timeout does not create a duplicate subscription', async () => {
  const mailbox = 'r9@example.com';
  let postCount = 0;

  const client = new ControlledGraphClient({
    postHandler: (data) => {
      postCount++;
      client.remoteSubscriptions = [
        {
          id: 'sub-r9-timeout',
          resource: data.resource,
          notificationUrl: NOTIFICATION_URL,
          expirationDateTime: new Date(Date.now() + 4100 * 60 * 1000).toISOString()
        }
      ];
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    }
  });
  const svc = createService(client);

  await assert.rejects(() => svc.createSubscription({ mailbox }));
  const retry = await svc.createSubscription({ mailbox, force: true });

  assert.strictEqual(retry.created, false);
  assert.strictEqual(retry.inFlight, true);
  assert.strictEqual(postCount, 1, 'Retry must not issue a second Graph POST');
});

test('R10. MongoDB failure after Graph created the subscription preserves an ambiguous protection lease', async () => {
  const mailbox = 'r10@example.com';
  const client = new ControlledGraphClient({
    postHandler: (data) => ({
      id: 'sub-r10-created',
      resource: data.resource,
      expirationDateTime: new Date(Date.now() + 4200 * 60 * 1000).toISOString()
    })
  });
  const svc = createService(client);

  const originalFindOneAndUpdate = GraphSubscription.findOneAndUpdate;
  GraphSubscription.findOneAndUpdate = () => {
    const err = new Error('MongoDB write failed');
    return { lean: async () => { throw err; } };
  };

  try {
    await assert.rejects(
      () => svc.createSubscription({ mailbox }),
      /MongoDB write failed/
    );
  } finally {
    GraphSubscription.findOneAndUpdate = originalFindOneAndUpdate;
  }

  const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
  assert.strictEqual(op.state, 'failed');
  assert.strictEqual(op.failureClassification, 'ambiguous');
  assert.strictEqual(op.subscriptionId, 'sub-r10-created');
  assert.ok(op.reservationKey, 'Reservation must be retained after DB failure');
  assert.ok(new Date(op.leaseExpiresAt).getTime() > Date.now());

  // A remote subscription matching the recorded id must not be treated as an orphan yet.
  client.remoteSubscriptions = [
    {
      id: 'sub-r10-created',
      resource: formatGraphResource(mailbox, 'inbox'),
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: new Date(Date.now() + 4100 * 60 * 1000).toISOString()
    }
  ];
  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true });
  assert.strictEqual(recon.deletedRemoteCount, 0);
});

test('R11. worker crash after Graph response but before persistence leaves an in-flight operation protected', async () => {
  const mailbox = 'r11@example.com';
  const subscriptionId = 'sub-r11-crashed-after-response';

  await createReservationOperation({
    mailbox,
    operationId: 'op-r11',
    state: 'pending',
    subscriptionId,
    leaseExpiresAt: new Date(Date.now() + 90 * 1000)
  });

  const client = new ControlledGraphClient({
    remoteSubscriptions: [remoteSubscription({ id: subscriptionId, mailbox })]
  });
  const svc = createService(client);

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true });
  assert.strictEqual(recon.inFlightRemoteCount, 1);
  assert.strictEqual(recon.deletedRemoteCount, 0);
  assert.strictEqual(client.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('R12. worker crash before receiving the Graph response still protects the unknown remote subscription', async () => {
  const mailbox = 'r12@example.com';

  await createReservationOperation({
    mailbox,
    operationId: 'op-r12',
    state: 'pending',
    subscriptionId: null,
    leaseExpiresAt: new Date(Date.now() + 90 * 1000)
  });

  const client = new ControlledGraphClient({
    remoteSubscriptions: [remoteSubscription({ id: 'sub-r12-unknown', mailbox, expiresInMs: 60 * 60 * 1000 })]
  });
  const svc = createService(client);

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true });
  assert.strictEqual(recon.inFlightRemoteCount, 1);
  assert.strictEqual(recon.deletedRemoteCount, 0);
});

test('R13. a lease expiring during a delayed operation permits exactly one safe recovery', async () => {
  const mailbox = 'r13@example.com';

  await createReservationOperation({
    mailbox,
    operationId: 'op-r13-expired',
    state: 'pending',
    leaseExpiresAt: new Date(Date.now() - 1000)
  });

  const client = new ControlledGraphClient();
  const svc = createService(client);

  const results = await Promise.all([
    svc.createSubscription({ mailbox }),
    svc.createSubscription({ mailbox })
  ]);

  const created = results.filter((r) => r.created === true);
  assert.strictEqual(created.length, 1, 'Exactly one worker recovers the expired lease');
  assert.strictEqual(client.requests.filter((r) => r.method === 'POST').length, 1);

  const recovered = await GraphSubscriptionOperation.findOne({ operationId: 'op-r13-expired' }).lean();
  assert.strictEqual(recovered.state, 'abandoned');
});

// ---------------------------------------------------------------------------
// 14-17. Reconciliation concurrency and destructive-cleanup guards
// ---------------------------------------------------------------------------

test('R14. two reconciliation jobs processing the same orphan do not crash or double-delete destructively', async () => {
  const mailbox = 'r14@example.com';
  const client = new ControlledGraphClient({
    remoteSubscriptions: [remoteSubscription({ id: 'sub-r14-orphan', mailbox })]
  });
  const svc = createService(client);

  const [first, second] = await Promise.all([
    svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true }),
    svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true })
  ]);

  assert.strictEqual(client.deleteCalls.size, 1, 'Only one remote deletion may actually execute');
  assert.ok(first && second, 'Both reconciliation passes must complete without throwing');
  assert.ok(
    first.deletedRemoteCount <= 1 && second.deletedRemoteCount <= 1,
    'Each pass may report at most one orphan deletion'
  );
});

test('R15. a valid matched remote subscription is never deleted', async () => {
  const mailbox = 'r15@example.com';
  const subscriptionId = 'sub-r15-valid';

  await GraphSubscription.create({
    subscriptionId,
    mailbox,
    folder: 'inbox',
    resource: formatGraphResource(mailbox, 'inbox'),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash',
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: NOTIFICATION_URL,
    lastRenewedAt: new Date()
  });

  const client = new ControlledGraphClient({
    remoteSubscriptions: [remoteSubscription({ id: subscriptionId, mailbox })]
  });
  const svc = createService(client);

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true });
  assert.strictEqual(recon.matchedCount, 1);
  assert.strictEqual(recon.remoteOrphansCount, 0);
  assert.strictEqual(recon.deletedRemoteCount, 0);
  assert.strictEqual(client.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('R16. a genuine orphan is eventually cleaned up after safety checks', async () => {
  const mailbox = 'r16@example.com';
  const client = new ControlledGraphClient({
    remoteSubscriptions: [remoteSubscription({ id: 'sub-r16-genuine-orphan', mailbox })]
  });
  const svc = createService(client);

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true });
  assert.strictEqual(recon.remoteOrphansCount, 1);
  assert.strictEqual(recon.deletedRemoteCount, 1);
  assert.strictEqual(client.deleteCalls.size, 1);
});

test('R17. incomplete remote enumeration forbids destructive orphan cleanup', async () => {
  const mailbox = 'r17@example.com';

  const client = {
    requests: [],
    timeoutMs: 15000,
    maxRetries: 3,
    maxBackoffMs: 30000,
    async request({ url, method = 'GET' }) {
      this.requests.push({ url, method });
      if (method === 'GET' && url === '/subscriptions') {
        return {
          value: [remoteSubscription({ id: 'sub-r17-orphan', mailbox })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=more'
        };
      }
      if (method === 'GET') {
        // Every subsequent page still claims there is more data: enumeration is truncated by maxPages.
        return {
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=more'
        };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    }
  };

  const svc = createService(client);
  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, deleteOrphans: true, maxPages: 3 });

  assert.strictEqual(recon.completedEnumeration, false);
  assert.strictEqual(recon.cleanupSkippedIncompleteEnumeration, true);
  assert.strictEqual(recon.deletedRemoteCount, 0);
  assert.strictEqual(client.requests.filter((r) => r.method === 'DELETE').length, 0);
});

// ---------------------------------------------------------------------------
// 18-20. Error classification and reservation edge cases
// ---------------------------------------------------------------------------

test('R18. error classification treats timeouts, 408, 409, 429 and 5xx as ambiguous and other 4xx as confirmed', () => {
  const cases = [
    [{ statusCode: 400 }, 'confirmed_rejection'],
    [{ statusCode: 401 }, 'confirmed_rejection'],
    [{ statusCode: 401, ambiguousOutcome: true }, 'ambiguous'],
    [{ statusCode: 403 }, 'confirmed_rejection'],
    [{ statusCode: 404 }, 'confirmed_rejection'],
    [{ statusCode: 408 }, 'ambiguous'],
    [{ statusCode: 409 }, 'ambiguous'],
    [{ statusCode: 422 }, 'confirmed_rejection'],
    [{ statusCode: 429 }, 'ambiguous'],
    [{ statusCode: 500 }, 'ambiguous'],
    [{ statusCode: 503 }, 'ambiguous'],
    [{ code: 'ETIMEDOUT' }, 'ambiguous'],
    [{ code: 'ECONNRESET' }, 'ambiguous'],
    [{ code: 'ECONNABORTED' }, 'ambiguous'],
    [{ code: 'ERR_SOCKET_CONNECTION_TIMEOUT' }, 'ambiguous'],
    [{}, 'ambiguous'],
    [null, 'ambiguous']
  ];

  for (const [input, expected] of cases) {
    assert.strictEqual(classifyGraphError(input), expected, `Classify ${JSON.stringify(input)}`);
  }
});

test('R19. successful creation marks the operation completed and releases its reservation', async () => {
  const mailbox = 'r19@example.com';
  const client = new ControlledGraphClient();
  const svc = createService(client);

  const result = await svc.createSubscription({ mailbox });
  assert.strictEqual(result.created, true);

  const op = await GraphSubscriptionOperation.findOne({ operationId: result.operationId }).lean();
  assert.strictEqual(op.state, 'completed');
  assert.strictEqual(op.reservationKey, null);
  assert.ok(op.completedAt);
  assert.ok(op.subscriptionId);
  assert.strictEqual(op.subscriptionId, result.subscription.subscriptionId);
});

test('R20. legacy operation without reservationKey but with an active lease still blocks creation', async () => {
  const mailbox = 'r20@example.com';
  await createReservationOperation({
    mailbox,
    operationId: 'op-r20-legacy',
    state: 'failed',
    failureClassification: 'ambiguous',
    leaseExpiresAt: new Date(Date.now() + 60 * 1000),
    withReservationKey: false
  });

  const client = new ControlledGraphClient();
  const svc = createService(client);
  const result = await svc.createSubscription({ mailbox, force: true });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.inFlight, true);
  assert.strictEqual(client.requests.length, 0);
});

test('R21. acquireCreationReservation rejects a second holder and preserves the first operation record', async () => {
  const mailbox = 'r21@example.com';
  const initialLeaseExpiresAt = new Date(Date.now() + 60 * 1000);
  const params = {
    mailbox,
    folder: 'inbox',
    resource: formatGraphResource(mailbox, 'inbox'),
    notificationUrl: NOTIFICATION_URL,
    clientStateHash: 'hash',
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'primary',
    requestedExpirationMinutes: 4200,
    initialLeaseExpiresAt
  };

  const first = await acquireCreationReservation(params);
  const second = await acquireCreationReservation(params);

  assert.strictEqual(first.acquired, true);
  assert.strictEqual(second.acquired, false);
  assert.strictEqual(second.operationId, first.operationId);

  const count = await GraphSubscriptionOperation.countDocuments({ mailbox });
  assert.strictEqual(count, 1, 'No second operation document may be inserted');
});

test('R22. webhook lifecycle reauthorization renews instead of creating a duplicate', async () => {
  const mailbox = 'r22@example.com';
  const subscriptionId = 'sub-r22';

  await GraphSubscription.create({
    subscriptionId,
    mailbox,
    folder: 'inbox',
    resource: formatGraphResource(mailbox, 'inbox'),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash',
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: NOTIFICATION_URL,
    lastError: 'Reauthorization required by Microsoft 365 tenant'
  });

  const client = new ControlledGraphClient();
  const svc = createService(client);

  const health = await svc.syncSubscriptionHealth({ mailbox, safetyMarginHours: 24 });
  assert.strictEqual(health.renewed, true);
  assert.strictEqual(client.requests.filter((r) => r.method === 'POST').length, 0, 'No new subscription');
  assert.strictEqual(client.requests.filter((r) => r.method === 'PATCH').length, 1);

  const updated = await GraphSubscription.findOne({ subscriptionId }).lean();
  assert.strictEqual(updated.lastError, null);
});
