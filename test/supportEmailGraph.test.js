'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupTestDb,
  clearTestDb,
  teardownTestDb
} = require('./supportEmail/harness');

const SupportEmail = require('../models/SupportEmail');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');

const { GraphAuthService } = require('../services/supportEmail/graphAuthService');
const {
  GraphClient,
  GraphClientError,
  GraphForbiddenError,
  GraphNotFoundError,
  GraphDeltaTokenExpiredError,
  GraphThrottledError
} = require('../services/supportEmail/graphClient');
const { normalizeGraphMessage } = require('../services/supportEmail/messageNormalizationService');
const { ingestEmailMessage, ingestMessageBatch } = require('../services/supportEmail/emailIngestionService');
const {
  buildInitialDeltaUrl,
  paginateDeltaQuery,
  executeSyncPass,
  createSyncPassFn
} = require('../services/supportEmail/deltaSyncService');
const {
  runCoalescedSync,
  signalMailboxSync,
  acquireSyncLock
} = require('../services/supportEmail/mailboxSyncService');

test.before(async () => {
  await setupTestDb();
});

test.after(async () => {
  await teardownTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
});

// Helper to mock Graph message JSON
function createMockGraphMessage({
  id = 'msg-1',
  internetMessageId = null,
  subject = 'Test Subject',
  receivedDateTime = '2026-11-13T10:00:00.000Z',
  body = 'Hello Support Team',
  hasAttachments = false
} = {}) {
  const normInternetMsgId = internetMessageId || `<${id}@test.com>`;
  return {
    id,
    internetMessageId: normInternetMsgId,
    conversationId: 'conv-123',
    receivedDateTime,
    sentDateTime: receivedDateTime,
    from: {
      emailAddress: { name: 'John Doe', address: 'john.doe@example.com' }
    },
    toRecipients: [
      { emailAddress: { name: 'Support', address: 'support@guidexpert.com' } }
    ],
    subject,
    bodyPreview: body.slice(0, 100),
    body: {
      contentType: 'text',
      content: body
    },
    hasAttachments,
    importance: 'normal',
    isRead: false,
    isDraft: false
  };
}

// 1. Successful token acquisition
test('GraphAuthService: successful token acquisition with client credentials', async () => {
  let requestPayload = null;
  const mockRequester = async (url, data, config) => {
    requestPayload = data;
    return {
      status: 200,
      data: {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'mock-access-token-123'
      }
    };
  };

  const auth = new GraphAuthService({
    tenantId: 'test-tenant',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    httpRequester: mockRequester
  });

  const token = await auth.getAccessToken();
  assert.equal(token, 'mock-access-token-123');
  assert.match(requestPayload, /client_id=test-client/);
  assert.match(requestPayload, /grant_type=client_credentials/);
});

// 2. Token caching
test('GraphAuthService: token caching avoids redundant network requests', async () => {
  let callCount = 0;
  const mockRequester = async () => {
    callCount++;
    return {
      status: 200,
      data: {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: `token-call-${callCount}`
      }
    };
  };

  const auth = new GraphAuthService({
    tenantId: 't',
    clientId: 'c',
    clientSecret: 's',
    httpRequester: mockRequester
  });

  const t1 = await auth.getAccessToken();
  const t2 = await auth.getAccessToken();
  const t3 = await auth.getAccessToken();

  assert.equal(callCount, 1, 'Only one network call should occur within token lifetime');
  assert.equal(t1, t2);
  assert.equal(t2, t3);
});

// 3. Token refresh after expiration
test('GraphAuthService: token refresh after expiration or buffer window', async () => {
  let callCount = 0;
  const mockRequester = async () => {
    callCount++;
    return {
      status: 200,
      data: {
        token_type: 'Bearer',
        expires_in: 10, // 10 seconds
        access_token: `token-${callCount}`
      }
    };
  };

  const auth = new GraphAuthService({
    tenantId: 't',
    clientId: 'c',
    clientSecret: 's',
    refreshBufferSeconds: 5,
    httpRequester: mockRequester
  });

  const t1 = await auth.getAccessToken();
  assert.equal(t1, 'token-1');

  // Fast forward token expiration by manually setting tokenExpiresAt in past
  auth.tokenExpiresAt = Date.now() - 1000;

  const t2 = await auth.getAccessToken();
  assert.equal(callCount, 2);
  assert.equal(t2, 'token-2');
});

// 4. 401 handling
test('GraphClient: 401 unauthorized evicts token and retries request once', async () => {
  let authClearCalled = false;
  let clientAttempts = 0;

  const mockAuthService = {
    getAccessToken: async () => 'test-bearer-token',
    clearCachedToken: () => {
      authClearCalled = true;
    }
  };

  const mockRequester = async () => {
    clientAttempts++;
    if (clientAttempts === 1) {
      const err = new Error('Unauthorized');
      err.response = { status: 401, data: { error: { code: 'InvalidAuthenticationToken', message: 'Token expired' } } };
      throw err;
    }
    return { status: 200, data: { value: [{ id: 'msg-recovered' }] } };
  };

  const client = new GraphClient({
    authService: mockAuthService,
    httpRequester: mockRequester
  });

  const res = await client.get('/messages');
  assert.equal(clientAttempts, 2);
  assert.equal(authClearCalled, true);
  assert.equal(res.value[0].id, 'msg-recovered');
});

// 5. 403 authorization handling
test('GraphClient: 403 forbidden is non-retryable terminal authorization error', async () => {
  let attempts = 0;
  const mockRequester = async () => {
    attempts++;
    const err = new Error('Forbidden');
    err.response = { status: 403, data: { error: { code: 'ErrorAccessDenied', message: 'Mailbox access not granted' } } };
    throw err;
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  await assert.rejects(
    async () => {
      await client.get('/users/admin/messages');
    },
    GraphForbiddenError
  );

  assert.equal(attempts, 1, '403 must not perform endless retries');
});

// 6. 429 Retry-After handling
test('GraphClient: 429 rate limit throttling respects Retry-After header and retries', async () => {
  let attempts = 0;
  let sleptMs = [];

  const mockRequester = async () => {
    attempts++;
    if (attempts === 1) {
      const err = new Error('Throttled');
      err.response = {
        status: 429,
        headers: { 'retry-after': '2' },
        data: { error: { code: 'ApplicationThrottled', message: 'Too many requests' } }
      };
      throw err;
    }
    return { status: 200, data: { ok: true } };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester,
    sleepFn: async (ms) => {
      sleptMs.push(ms);
    }
  });

  const res = await client.get('/messages');
  assert.equal(res.ok, true);
  assert.equal(attempts, 2);
  assert.equal(sleptMs.length, 1);
  assert.equal(sleptMs[0], 2000, 'Must respect 2 seconds from Retry-After header');
});

// 7. 500 and 503 retry handling
test('GraphClient: transient 500 and 503 responses trigger exponential backoff retry', async () => {
  let attempts = 0;
  const mockRequester = async () => {
    attempts++;
    if (attempts === 1) {
      const err = new Error('Internal Server Error');
      err.response = { status: 500, data: { error: { code: 'InternalServerError', message: 'Transient fail' } } };
      throw err;
    }
    if (attempts === 2) {
      const err = new Error('Service Unavailable');
      err.response = { status: 503, data: { error: { code: 'ServiceUnavailable', message: 'Busy' } } };
      throw err;
    }
    return { status: 200, data: { success: true } };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester,
    baseBackoffMs: 1,
    sleepFn: async () => {}
  });

  const res = await client.get('/me/messages');
  assert.equal(res.success, true);
  assert.equal(attempts, 3);
});

// 8. Request timeout
test('GraphClient: request timeout triggers retry and eventually surfaces client error', async () => {
  let attempts = 0;
  const mockRequester = async () => {
    attempts++;
    const err = new Error('timeout of 15000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester,
    maxRetries: 2,
    baseBackoffMs: 1,
    sleepFn: async () => {}
  });

  await assert.rejects(
    async () => {
      await client.get('/messages');
    },
    GraphClientError
  );

  assert.equal(attempts, 3); // initial attempt + 2 retries
});

// 9. Delta pagination across multiple pages
test('deltaSyncService: delta pagination follows @odata.nextLink across multiple pages and ingests', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const page1 = {
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?$skiptoken=page2',
    value: [
      createMockGraphMessage({ id: 'page1-msg-1', internetMessageId: '<p1@test.com>' }),
      createMockGraphMessage({ id: 'page1-msg-2', internetMessageId: '<p2@test.com>' })
    ]
  };

  const page2 = {
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=final_sync_1',
    value: [
      createMockGraphMessage({ id: 'page2-msg-3', internetMessageId: '<p3@test.com>' })
    ]
  };

  const mockRequester = async (config) => {
    if (config.url.includes('$skiptoken=page2')) {
      return { status: 200, data: page2 };
    }
    return { status: 200, data: page1 };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await paginateDeltaQuery({
    graphClient: client,
    initialUrl: 'https://graph.microsoft.com/v1.0/messages/delta',
    mailbox,
    folder
  });

  assert.equal(result.pages, 2);
  assert.equal(result.count, 3);
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=final_sync_1');

  // Verify all 3 messages are in MongoDB
  const dbCount = await SupportEmail.countDocuments();
  assert.equal(dbCount, 3);
});

// 10. Final deltaLink persistence via mailboxSyncService
test('deltaSyncService: final deltaLink is persisted safely in EmailSyncCursor on pass conclusion', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });

  const mockRequester = async () => {
    return {
      status: 200,
      data: {
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=persistent_delta_99',
        value: [createMockGraphMessage({ id: 'persist-msg-1' })]
      }
    };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const syncPassFn = createSyncPassFn({
    graphClient: client,
    mailbox,
    folder
  });

  const runResult = await runCoalescedSync({
    mailbox,
    folder,
    syncPassFn
  });

  assert.equal(runResult.executed, true);
  assert.equal(runResult.deltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=persistent_delta_99');

  const cursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(cursor.deltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=persistent_delta_99');
  assert.equal(cursor.syncStatus, 'idle');
  assert.ok(cursor.lastSuccessfulSyncAt);
});

// 11. Duplicate message ingestion
test('emailIngestionService: duplicate message ingestion is handled safely without failing sync', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const msg = createMockGraphMessage({ id: 'dupe-msg-1', internetMessageId: '<dupe1@test.com>' });

  // Ingest first time
  const outcome1 = await ingestEmailMessage({ graphMessage: msg, mailbox, folder });
  assert.equal(outcome1.isDuplicate, false);
  assert.equal(outcome1.ingested, true);

  // Ingest exact duplicate second time
  const outcome2 = await ingestEmailMessage({ graphMessage: msg, mailbox, folder });
  assert.equal(outcome2.isDuplicate, true);
  assert.equal(outcome2.ingested, true);
  assert.equal(outcome2.email.graphMessageId, 'dupe-msg-1');

  // Verify exactly 1 record in database
  const count = await SupportEmail.countDocuments({ graphMessageId: 'dupe-msg-1' });
  assert.equal(count, 1);
});

// 12. Partial page ingestion failure
test('deltaSyncService: partial page failure aborts synchronization without advancing deltaLink', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const cursor = await EmailSyncCursor.create({
    mailbox,
    folder,
    deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=checkpoint_original',
    lastSuccessfulSyncAt: new Date('2026-11-13T09:00:00.000Z')
  });

  // Mock Graph returning page 1 successfully, but throwing on page 2
  let pageReq = 0;
  const mockRequester = async (config) => {
    pageReq++;
    if (pageReq === 1) {
      return {
        status: 200,
        data: {
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?$skiptoken=corrupt_page2',
          value: [createMockGraphMessage({ id: 'partial-msg-1' })]
        }
      };
    }
    const err = new Error('Graph server crashed mid-stream');
    err.response = { status: 500, data: { error: { code: 'InternalServerError' } } };
    throw err;
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester,
    maxRetries: 0
  });

  await assert.rejects(
    async () => {
      await executeSyncPass({
        cursor,
        mailbox,
        folder,
        graphClient: client
      });
    },
    GraphClientError
  );

  // Verify cursor deltaLink in MongoDB was NOT advanced to corrupted token
  const dbCursor = await EmailSyncCursor.findById(cursor._id).lean();
  assert.equal(dbCursor.deltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=checkpoint_original');
});

// 13. Crash before cursor advancement
test('deltaSyncService: crash before cursor advancement leaves deltaLink checkpoint intact for replay', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });
  await EmailSyncCursor.findOneAndUpdate(
    { mailbox, folder },
    { $set: { deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=safe_checkpoint' } }
  );

  const mockRequester = async () => {
    return {
      status: 200,
      data: {
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=new_token_uncommitted',
        value: [createMockGraphMessage({ id: 'replay-msg-1' })]
      }
    };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  // Worker executes syncPassFn, but then crashes before advanceSyncCursor can run
  const lock = await acquireSyncLock({ mailbox, folder });
  const passResult = await executeSyncPass({
    cursor: lock.cursor,
    mailbox,
    folder,
    graphClient: client
  });

  assert.equal(passResult.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=new_token_uncommitted');

  // Verify MongoDB still holds safe_checkpoint because worker crashed before committing
  const uncommittedCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(uncommittedCursor.deltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=safe_checkpoint');
});

// 14. 410 delta recovery
test('deltaSyncService: HTTP 410 delta token expiration triggers controlled rebaseline with overlap window', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const tActivation = new Date('2026-11-13T08:00:00.000Z');
  const tLastSync = new Date('2026-11-13T09:30:00.000Z');

  const cursor = {
    mailbox,
    folder,
    deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=expired_old_token',
    lastSuccessfulSyncAt: tLastSync,
    activationAt: tActivation
  };

  let requests = [];
  const mockRequester = async (config) => {
    requests.push(config.url);
    if (config.url.includes('expired_old_token')) {
      const err = new Error('Delta token expired');
      err.response = { status: 410, data: { error: { code: 'ErrorDeltaTokenExpired', message: 'The delta token is expired.' } } };
      throw err;
    }
    // Rebaseline request
    return {
      status: 200,
      data: {
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=fresh_rebaselined_token',
        value: [createMockGraphMessage({ id: 'rebaseline-msg-1', receivedDateTime: '2026-11-13T09:28:00.000Z' })]
      }
    };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client
  });

  assert.equal(result.isRebaseline, true);
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=fresh_rebaselined_token');
  assert.equal(requests.length, 3, 'Must execute initial 410 call + catch-up call + delta attachment call');
  const decodedCatchUpReq = decodeURIComponent(requests[1]);
  assert.ok(
    decodedCatchUpReq.includes('/messages?') && (decodedCatchUpReq.includes('$filter=receivedDateTime ge') || decodedCatchUpReq.includes('$filter=receivedDateTime+ge')),
    'Second request must issue filtered catch-up query via standard messages endpoint'
  );
  const decodedDeltaReq = decodeURIComponent(requests[2]);
  assert.ok(
    decodedDeltaReq.includes('/messages/delta?') && (decodedDeltaReq.includes('$filter=receivedDateTime ge') || decodedDeltaReq.includes('$filter=receivedDateTime+ge')),
    'Third request must issue delta attachment query'
  );
});

// 15. New-only activation timestamp filtering
test('emailIngestionService: new-only activation boundary marks historical emails and bypasses queue', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T10:00:00.000Z');

  // Policy set in DB
  await EmailIngestionPolicy.create({
    mailbox,
    activationAt,
    enabled: true
  });

  // Email 1: received BEFORE activation (historical)
  const histMsg = createMockGraphMessage({
    id: 'msg-hist-1',
    receivedDateTime: '2026-11-13T09:59:59.000Z'
  });
  const res1 = await ingestEmailMessage({ graphMessage: histMsg, mailbox, folder });
  assert.equal(res1.isHistorical, true);

  // Email 2: received AT or AFTER activation (new)
  const newMsg = createMockGraphMessage({
    id: 'msg-new-1',
    receivedDateTime: '2026-11-13T10:00:00.000Z'
  });
  const res2 = await ingestEmailMessage({ graphMessage: newMsg, mailbox, folder });
  assert.equal(res2.isHistorical, false);

  // Verify in MongoDB: only msg-new-1 has an enqueued processing job!
  const histEmail = await SupportEmail.findOne({ graphMessageId: 'msg-hist-1' }).lean();
  assert.equal(histEmail.isHistorical, true);
  assert.equal(histEmail.pipeline.state, 'completed');

  const newEmail = await SupportEmail.findOne({ graphMessageId: 'msg-new-1' }).lean();
  assert.equal(newEmail.isHistorical, false);
  assert.equal(newEmail.pipeline.state, 'received');

  const jobs = await SupportEmailProcessingJob.find().lean();
  assert.equal(jobs.length, 1);
  assert.equal(String(jobs[0].emailId), String(newEmail._id));
  assert.equal(jobs[0].stage, 'fetch');
});

// 16. Empty mailbox
test('deltaSyncService: empty mailbox returns 0 ingested emails and updates deltaLink cleanly', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const mockRequester = async () => {
    return {
      status: 200,
      data: {
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=empty_mailbox_token',
        value: []
      }
    };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await paginateDeltaQuery({
    graphClient: client,
    initialUrl: 'https://graph.microsoft.com/v1.0/messages/delta',
    mailbox,
    folder
  });

  assert.equal(result.count, 0);
  assert.equal(result.historicalCount, 0);
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=empty_mailbox_token');
});

// 17. Malformed Graph response
test('deltaSyncService: malformed Graph response missing value array throws descriptive error', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const mockRequester = async () => {
    return {
      status: 200,
      data: {
        corruptedKey: 'invalid'
      }
    };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  await assert.rejects(
    async () => {
      await paginateDeltaQuery({
        graphClient: client,
        initialUrl: 'https://graph.microsoft.com/v1.0/messages/delta',
        mailbox,
        folder
      });
    },
    /Malformed Graph response/
  );
});

// 18. Concurrent synchronization requests coalescing into single pass
test('deltaSyncService: concurrent sync requests coalesce seamlessly via mailboxSyncService', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await signalMailboxSync({ mailbox, folder });

  let executionPasses = 0;
  const mockRequester = async () => {
    executionPasses++;
    return {
      status: 200,
      data: {
        '@odata.deltaLink': `https://graph.microsoft.com/v1.0/delta?$deltatoken=pass_${executionPasses}`,
        value: [createMockGraphMessage({ id: `concurrent-msg-${executionPasses}` })]
      }
    };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const syncPassFn = createSyncPassFn({
    graphClient: client,
    mailbox,
    folder
  });

  // Fire 3 simultaneous coalesced sync attempts
  const [res1, res2, res3] = await Promise.all([
    runCoalescedSync({ mailbox, folder, syncPassFn }),
    runCoalescedSync({ mailbox, folder, syncPassFn }),
    runCoalescedSync({ mailbox, folder, syncPassFn })
  ]);

  // Exactly 1 worker acquired lock and executed; the other 2 detected sync_already_running
  const executed = [res1, res2, res3].filter((r) => r.executed);
  const busy = [res1, res2, res3].filter((r) => !r.executed);

  assert.equal(executed.length, 1);
  assert.equal(busy.length, 2);
  assert.equal(busy[0].reason, 'sync_already_running');
  assert.equal(busy[1].reason, 'sync_already_running');
});

// 19. Stale worker rejection
test('deltaSyncService: stale worker with expired lease cannot advance deltaLink', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const t0 = new Date('2026-11-13T10:00:00.000Z');
  await signalMailboxSync({ mailbox, folder, requestedAt: t0 });

  const worker1Lock = await acquireSyncLock({ mailbox, folder, leaseMs: 30000, now: t0 });

  // Lease expires at t0 + 31s. Worker 2 claims lock
  const t1 = new Date('2026-11-13T10:00:31.000Z');
  const worker2Lock = await acquireSyncLock({ mailbox, folder, leaseMs: 30000, now: t1 });
  assert.equal(worker2Lock.locked, true);

  // Stale Worker 1 attempts to run delta sync and commit
  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=stale_token',
        value: []
      }
    })
  });

  // Stale worker tries to commit using stale token -> rejected
  const { advanceSyncCursor } = require('../services/supportEmail/mailboxSyncService');
  const staleCommit = await advanceSyncCursor({
    cursorId: worker1Lock.cursor._id,
    syncLockToken: worker1Lock.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=stale_token',
    capturedVersion: 1
  });

  assert.equal(staleCommit, null, 'Stale worker cannot advance deltaLink in MongoDB');

  const liveCursor = await EmailSyncCursor.findById(worker1Lock.cursor._id).lean();
  assert.equal(liveCursor.syncLockToken, worker2Lock.lockToken);
});

// 20. Simulating > 5,000 messages (6,000 items) through Two-Phase Baseline
test('deltaSyncService: two-phase baseline ingests > 5,000 messages (6,000 items) without delta filter truncation', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({
    mailbox,
    activationAt,
    enabled: true
  });

  const cursor = {
    mailbox,
    folder,
    deltaLink: null,
    activationAt
  };

  const TOTAL_MESSAGES = 6000;
  const PAGE_SIZE = 100;
  const TOTAL_PAGES = TOTAL_MESSAGES / PAGE_SIZE; // 60 pages

  // Mock Graph HTTP client
  const mockRequester = async (config) => {
    const url = config.url;

    // Phase 1: Standard messages catch-up endpoint
    if (url.includes('/mailFolders/inbox/messages?') && !url.includes('/messages/delta')) {
      const urlObj = new URL(url, 'https://graph.microsoft.com');
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const pageIndex = offset / PAGE_SIZE;

      const pageMessages = [];
      for (let i = 0; i < PAGE_SIZE; i++) {
        const msgNum = offset + i;
        const msgDate = new Date(activationAt.getTime() + msgNum * 1000).toISOString();
        pageMessages.push(createMockGraphMessage({
          id: `bulk-msg-${msgNum}`,
          internetMessageId: `<bulk-${msgNum}@guidexpert.com>`,
          subject: `Bulk Enquiry ${msgNum}`,
          receivedDateTime: msgDate
        }));
      }

      const nextOffset = offset + PAGE_SIZE;
      const responseData = {
        value: pageMessages
      };

      if (nextOffset < TOTAL_MESSAGES) {
        responseData['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/users/support%40guidexpert.com/mailFolders/inbox/messages?offset=${nextOffset}`;
      }

      return { status: 200, data: responseData };
    }

    // Phase 2: Delta stream attachment endpoint
    if (url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_6000_checkpoint',
          value: []
        }
      };
    }

    throw new Error(`Unexpected request URL in test: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client
  });

  // Verify all 6,000 messages were ingested
  assert.equal(result.count, 6000, 'All 6,000 messages must be ingested');
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_6000_checkpoint');

  // Verify count directly in MongoDB
  const dbCount = await SupportEmail.countDocuments();
  assert.equal(dbCount, 6000, 'MongoDB must contain exactly 6,000 SupportEmail documents');

  // Verify sample boundaries: first, 5000th, and 5999th message
  const first = await SupportEmail.findOne({ graphMessageId: 'bulk-msg-0' }).lean();
  assert.ok(first, 'First message must exist');
  assert.equal(first.isHistorical, false);

  const fiveThousandth = await SupportEmail.findOne({ graphMessageId: 'bulk-msg-5000' }).lean();
  assert.ok(fiveThousandth, '5001st message beyond 5,000 limit MUST exist');
  assert.equal(fiveThousandth.isHistorical, false);

  const last = await SupportEmail.findOne({ graphMessageId: 'bulk-msg-5999' }).lean();
  assert.ok(last, 'Last message must exist');
  assert.equal(last.isHistorical, false);
});

// 21. Delta removal and deletion events (@removed)
test('deltaSyncService: message removal and deletion events (@removed) in delta stream are handled safely', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const deltaPayload = {
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=removal_tested',
    value: [
      createMockGraphMessage({ id: 'live-msg-1' }),
      {
        id: 'deleted-msg-2',
        '@removed': { reason: 'deleted' }
      }
    ]
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({ status: 200, data: deltaPayload })
  });

  const result = await paginateDeltaQuery({
    graphClient: client,
    initialUrl: 'https://graph.microsoft.com/v1.0/messages/delta',
    mailbox,
    folder
  });

  assert.equal(result.count, 1, 'Only live message counted as ingested');
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=removal_tested');

  const count = await SupportEmail.countDocuments();
  assert.equal(count, 1);
  const liveDoc = await SupportEmail.findOne({ graphMessageId: 'live-msg-1' }).lean();
  assert.ok(liveDoc);
});

// 22. Handoff: Messages arriving during page 1
test('handoff: messages arriving during page 1 are captured without omission', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  let standardRequestCount = 0;
  const mockRequester = async (config) => {
    const url = config.url;

    // Standard list catch-up
    if (url.includes('/messages') && !url.includes('/messages/delta')) {
      standardRequestCount++;
      if (standardRequestCount === 1) {
        // Page 1: returns msg-1, links to page 2
        return {
          status: 200,
          data: {
            value: [
              createMockGraphMessage({
                id: 'msg-p1-1',
                receivedDateTime: '2026-11-13T08:05:00.000Z'
              })
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/mailFolders/inbox/messages?page=2'
          }
        };
      }
      if (standardRequestCount === 2) {
        // Page 2: returns msg-p1-2 AND new arrival during page 1: msg-during-p1
        return {
          status: 200,
          data: {
            value: [
              createMockGraphMessage({
                id: 'msg-p1-2',
                receivedDateTime: '2026-11-13T08:10:00.000Z'
              }),
              createMockGraphMessage({
                id: 'msg-during-p1',
                receivedDateTime: '2026-11-13T08:15:00.000Z'
              })
            ]
          }
        };
      }
    }

    // Delta attachment
    if (url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=p1_tested'
        }
      };
    }

    throw new Error(`Unexpected URL in test: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });

  assert.equal(result.count, 3, 'All 3 messages must be ingested');
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=p1_tested');

  const count = await SupportEmail.countDocuments();
  assert.equal(count, 3);
  const p1New = await SupportEmail.findOne({ graphMessageId: 'msg-during-p1' });
  assert.ok(p1New, 'Message arriving during page 1 must be present in MongoDB');
});

// 23. Handoff: Messages arriving during the final backlog page
test('handoff: messages arriving during final backlog page are captured by delta handoff overlap', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  let standardRequestCount = 0;
  let deltaCalled = false;

  const mockRequester = async (config) => {
    const url = config.url;

    // Standard list catch-up
    if (url.includes('/mailFolders/inbox/messages?') && !url.includes('/messages/delta')) {
      standardRequestCount++;
      // Single final page with msg-final
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({
              id: 'msg-final',
              receivedDateTime: '2026-11-13T08:30:00.000Z'
            })
          ]
        }
      };
    }

    // Delta attachment: includes new message msg-during-final that arrived during final page processing
    if (url.includes('/messages/delta')) {
      deltaCalled = true;
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({
              id: 'msg-final', // Already ingested in catch-up (overlap window)
              receivedDateTime: '2026-11-13T08:30:00.000Z'
            }),
            createMockGraphMessage({
              id: 'msg-during-final', // New message arriving during final page
              receivedDateTime: '2026-11-13T08:30:01.000Z'
            })
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=final_overlap_tested'
        }
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });

  assert.ok(deltaCalled, 'Delta attachment must be called');
  assert.equal(result.count, 2, 'Total ingested should be 2 unique messages');
  assert.equal(result.duplicateCount, 1, 'msg-final in overlap must be deduplicated');

  const count = await SupportEmail.countDocuments();
  assert.equal(count, 2);
  const msgDuringFinal = await SupportEmail.findOne({ graphMessageId: 'msg-during-final' });
  assert.ok(msgDuringFinal, 'Message arriving during final page must exist in MongoDB');
});

// 24. Handoff: Messages arriving between last standard response and first delta request
test('handoff: messages arriving between last standard-list response and first delta request are captured', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const mockRequester = async (config) => {
    const url = config.url;

    if (url.includes('/mailFolders/inbox/messages?') && !url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({
              id: 'msg-std-1',
              receivedDateTime: '2026-11-13T08:45:00.000Z'
            })
          ]
        }
      };
    }

    if (url.includes('/messages/delta')) {
      // Delta query captures msg-in-gap that arrived during handoff gap
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({
              id: 'msg-in-gap',
              receivedDateTime: '2026-11-13T08:45:02.000Z'
            })
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=gap_tested'
        }
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });

  assert.equal(result.count, 2);
  const gapMsg = await SupportEmail.findOne({ graphMessageId: 'msg-in-gap' });
  assert.ok(gapMsg, 'Gap message must be ingested');
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=gap_tested');
});

// 25. Handoff: Multiple messages with identical receivedDateTime values
test('handoff: multiple messages with identical receivedDateTime values across page boundary are preserved', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');
  const identicalTimestamp = '2026-11-13T09:00:00.000Z';

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const mockRequester = async (config) => {
    const url = config.url;

    if (url.includes('/mailFolders/inbox/messages?') && !url.includes('/messages/delta')) {
      // Standard catch-up only saw msg-dup-1 before page boundary
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({
              id: 'msg-dup-1',
              receivedDateTime: identicalTimestamp
            })
          ]
        }
      };
    }

    if (url.includes('/messages/delta')) {
      // Delta query with 'ge' returns both msg-dup-1 and msg-dup-2 having identical timestamp
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({
              id: 'msg-dup-1',
              receivedDateTime: identicalTimestamp
            }),
            createMockGraphMessage({
              id: 'msg-dup-2',
              receivedDateTime: identicalTimestamp
            })
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=dup_time_tested'
        }
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });

  assert.equal(result.count, 2, 'Both messages with identical timestamp must be ingested');
  assert.equal(result.duplicateCount, 1, 'msg-dup-1 must be recognized as duplicate on second encounter');

  const count = await SupportEmail.countDocuments();
  assert.equal(count, 2);
  const doc1 = await SupportEmail.findOne({ graphMessageId: 'msg-dup-1' });
  const doc2 = await SupportEmail.findOne({ graphMessageId: 'msg-dup-2' });
  assert.ok(doc1);
  assert.ok(doc2);
});

// 26. Handoff: Iterative catch-up draining burst of >5,000 new messages before delta attachment
test('handoff: iterative catch-up drains burst of new messages before delta attachment', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  let standardPass = 0;
  const mockRequester = async (config) => {
    const url = config.url;

    if (url.includes('/mailFolders/inbox/messages?') && !url.includes('/messages/delta')) {
      standardPass++;
      if (standardPass === 1) {
        // Pass 1: returns initial backlog of 600 messages (>= 500 threshold)
        const msgs = [];
        for (let i = 0; i < 600; i++) {
          msgs.push(createMockGraphMessage({
            id: `burst-p1-${i}`,
            receivedDateTime: new Date(activationAt.getTime() + i * 1000).toISOString()
          }));
        }
        return { status: 200, data: { value: msgs } };
      }
      if (standardPass === 2) {
        // Pass 2: drained 50 new messages (< 500 threshold)
        const msgs = [];
        for (let i = 0; i < 50; i++) {
          msgs.push(createMockGraphMessage({
            id: `burst-p2-${i}`,
            receivedDateTime: new Date(activationAt.getTime() + (600 + i) * 1000).toISOString()
          }));
        }
        return { status: 200, data: { value: msgs } };
      }
      return { status: 200, data: { value: [] } };
    }

    if (url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=burst_tested'
        }
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });

  assert.equal(standardPass, 2, 'Iterative catch-up must execute multiple passes until convergence');
  assert.equal(result.count, 650, 'All 650 messages must be ingested');
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=burst_tested');

  const count = await SupportEmail.countDocuments();
  assert.equal(count, 650);
});

// 27. Crash & Retry: Worker crash during baseline enumeration leaves deltaLink null and retries idempotently
test('crash and retry: crash during baseline enumeration leaves deltaLink null and retries idempotently', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });
  await EmailSyncCursor.create({
    mailbox,
    folder,
    deltaLink: null,
    activationAt,
    syncStatus: 'idle'
  });

  // Attempt 1: Worker crashes on page 2
  let pageNumber = 0;
  const crashRequester = async (config) => {
    const url = config.url;
    if (url.includes('/messages') && !url.includes('/messages/delta')) {
      pageNumber++;
      if (pageNumber === 1) {
        return {
          status: 200,
          data: {
            value: [createMockGraphMessage({ id: 'crash-msg-1', receivedDateTime: '2026-11-13T08:01:00.000Z' })],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/mailFolders/inbox/messages?page=2'
          }
        };
      }
      throw new Error('WORKER CRASH MID-SYNC');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: crashRequester
  });

  const cursorDoc = await EmailSyncCursor.findOne({ mailbox, folder });
  await assert.rejects(
    async () => {
      await executeSyncPass({ cursor: cursorDoc, mailbox, folder, graphClient: client1 });
    },
    /WORKER CRASH MID-SYNC/
  );

  // Check state after crash: msg-1 is saved in DB, but cursor deltaLink is STILL null
  const countAfterCrash = await SupportEmail.countDocuments();
  assert.equal(countAfterCrash, 1, 'Page 1 message committed before crash');
  const cursorAfterCrash = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(cursorAfterCrash.deltaLink, null, 'deltaLink MUST remain null after crash');

  // Attempt 2: Replacement worker restarts baseline
  const successRequester = async (config) => {
    const url = config.url;
    if (url.includes('/mailFolders/inbox/messages?')) {
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({ id: 'crash-msg-1', receivedDateTime: '2026-11-13T08:01:00.000Z' }),
            createMockGraphMessage({ id: 'crash-msg-2', receivedDateTime: '2026-11-13T08:02:00.000Z' })
          ]
        }
      };
    }
    if (url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=recovered_checkpoint'
        }
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: successRequester
  });

  const retryResult = await executeSyncPass({ cursor: cursorAfterCrash, mailbox, folder, graphClient: client2 });

  assert.equal(retryResult.count, 1, 'Only msg-2 is newly ingested');
  assert.equal(retryResult.duplicateCount, 1, 'msg-1 is safely skipped as duplicate');
  assert.equal(retryResult.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=recovered_checkpoint');

  const finalCount = await SupportEmail.countDocuments();
  assert.equal(finalCount, 2, 'Exactly 2 unique messages exist in DB');
});

// 28. Repeated Baseline Runs: Repeated baseline runs are idempotent and produce zero duplicate tickets
test('repeated baseline runs: executing baseline multiple times is idempotent and produces zero duplicate tickets', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const messages = [
    createMockGraphMessage({ id: 'repeat-msg-1', receivedDateTime: '2026-11-13T08:10:00.000Z' }),
    createMockGraphMessage({ id: 'repeat-msg-2', receivedDateTime: '2026-11-13T08:20:00.000Z' })
  ];

  const mockRequester = async (config) => {
    const url = config.url;
    if (url.includes('/mailFolders/inbox/messages?') && !url.includes('/messages/delta')) {
      return { status: 200, data: { value: messages } };
    }
    if (url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=repeat_run_tested'
        }
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  // First run
  const run1 = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });
  assert.equal(run1.count, 2);
  assert.equal(run1.duplicateCount, 0);

  const initialDocs = await SupportEmail.countDocuments();
  const initialJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(initialDocs, 2);
  assert.equal(initialJobs, 2);

  // Second run (simulating forced rebaseline)
  const run2 = await executeSyncPass({ cursor, mailbox, folder, graphClient: client });
  assert.equal(run2.count, 0, 'Zero new documents ingested on rerun');
  assert.equal(run2.duplicateCount, 2, 'Both documents recognized as duplicates');

  const afterDocs = await SupportEmail.countDocuments();
  const afterJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(afterDocs, 2, 'Document count must remain 2');
  assert.equal(afterJobs, 2, 'Job count must remain 2 (zero duplicate jobs enqueued)');
});

// 29. Safety Guard: Delta filter returning >= 5,000 items throws and rejects premature deltaLink
test('safety guard: filtered delta query returning >= 5,000 messages throws and rejects premature deltaLink', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const mockTruncatedDelta = {
    value: new Array(5000).fill(null).map((_, i) => createMockGraphMessage({ id: `trunc-${i}` })),
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=premature_truncated_token'
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({ status: 200, data: mockTruncatedDelta })
  });

  await assert.rejects(
    async () => {
      await paginateDeltaQuery({
        graphClient: client,
        initialUrl: 'https://graph.microsoft.com/v1.0/messages/delta?$filter=receivedDateTime ge 2026-11-13T08:00:00.000Z',
        mailbox,
        folder
      });
    },
    /Graph delta filter truncated at 5000 messages; refusing to accept incomplete deltaLink/
  );
});

