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
const SupportTicket = require('../models/SupportTicket');
const SupportTicketEvent = require('../models/SupportTicketEvent');
const SupportEmailAuditLog = require('../models/SupportEmailAuditLog');

const {
  GraphClient
} = require('../services/supportEmail/graphClient');
const {
  normalizeGraphMessage
} = require('../services/supportEmail/messageNormalizationService');
const {
  executeSyncPass,
  executeUnfilteredDeltaBaseline,
  paginateDeltaQuery
} = require('../services/supportEmail/deltaSyncService');
const {
  ingestEmailMessage,
  ingestMessageBatch,
  quarantineInvalidMessage
} = require('../services/supportEmail/emailIngestionService');
const {
  runCoalescedSync,
  signalMailboxSync,
  acquireSyncLock,
  advanceSyncCursor
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

// Helper to create mock Graph message
function createMockGraphMessage({
  id = 'msg-1',
  internetMessageId = undefined,
  subject = 'Test Subject',
  receivedDateTime = '2026-11-13T10:00:00.000Z',
  body = 'Hello Support Team',
  hasAttachments = false
} = {}) {
  const normInternetMsgId = internetMessageId !== undefined ? internetMessageId : `<${id}@guidexpert.com>`;
  return {
    id,
    internetMessageId: normInternetMsgId,
    conversationId: 'conv-123',
    receivedDateTime,
    sentDateTime: receivedDateTime,
    from: {
      emailAddress: { name: 'Student', address: 'student@example.com' }
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

// 1. More than 5,000 historical messages
test('unfiltered baseline: >5,000 historical messages are paginated without 5,000 truncation and bypass queue', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T12:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const TOTAL_HISTORICAL = 6000;
  const PAGE_SIZE = 100;

  const mockRequester = async (config) => {
    const url = config.url;

    // Must be an unfiltered delta request (NO $filter)
    assert.ok(url.includes('/messages/delta'), 'Must query delta endpoint');
    assert.ok(!url.includes('$filter='), 'Unfiltered delta must strictly NOT contain $filter=');

    const urlObj = new URL(url, 'https://graph.microsoft.com');
    const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);

    const pageMessages = [];
    for (let i = 0; i < PAGE_SIZE; i++) {
      const msgNum = offset + i;
      // All received prior to activationAt (historical)
      const msgDate = new Date(activationAt.getTime() - (TOTAL_HISTORICAL - msgNum) * 1000).toISOString();
      pageMessages.push(createMockGraphMessage({
        id: `hist-msg-${msgNum}`,
        receivedDateTime: msgDate
      }));
    }

    const nextOffset = offset + PAGE_SIZE;
    const responseData = { value: pageMessages };

    if (nextOffset < TOTAL_HISTORICAL) {
      responseData['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/messages/delta?offset=${nextOffset}`;
    } else {
      responseData['@odata.deltaLink'] = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_historical_token';
    }

    return { status: 200, data: responseData };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(result.historicalCount, 6000, 'All 6,000 historical messages must be identified');
  assert.equal(result.count, 6000, 'Total 6,000 messages processed');
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_historical_token');

  // Verify database: 6,000 historical documents, but 0 queue jobs and 0 tickets!
  const dbCount = await SupportEmail.countDocuments();
  assert.equal(dbCount, 6000, 'All 6,000 historical messages stored with isHistorical: true');

  const jobCount = await SupportEmailProcessingJob.countDocuments();
  assert.equal(jobCount, 0, 'CRITICAL: Historical messages must NEVER enter the queue');

  const ticketCount = await SupportTicket.countDocuments();
  assert.equal(ticketCount, 0, 'CRITICAL: Historical messages must NEVER create tickets');
});

// 2. More than 5,000 new messages after activation
test('unfiltered baseline: >5,000 new messages after activation are ingested and enqueued', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const TOTAL_NEW = 6000;
  const PAGE_SIZE = 100;

  const mockRequester = async (config) => {
    const url = config.url;
    assert.ok(!url.includes('$filter='), 'Unfiltered delta must not contain $filter');

    const urlObj = new URL(url, 'https://graph.microsoft.com');
    const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);

    const pageMessages = [];
    for (let i = 0; i < PAGE_SIZE; i++) {
      const msgNum = offset + i;
      // All received after activationAt (new)
      const msgDate = new Date(activationAt.getTime() + msgNum * 1000).toISOString();
      pageMessages.push(createMockGraphMessage({
        id: `new-msg-${msgNum}`,
        receivedDateTime: msgDate
      }));
    }

    const nextOffset = offset + PAGE_SIZE;
    const responseData = { value: pageMessages };

    if (nextOffset < TOTAL_NEW) {
      responseData['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/messages/delta?offset=${nextOffset}`;
    } else {
      responseData['@odata.deltaLink'] = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_new_6000_token';
    }

    return { status: 200, data: responseData };
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(result.count, 6000, 'All 6,000 new messages must be ingested');
  assert.equal(result.historicalCount, 0);
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_new_6000_token');

  const dbCount = await SupportEmail.countDocuments();
  assert.equal(dbCount, 6000);

  const jobCount = await SupportEmailProcessingJob.countDocuments();
  assert.equal(jobCount, 6000, 'All 6,000 active messages must be enqueued for processing');
});

// 3. Historical messages never enter the processing queue
test('unfiltered baseline: historical messages strictly bypass queue while new messages are enqueued', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T10:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const deltaPayload = {
    value: [
      createMockGraphMessage({ id: 'old-1', receivedDateTime: '2026-11-13T09:00:00.000Z' }),
      createMockGraphMessage({ id: 'old-2', receivedDateTime: '2026-11-13T09:30:00.000Z' }),
      createMockGraphMessage({ id: 'new-1', receivedDateTime: '2026-11-13T10:05:00.000Z' }),
      createMockGraphMessage({ id: 'new-2', receivedDateTime: '2026-11-13T10:15:00.000Z' })
    ],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=mixed_token'
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({ status: 200, data: deltaPayload })
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(result.historicalCount, 2);
  assert.equal(result.count, 4, 'Total 4 messages ingested');
  assert.equal(result.count - result.historicalCount, 2, 'Exactly 2 active messages');

  const totalDocs = await SupportEmail.countDocuments();
  assert.equal(totalDocs, 4);

  const totalJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(totalJobs, 2, 'Only the 2 new messages must create queue jobs');

  const jobs = await SupportEmailProcessingJob.find().lean();
  const enqueuedEmailIds = jobs.map((j) => String(j.emailId));
  const newDoc1 = await SupportEmail.findOne({ graphMessageId: 'new-1' }).lean();
  const newDoc2 = await SupportEmail.findOne({ graphMessageId: 'new-2' }).lean();
  assert.ok(enqueuedEmailIds.includes(String(newDoc1._id)));
  assert.ok(enqueuedEmailIds.includes(String(newDoc2._id)));
});

// 4. New messages arriving during initial delta pagination
test('unfiltered baseline: new messages arriving during initial delta pagination are captured', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T10:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  let requestCount = 0;
  const mockRequester = async (config) => {
    requestCount++;
    if (requestCount === 1) {
      // Page 1: returns initial message
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'init-msg-1', receivedDateTime: '2026-11-13T10:01:00.000Z' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/messages/delta?page=2'
        }
      };
    }
    if (requestCount === 2) {
      // Page 2: returns a new message that arrived during sync
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'concurrent-msg-2', receivedDateTime: '2026-11-13T10:02:00.000Z' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=concurrent_token'
        }
      };
    }
    throw new Error(`Unexpected request count: ${requestCount}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(result.count, 2);
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=concurrent_token');

  const doc1 = await SupportEmail.findOne({ graphMessageId: 'init-msg-1' });
  const doc2 = await SupportEmail.findOne({ graphMessageId: 'concurrent-msg-2' });
  assert.ok(doc1);
  assert.ok(doc2);
});

// 5. Identical receivedDateTime values
test('unfiltered baseline: multiple messages with identical receivedDateTime values are preserved', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');
  const identicalTimestamp = '2026-11-13T10:00:00.000Z';

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const deltaPayload = {
    value: [
      createMockGraphMessage({ id: 'msg-same-1', receivedDateTime: identicalTimestamp }),
      createMockGraphMessage({ id: 'msg-same-2', receivedDateTime: identicalTimestamp }),
      createMockGraphMessage({ id: 'msg-same-3', receivedDateTime: identicalTimestamp })
    ],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=same_time_token'
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({ status: 200, data: deltaPayload })
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(result.count, 3, 'All 3 messages with identical timestamp must be ingested');
  const count = await SupportEmail.countDocuments();
  assert.equal(count, 3);
});

// 6. Messages becoming visible after an earlier page has been fetched (out-of-order store commit)
test('unfiltered baseline: messages becoming visible out-of-order after earlier page are captured', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  let page = 0;
  const mockRequester = async (config) => {
    page++;
    if (page === 1) {
      // Page 1 returns msg-A with timestamp 10:05
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'msg-A', receivedDateTime: '2026-11-13T10:05:00.000Z' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/messages/delta?page=2'
        }
      };
    }
    if (page === 2) {
      // Page 2 returns msg-B with earlier timestamp 10:02 (committed late to store)
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'msg-B', receivedDateTime: '2026-11-13T10:02:00.000Z' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=out_of_order_token'
        }
      };
    }
    throw new Error(`Unexpected page: ${page}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const result = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(result.count, 2, 'Both messages must be ingested regardless of timestamp order');
  const docA = await SupportEmail.findOne({ graphMessageId: 'msg-A' });
  const docB = await SupportEmail.findOne({ graphMessageId: 'msg-B' });
  assert.ok(docA);
  assert.ok(docB);
});

// 7. Crash during pagination and successful restart
test('unfiltered baseline: crash during pagination and successful restart leaves cursor intact', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });
  await EmailSyncCursor.create({ mailbox, folder, deltaLink: null, activationAt, syncStatus: 'idle' });

  // Attempt 1: Worker crashes on page 2
  let page = 0;
  const crashRequester = async () => {
    page++;
    if (page === 1) {
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'unfiltered-crash-1', receivedDateTime: '2026-11-13T08:01:00.000Z' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/messages/delta?page=2'
        }
      };
    }
    throw new Error('SIMULATED CRASH ON PAGE 2');
  };

  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: crashRequester
  });

  const cursorDoc = await EmailSyncCursor.findOne({ mailbox, folder });
  await assert.rejects(
    async () => {
      await executeSyncPass({ cursor: cursorDoc, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });
    },
    /SIMULATED CRASH ON PAGE 2/
  );

  // Check state after crash: page 1 msg committed to MongoDB, but cursor deltaLink is NULL
  const countAfterCrash = await SupportEmail.countDocuments();
  assert.equal(countAfterCrash, 1);
  const cursorAfterCrash = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(cursorAfterCrash.deltaLink, null, 'deltaLink must remain null after crash');

  // Attempt 2: Worker 2 restarts baseline
  const successRequester = async () => {
    return {
      status: 200,
      data: {
        value: [
          createMockGraphMessage({ id: 'unfiltered-crash-1', receivedDateTime: '2026-11-13T08:01:00.000Z' }),
          createMockGraphMessage({ id: 'unfiltered-crash-2', receivedDateTime: '2026-11-13T08:02:00.000Z' })
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=recovered_unfiltered_token'
      }
    };
  };

  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: successRequester
  });

  const retryResult = await executeSyncPass({
    cursor: cursorAfterCrash,
    mailbox,
    folder,
    graphClient: client2,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(retryResult.count, 1, 'Only msg-2 is newly ingested');
  assert.equal(retryResult.duplicateCount, 1, 'msg-1 is safely deduplicated');
  assert.equal(retryResult.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=recovered_unfiltered_token');

  const finalCount = await SupportEmail.countDocuments();
  assert.equal(finalCount, 2);
});

// 8. Failure before deltaLink persistence
test('unfiltered baseline: failure before deltaLink persistence leaves cursor null for safe replay', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });
  const cursor = await EmailSyncCursor.create({ mailbox, folder, deltaLink: null, activationAt, syncStatus: 'idle' });

  // Simulate complete Graph delta fetch succeeding
  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-save-fail', receivedDateTime: '2026-11-13T09:00:00.000Z' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=uncommitted_token'
      }
    })
  });

  const passResult = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.ok(passResult.nextDeltaLink);

  // If a crash occurs BEFORE advanceSyncCursor is called on EmailSyncCursor:
  const untouchedCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(untouchedCursor.deltaLink, null, 'Cursor deltaLink remains null until advanceSyncCursor completes');
});

// 9. DeltaLink persistence only after complete pagination
test('unfiltered baseline: deltaLink persistence happens strictly after complete pagination', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  let pagesServed = 0;
  const mockRequester = async () => {
    pagesServed++;
    if (pagesServed === 1) {
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'p-1' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/messages/delta?page=2'
        }
      };
    }
    if (pagesServed === 2) {
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'p-2' })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/messages/delta?page=3'
        }
      };
    }
    if (pagesServed === 3) {
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'p-3' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=final_p3_token'
        }
      };
    }
    throw new Error('Unexpected page');
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

  assert.equal(result.pages, 3);
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=final_p3_token');
});

// 10. Duplicate messages across repeated baseline runs
test('unfiltered baseline: duplicate messages across repeated baseline runs are safely deduplicated', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };

  const deltaPayload = {
    value: [
      createMockGraphMessage({ id: 'unfiltered-dup-1', receivedDateTime: '2026-11-13T09:00:00.000Z' }),
      createMockGraphMessage({ id: 'unfiltered-dup-2', receivedDateTime: '2026-11-13T09:30:00.000Z' })
    ],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=repeat_token'
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({ status: 200, data: deltaPayload })
  });

  // Run 1
  const run1 = await executeSyncPass({ cursor, mailbox, folder, graphClient: client, baselineStrategy: 'unfiltered' });
  assert.equal(run1.count, 2);
  assert.equal(run1.duplicateCount, 0);

  const docsAfterRun1 = await SupportEmail.countDocuments();
  const jobsAfterRun1 = await SupportEmailProcessingJob.countDocuments();
  assert.equal(docsAfterRun1, 2);
  assert.equal(jobsAfterRun1, 2);

  // Run 2 (simulating forced rebaseline)
  const run2 = await executeSyncPass({ cursor, mailbox, folder, graphClient: client, baselineStrategy: 'unfiltered' });
  assert.equal(run2.count, 0, 'Zero new messages on rerun');
  assert.equal(run2.duplicateCount, 2, 'All messages marked duplicates');

  const docsAfterRun2 = await SupportEmail.countDocuments();
  const jobsAfterRun2 = await SupportEmailProcessingJob.countDocuments();
  assert.equal(docsAfterRun2, 2);
  assert.equal(jobsAfterRun2, 2, 'Zero duplicate jobs enqueued');
});

// 11. Deleted or moved messages (@removed)
test('unfiltered baseline: deleted or moved messages (@removed) are handled safely', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const deltaPayload = {
    value: [
      createMockGraphMessage({ id: 'live-unfiltered-1' }),
      {
        id: 'deleted-unfiltered-2',
        '@removed': { reason: 'deleted' }
      }
    ],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=removed_handled_token'
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
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=removed_handled_token');

  const count = await SupportEmail.countDocuments();
  assert.equal(count, 1);
});

// 12. Stale worker attempting to advance cursor
test('unfiltered baseline: stale worker with expired lease cannot advance deltaLink', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  await EmailSyncCursor.create({
    mailbox,
    folder,
    deltaLink: null,
    syncStatus: 'idle'
  });

  // Worker 1 acquires lock with short lease
  const lock1 = await acquireSyncLock({ mailbox, folder, leaseMs: 50 });
  assert.ok(lock1.locked);

  // Sleep 60ms to expire worker 1's lease
  await new Promise((r) => setTimeout(r, 60));

  // Worker 2 acquires lock
  const lock2 = await acquireSyncLock({ mailbox, folder, leaseMs: 10000 });
  assert.ok(lock2.locked);

  // Stale Worker 1 attempts to advance cursor with expired lock token
  const staleAdvance = await advanceSyncCursor({
    cursorId: lock1.cursor._id,
    syncLockToken: lock1.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=stale_token',
    capturedVersion: 0
  });
  assert.equal(staleAdvance, null, 'Stale worker cannot advance cursor (advanceSyncCursor returns null)');

  // Verify cursor deltaLink was NOT overwritten by stale worker
  const currentCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(currentCursor.deltaLink, null);

  // Valid Worker 2 advances cursor
  const validAdvance = await advanceSyncCursor({
    cursorId: lock2.cursor._id,
    syncLockToken: lock2.lockToken,
    nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=valid_token',
    capturedVersion: 0
  });
  assert.ok(validAdvance, 'Valid worker can advance cursor');

  const updatedCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(updatedCursor.deltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=valid_token');
});

// 13. Concurrent webhook or sync signals during baseline execution
test('unfiltered baseline: concurrent sync signals coalesce seamlessly during baseline execution', async () => {
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

  let passNumber = 0;
  const mockSyncPassFn = async (cursorDoc) => {
    passNumber++;
    if (passNumber === 1) {
      // While Pass 1 is running, a concurrent webhook signal arrives!
      await signalMailboxSync({ mailbox, folder, source: 'webhook-arrival' });

      return {
        nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=pass_1_token',
        count: 5
      };
    }
    if (passNumber === 2) {
      // Pass 2 runs immediately to pick up the concurrent signal
      return {
        nextDeltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=pass_2_token',
        count: 1
      };
    }
    return {
      nextDeltaLink: cursorDoc.deltaLink,
      count: 0
    };
  };

  const outcome = await runCoalescedSync({
    mailbox,
    folder,
    syncPassFn: mockSyncPassFn
  });

  assert.equal(passNumber, 2, 'Must perform follow-up pass for concurrent signal');
  assert.equal(outcome.totalIngested, 6, 'Total count must aggregate both passes');

  const finalCursor = await EmailSyncCursor.findOne({ mailbox, folder }).lean();
  assert.equal(finalCursor.deltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=pass_2_token');
  assert.equal(finalCursor.hasPendingSync, false);
});

// 14. @removed on existing message updates removal metadata and inInbox: false without deleting support ticket or ticket events
test('@removed: message removal from Inbox updates metadata and inInbox: false without deleting ticket or audit history', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // 1. Initial baseline ingests message
  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-ticketed-1', receivedDateTime: '2026-11-13T08:15:00.000Z' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=pre_delete_token'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  const emailDoc = await SupportEmail.findOne({ graphMessageId: 'msg-ticketed-1' });
  assert.ok(emailDoc);

  // 2. Create SupportTicket and SupportTicketEvent for this email
  const ticket = await SupportTicket.create({
    ticketNumber: 'TICK-TEST-0001',
    dedupeKey: `test:msg-ticketed-1`,
    primaryEmailId: emailDoc._id,
    emailIds: [emailDoc._id],
    conversationId: emailDoc.conversationId,
    requester: {
      name: emailDoc.from.name,
      email: emailDoc.from.address
    },
    enquiry: {
      summary: emailDoc.subject,
      details: emailDoc.bodyText || 'Support Query'
    },
    status: 'open',
    category: 'general',
    priority: 'medium'
  });

  const ticketEvent = await SupportTicketEvent.create({
    ticketId: ticket._id,
    type: 'created',
    actorType: 'system',
    metadata: { reason: 'Initial ticket creation' }
  });

  // 3. User deletes or moves email in Outlook; Graph emits @removed with reason 'deleted'
  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          {
            id: 'msg-ticketed-1',
            '@removed': { reason: 'deleted' }
          }
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_delete_token'
      }
    })
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=pre_delete_token';
  const removeResult = await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  assert.equal(removeResult.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=post_delete_token');

  // Verify email document is updated with removal metadata
  const updatedEmail = await SupportEmail.findOne({ graphMessageId: 'msg-ticketed-1' }).lean();
  assert.ok(updatedEmail, 'SupportEmail document must still exist in MongoDB');
  assert.equal(updatedEmail.metadata.isRemoved, true);
  assert.equal(updatedEmail.metadata.graphRemovalReason, 'deleted');
  assert.equal(updatedEmail.metadata.removalReason, 'deleted');
  assert.equal(updatedEmail.metadata.inInbox, false);
  assert.ok(updatedEmail.metadata.removedAt instanceof Date);

  // CRITICAL: Support ticket must NOT be deleted!
  const survivingTicket = await SupportTicket.findById(ticket._id).lean();
  assert.ok(survivingTicket, 'CRITICAL: SupportTicket must NOT be deleted when email is deleted in Outlook');
  assert.equal(survivingTicket.status, 'open');
  assert.equal(String(survivingTicket.primaryEmailId), String(emailDoc._id));

  // CRITICAL: Support ticket event must NOT be deleted!
  const survivingEvent = await SupportTicketEvent.findById(ticketEvent._id).lean();
  assert.ok(survivingEvent, 'CRITICAL: SupportTicketEvent must NOT be deleted when email is removed in Outlook');
  assert.equal(survivingEvent.type, 'created');
});

// 15. Message moved out of Inbox arrives with Graph reason 'deleted'; system sets inInbox: false and preserves raw reason without inferring moved
test('@removed: message moved out of Inbox arrives with reason deleted; system sets inInbox: false without inferring moved', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-moved-1' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  // Move event in Outlook: Microsoft Graph documentation specifies that items moved out of a folder
  // return @removed with reason 'deleted'. Delta alone cannot distinguish moved vs permanent deletion.
  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [{ id: 'msg-moved-1', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2'
      }
    })
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  const movedDoc = await SupportEmail.findOne({ graphMessageId: 'msg-moved-1' }).lean();
  assert.equal(movedDoc.metadata.isRemoved, true);
  assert.equal(movedDoc.metadata.graphRemovalReason, 'deleted', 'Raw Graph removal reason must be preserved');
  assert.equal(movedDoc.metadata.inInbox, false, 'inInbox must explicitly be false');
  // Confirm system does NOT invent or infer 'moved' from Graph's 'deleted'
  assert.notEqual(movedDoc.metadata.graphRemovalReason, 'moved');
});

// 16. Permanently deleted message arrives with reason 'deleted'; system sets inInbox: false and preserves SupportEmail for audit
test('@removed: permanently deleted message arrives with reason deleted; system sets inInbox: false and preserves SupportEmail', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-purged-1' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  // Message hard deleted: Graph returns @removed with reason 'deleted'
  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [{ id: 'msg-purged-1', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2'
      }
    })
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  const purgedDoc = await SupportEmail.findOne({ graphMessageId: 'msg-purged-1' }).lean();
  assert.ok(purgedDoc, 'SupportEmail document must be preserved for audit');
  assert.equal(purgedDoc.metadata.isRemoved, true);
  assert.equal(purgedDoc.metadata.graphRemovalReason, 'deleted');
  assert.equal(purgedDoc.metadata.inInbox, false);
});

// 17. Malformed and missing removal reasons are represented explicitly without defaulting to deleted
test('@removed: malformed and missing removal reasons are represented explicitly without defaulting to deleted', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // Initial ingestion of 4 messages
  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          createMockGraphMessage({ id: 'msg-malformed-1' }),
          createMockGraphMessage({ id: 'msg-malformed-2' }),
          createMockGraphMessage({ id: 'msg-malformed-3' }),
          createMockGraphMessage({ id: 'msg-malformed-4' })
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  // Delta emits missing reason (@removed: {}), valid string (@removed: "deleted"),
  // boolean primitive (@removed: true), and non-string reason (@removed: { reason: null })
  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          { id: 'msg-malformed-1', '@removed': {} }, // Object with missing reason
          { id: 'msg-malformed-2', '@removed': 'deleted' }, // Raw string instead of object
          { id: 'msg-malformed-3', '@removed': true }, // Boolean instead of object
          { id: 'msg-malformed-4', '@removed': { reason: null } } // Non-string reason
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2'
      }
    })
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });
  assert.ok(result.nextDeltaLink);

  // 1. Missing reason must be explicitly recorded as 'missing' (NEVER defaulted to 'deleted')
  const doc1 = await SupportEmail.findOne({ graphMessageId: 'msg-malformed-1' }).lean();
  assert.equal(doc1.metadata.isRemoved, true);
  assert.equal(doc1.metadata.graphRemovalReason, 'missing', 'Missing reason must be explicitly "missing"');
  assert.equal(doc1.metadata.inInbox, false);

  // 2. Valid raw string preserved as 'deleted'
  const doc2 = await SupportEmail.findOne({ graphMessageId: 'msg-malformed-2' }).lean();
  assert.equal(doc2.metadata.isRemoved, true);
  assert.equal(doc2.metadata.graphRemovalReason, 'deleted');
  assert.equal(doc2.metadata.inInbox, false);

  // 3. Primitive boolean must be explicitly recorded as 'malformed' (NEVER defaulted to 'deleted')
  const doc3 = await SupportEmail.findOne({ graphMessageId: 'msg-malformed-3' }).lean();
  assert.equal(doc3.metadata.isRemoved, true);
  assert.equal(doc3.metadata.graphRemovalReason, 'malformed', 'Primitive @removed must be explicitly "malformed"');
  assert.equal(doc3.metadata.inInbox, false);

  // 4. Object with null reason must be explicitly recorded as 'malformed'
  const doc4 = await SupportEmail.findOne({ graphMessageId: 'msg-malformed-4' }).lean();
  assert.equal(doc4.metadata.isRemoved, true);
  assert.equal(doc4.metadata.graphRemovalReason, 'malformed', 'Non-string reason must be explicitly "malformed"');
  assert.equal(doc4.metadata.inInbox, false);
});

// 18. Replayed removal events are idempotent and preserve original removedAt timestamp
test('@removed: replayed removal events are idempotent and preserve original removedAt timestamp', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-replay-del' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [{ id: 'msg-replay-del', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2'
      }
    })
  });

  // Replay removal pass 1
  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  const docAfterPass1 = await SupportEmail.findOne({ graphMessageId: 'msg-replay-del' }).lean();
  assert.equal(docAfterPass1.metadata.isRemoved, true);
  assert.ok(docAfterPass1.metadata.removedAt instanceof Date);
  const firstRemovedAt = docAfterPass1.metadata.removedAt;

  // Replay removal pass 2 with same event
  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  const docAfterPass2 = await SupportEmail.findOne({ graphMessageId: 'msg-replay-del' }).lean();
  assert.equal(docAfterPass2.metadata.isRemoved, true);
  assert.equal(docAfterPass2.metadata.inInbox, false);
  // CRITICAL: removedAt must be preserved across replays, not overwritten!
  assert.equal(docAfterPass2.metadata.removedAt.getTime(), firstRemovedAt.getTime(), 'removedAt must remain identical across replays');

  const jobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(jobs, 1, 'Job count must remain 1 (zero jobs for removal)');
});

// 19. Removal event replay after rebaseline does not duplicate jobs or mutate tickets
test('@removed: removal event replay after rebaseline does not duplicate jobs or mutate tickets', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // 1. Initial baseline ingests message
  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-rebase-del-1' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  const emailDoc = await SupportEmail.findOne({ graphMessageId: 'msg-rebase-del-1' });
  const ticket = await SupportTicket.create({
    ticketNumber: 'TICK-TEST-REBASE',
    dedupeKey: 'test:rebase-del-1',
    primaryEmailId: emailDoc._id,
    emailIds: [emailDoc._id],
    status: 'open',
    category: 'general',
    priority: 'medium'
  });

  // 2. Token expires (HTTP 410); triggers rebaseline
  const clientRebase = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async (config) => {
      if (config.url.includes('t1')) {
        const err = new Error('Token expired');
        err.response = { status: 410, data: { error: { code: 'syncStateNotFound' } } };
        throw err;
      }
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'msg-rebase-del-1' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2'
        }
      };
    }
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  const rebaseOutcome = await executeSyncPass({ cursor, mailbox, folder, graphClient: clientRebase, baselineStrategy: 'unfiltered' });
  assert.equal(rebaseOutcome.isRebaseline, true);

  // 3. Next incremental pass receives @removed event
  const clientRemove = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [{ id: 'msg-rebase-del-1', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t3'
      }
    })
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2';
  await executeSyncPass({ cursor, mailbox, folder, graphClient: clientRemove, baselineStrategy: 'unfiltered' });

  // Verify ticket still intact
  const survivingTicket = await SupportTicket.findById(ticket._id).lean();
  assert.ok(survivingTicket);
  assert.equal(survivingTicket.status, 'open');

  // Verify email marked removed
  const updatedEmail = await SupportEmail.findOne({ graphMessageId: 'msg-rebase-del-1' }).lean();
  assert.equal(updatedEmail.metadata.isRemoved, true);
  assert.equal(updatedEmail.metadata.inInbox, false);

  // Jobs remain exactly 1
  const jobCount = await SupportEmailProcessingJob.countDocuments();
  assert.equal(jobCount, 1);
});

// 20. Read/unread updates in delta stream update metadata.isRead and create zero duplicate tickets or jobs
test('delta updates: read/unread status updates in delta stream update metadata.isRead with zero duplicate jobs', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // Initial ingestion: message is unread
  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [createMockGraphMessage({ id: 'msg-read-update-1' })],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  const initialDoc = await SupportEmail.findOne({ graphMessageId: 'msg-read-update-1' }).lean();
  assert.equal(initialDoc.metadata.isRead, false);

  const initialJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(initialJobs, 1);

  // Subsequent delta: user in Outlook marks email as read (isRead: true)
  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          {
            id: 'msg-read-update-1',
            isRead: true,
            receivedDateTime: initialDoc.receivedDateTime.toISOString(),
            subject: initialDoc.subject
          }
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t2'
      }
    })
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=t1';
  const updateResult = await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  assert.equal(updateResult.duplicateCount, 1, 'Re-encountered email recognized as duplicate update');

  // Verify metadata.isRead was updated to true
  const updatedDoc = await SupportEmail.findOne({ graphMessageId: 'msg-read-update-1' }).lean();
  assert.equal(updatedDoc.metadata.isRead, true, 'metadata.isRead must update to true');

  // CRITICAL: Job count must remain 1 (NO duplicate jobs enqueued!)
  const finalJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(finalJobs, 1, 'CRITICAL: Read status change must NEVER enqueue duplicate jobs');
});

// 21. HTTP 410 / syncStateNotFound triggers clean rebaseline without reusing old cursor
test('recovery: syncStateNotFound triggers clean rebaseline without reusing old cursor', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = {
    mailbox,
    folder,
    deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=expired_resync_token',
    activationAt
  };

  let requests = [];
  const mockRequester = async (config) => {
    requests.push(config.url);
    if (config.url.includes('expired_resync_token')) {
      const err = new Error('The delta token has expired.');
      err.response = {
        status: 410,
        data: { error: { code: 'syncStateNotFound', message: 'The delta token has expired and a full sync must be performed.' } }
      };
      throw err;
    }

    if (config.url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'msg-after-resync' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=fresh_resync_token'
        }
      };
    }

    throw new Error(`Unexpected URL: ${config.url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const recoveryResult = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered'
  });

  assert.equal(recoveryResult.isRebaseline, true, 'Must identify as rebaseline');
  assert.equal(recoveryResult.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=fresh_resync_token');
  assert.equal(requests.length, 2, 'Request 1 failed delta -> Request 2 fresh unfiltered baseline');
  assert.ok(!requests[1].includes('expired_resync_token'), 'Expired delta token must NOT be reused');
});

// 22. Recovery handles nested innerError codes and preserves original selectFields
test('recovery: nested innerError code syncStateNotFound triggers clean rebaseline and preserves original selectFields', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const cursor = {
    mailbox,
    folder,
    deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=nested_expired_token',
    activationAt
  };

  let requests = [];
  const mockRequester = async (config) => {
    requests.push(config.url);
    if (config.url.includes('nested_expired_token')) {
      const err = new Error('Delta error');
      err.response = {
        status: 400, // Some Graph tenants return 400 with nested syncStateNotFound
        data: {
          error: {
            code: 'ErrorInvalidRequest',
            message: 'Sync state is invalid.',
            innerError: {
              code: 'syncStateNotFound',
              'request-id': 'req-nested-123'
            }
          }
        }
      };
      throw err;
    }

    if (config.url.includes('/messages/delta')) {
      return {
        status: 200,
        data: {
          value: [createMockGraphMessage({ id: 'msg-nested-resync' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=nested_fresh_token'
        }
      };
    }

    throw new Error(`Unexpected URL: ${config.url}`);
  };

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: mockRequester
  });

  const customSelect = 'id,receivedDateTime,subject,from,bodyPreview';
  const recoveryResult = await executeSyncPass({
    cursor,
    mailbox,
    folder,
    graphClient: client,
    baselineStrategy: 'unfiltered',
    selectFields: customSelect
  });

  assert.equal(recoveryResult.isRebaseline, true, 'Nested syncStateNotFound must trigger rebaseline');
  assert.equal(recoveryResult.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=nested_fresh_token');
  assert.equal(requests.length, 2);
  // Verify original selectFields was preserved in rebaseline query
  assert.ok(decodeURIComponent(requests[1]).includes('$select=id,receivedDateTime,subject,from,bodyPreview'), 'Original select fields must be preserved');
  assert.ok(!requests[1].includes('$filter='), 'Unfiltered baseline must not contain $filter');
});

// 23. Recovery: rebaseline after delta token invalidation produces zero duplicate processing jobs or tickets
test('recovery: rebaseline after delta token invalidation produces zero duplicate processing jobs or tickets', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // 1. Initial sync ingests 2 active messages
  const client1 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          createMockGraphMessage({ id: 'msg-persist-1', receivedDateTime: '2026-11-13T08:30:00.000Z' }),
          createMockGraphMessage({ id: 'msg-persist-2', receivedDateTime: '2026-11-13T08:45:00.000Z' })
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=valid_token_1'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  await executeSyncPass({ cursor, mailbox, folder, graphClient: client1, baselineStrategy: 'unfiltered' });

  const initialJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(initialJobs, 2, 'Initial baseline enqueued 2 processing jobs');

  // 2. Next sync encounters HTTP 410 and triggers rebaseline
  const client2 = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async (config) => {
      if (config.url.includes('valid_token_1')) {
        const err = new Error('Delta token expired');
        err.response = { status: 410, data: { error: { code: 'ErrorDeltaTokenExpired' } } };
        throw err;
      }
      // Rebaseline returns the same 2 messages plus 1 brand new message
      return {
        status: 200,
        data: {
          value: [
            createMockGraphMessage({ id: 'msg-persist-1', receivedDateTime: '2026-11-13T08:30:00.000Z' }),
            createMockGraphMessage({ id: 'msg-persist-2', receivedDateTime: '2026-11-13T08:45:00.000Z' }),
            createMockGraphMessage({ id: 'msg-persist-3', receivedDateTime: '2026-11-13T09:00:00.000Z' })
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=valid_token_2'
        }
      };
    }
  });

  cursor.deltaLink = 'https://graph.microsoft.com/v1.0/delta?$deltatoken=valid_token_1';
  const rebaseResult = await executeSyncPass({ cursor, mailbox, folder, graphClient: client2, baselineStrategy: 'unfiltered' });

  assert.equal(rebaseResult.isRebaseline, true);
  assert.equal(rebaseResult.duplicateCount, 2, 'Two previously ingested messages skipped idempotently');

  // CRITICAL: Job count must be exactly 3 (2 initial + 1 new; ZERO duplicates!)
  const totalJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(totalJobs, 3, 'CRITICAL: Rebaseline must never enqueue duplicate processing jobs for already ingested emails');
});

// 24. messageNormalizationService: normalizeGraphMessage handles missing, malformed, and valid @removed payloads explicitly
test('normalizeGraphMessage: explicit missing and malformed @removed reason handling', () => {
  const normValid = normalizeGraphMessage({ id: 'msg-v', '@removed': { reason: 'deleted' } });
  assert.equal(normValid.graphRemovalReason, 'deleted');
  assert.equal(normValid.isRemoved, true);
  assert.equal(normValid.inInbox, false);

  const normMissing = normalizeGraphMessage({ id: 'msg-m1', '@removed': {} });
  assert.equal(normMissing.graphRemovalReason, 'missing');
  assert.equal(normMissing.isRemoved, true);
  assert.equal(normMissing.inInbox, false);

  const normEmptyStr = normalizeGraphMessage({ id: 'msg-m2', '@removed': { reason: '   ' } });
  assert.equal(normEmptyStr.graphRemovalReason, 'missing');

  const normMalformedNull = normalizeGraphMessage({ id: 'msg-mf1', '@removed': { reason: null } });
  assert.equal(normMalformedNull.graphRemovalReason, 'malformed');

  const normMalformedBool = normalizeGraphMessage({ id: 'msg-mf2', '@removed': true });
  assert.equal(normMalformedBool.graphRemovalReason, 'malformed');

  const normMalformedNum = normalizeGraphMessage({ id: 'msg-mf3', '@removed': { reason: 123 } });
  assert.equal(normMalformedNum.graphRemovalReason, 'malformed');
});

// 25. Activation boundary: exact boundary timestamps, historical exclusion, and strict rejection of missing/malformed timestamps
test('activation boundary: exact boundary timestamps, historical exclusion, and strict rejection of missing/malformed timestamps', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T10:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // 1. Message received AT exact boundary (receivedDateTime === activationAt) -> New email
  const msgBoundary = createMockGraphMessage({
    id: 'msg-boundary-exact',
    receivedDateTime: '2026-11-13T10:00:00.000Z'
  });
  const resBoundary = await ingestEmailMessage({ graphMessage: msgBoundary, mailbox, folder });
  assert.equal(resBoundary.isHistorical, false, 'Exact boundary timestamp must be treated as new');

  // 2. Message received 1ms before boundary -> Historical email (must bypass queue)
  const msgHistorical = createMockGraphMessage({
    id: 'msg-boundary-before',
    receivedDateTime: new Date(activationAt.getTime() - 1).toISOString()
  });
  const resHistorical = await ingestEmailMessage({ graphMessage: msgHistorical, mailbox, folder });
  assert.equal(resHistorical.isHistorical, true, '1ms before boundary must be treated as historical');

  // 3. Message with missing receivedDateTime -> Must throw error and refuse silent processing
  const msgMissingTime = {
    id: 'msg-missing-time',
    subject: 'Missing timestamp email'
  };
  await assert.rejects(
    async () => {
      await ingestEmailMessage({ graphMessage: msgMissingTime, mailbox, folder });
    },
    { message: /Missing required receivedDateTime/ },
    'Missing receivedDateTime must throw error'
  );

  // 4. Message with malformed receivedDateTime -> Must throw error and refuse silent processing
  const msgMalformedTime = {
    id: 'msg-malformed-time',
    receivedDateTime: 'invalid-not-a-date',
    subject: 'Malformed timestamp email'
  };
  await assert.rejects(
    async () => {
      await ingestEmailMessage({ graphMessage: msgMalformedTime, mailbox, folder });
    },
    { message: /Malformed receivedDateTime/ },
    'Malformed receivedDateTime must throw error'
  );

  // Verify only 1 processing job was created (for msg-boundary-exact)
  const jobs = await SupportEmailProcessingJob.find().lean();
  assert.equal(jobs.length, 1, 'Only the active new message may be enqueued');
  assert.equal(String(jobs[0].emailId), String(resBoundary.email._id));
});

// 26. Message identity: message moved out of Inbox and returned with new ordinary Graph ID does not duplicate tickets
test('message identity: message moved out of Inbox and returned with new ordinary Graph ID does not duplicate tickets', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // 1. Initial arrival: Message M arrives in Inbox with original graphMessageId
  const initialMsg = createMockGraphMessage({
    id: 'msg-round-orig',
    internetMessageId: '<roundtrip-unique-123@guidexpert.com>',
    conversationId: 'conv-round-1'
  });
  const res1 = await ingestEmailMessage({ graphMessage: initialMsg, mailbox, folder });
  assert.equal(res1.isDuplicate, false);

  // Simulate ticket created for initial email
  const ticket = await SupportTicket.create({
    ticketNumber: 'TICK-ROUND-001',
    dedupeKey: 'conv:conv-round-1',
    primaryEmailId: res1.email._id,
    emailIds: [res1.email._id],
    conversationId: 'conv-round-1',
    status: 'open',
    category: 'general',
    priority: 'medium'
  });

  const jobsAfterInitial = await SupportEmailProcessingJob.countDocuments();
  assert.equal(jobsAfterInitial, 1, 'Initial message creates 1 job');

  // 2. Message M is moved out of Inbox -> Graph emits @removed for msg-round-orig
  const removeMsg = {
    id: 'msg-round-orig',
    '@removed': { reason: 'deleted' }
  };
  await ingestEmailMessage({ graphMessage: removeMsg, mailbox, folder });

  const emailAfterRemoval = await SupportEmail.findById(res1.email._id).lean();
  assert.equal(emailAfterRemoval.metadata.isRemoved, true);
  assert.equal(emailAfterRemoval.metadata.inInbox, false);

  // 3. User moves message M BACK into Inbox -> Exchange assigns a NEW ordinary graphMessageId,
  // but internetMessageId is identical!
  const returnedMsg = createMockGraphMessage({
    id: 'msg-round-new-graph-id', // New ordinary Graph ID from Exchange!
    internetMessageId: '<roundtrip-unique-123@guidexpert.com>', // Same RFC 5322 Message-ID
    conversationId: 'conv-round-1'
  });
  const resReturn = await ingestEmailMessage({ graphMessage: returnedMsg, mailbox, folder });

  // Result: caught by partial unique index on internetMessageId!
  assert.equal(resReturn.isDuplicate, true, 'Returned message recognized as duplicate via internetMessageId');

  // In MongoDB: inInbox state is restored to true without re-creating email
  const emailAfterReturn = await SupportEmail.findById(res1.email._id).lean();
  assert.equal(emailAfterReturn.metadata.inInbox, true, 'inInbox state must be restored to true');
  assert.equal(emailAfterReturn.metadata.isRemoved, false, 'isRemoved must be cleared to false');

  // CRITICAL: Job count and ticket count MUST REMAIN 1 (zero duplicates!)
  const totalJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(totalJobs, 1, 'CRITICAL: Returning email must NEVER create duplicate processing jobs');

  const totalTickets = await SupportTicket.countDocuments();
  assert.equal(totalTickets, 1, 'CRITICAL: Returning email must NEVER create duplicate support tickets');
});

// 27. Concurrency: concurrent ingestion requests for identical email resolve safely without duplicate tickets
test('concurrency: concurrent ingestion requests for identical email resolve safely without duplicate tickets', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const msgPayload = createMockGraphMessage({
    id: 'msg-concurrent-test',
    internetMessageId: '<concurrent-test@guidexpert.com>',
    conversationId: 'conv-concurrent'
  });

  // Execute two concurrent ingestion requests at the exact same instant
  const [resA, resB] = await Promise.all([
    ingestEmailMessage({ graphMessage: msgPayload, mailbox, folder }),
    ingestEmailMessage({ graphMessage: msgPayload, mailbox, folder })
  ]);

  // Exactly one must be new, and one must be duplicate
  const duplicates = [resA, resB].filter((r) => r.isDuplicate);
  const newIngested = [resA, resB].filter((r) => !r.isDuplicate);

  assert.equal(duplicates.length, 1, 'Exactly one concurrent call caught as duplicate');
  assert.equal(newIngested.length, 1, 'Exactly one concurrent call processed as new');

  // Database must hold exactly 1 email document and exactly 1 processing job
  const emailCount = await SupportEmail.countDocuments({ graphMessageId: 'msg-concurrent-test' });
  assert.equal(emailCount, 1, 'Zero duplicate SupportEmail documents in DB');

  const jobCount = await SupportEmailProcessingJob.countDocuments();
  assert.equal(jobCount, 1, 'Zero duplicate processing jobs enqueued');
});

// 28. Poison-message: one malformed message among valid messages is quarantined without blocking sync or advancing cursor prematurely
test('poison-message: one malformed message among valid messages is quarantined without blocking sync or advancing cursor prematurely', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          // 1. Valid email 1
          createMockGraphMessage({ id: 'msg-valid-1', receivedDateTime: '2026-11-13T09:00:00.000Z' }),
          // 2. Malformed email (invalid receivedDateTime timestamp)
          { id: 'msg-poison-1', receivedDateTime: 'invalid-not-a-date', subject: 'Poison Message' },
          // 3. Valid email 2
          createMockGraphMessage({ id: 'msg-valid-2', receivedDateTime: '2026-11-13T09:15:00.000Z' })
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=token-after-poison'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client, baselineStrategy: 'unfiltered' });

  // 1. Sync completed successfully and advanced the delta cursor
  assert.equal(result.nextDeltaLink, 'https://graph.microsoft.com/v1.0/delta?$deltatoken=token-after-poison');
  assert.equal(result.count, 2, 'Two valid messages ingested');
  assert.equal(result.quarantinedCount, 1, 'One malformed message quarantined');

  // 2. Check SupportEmail documents in database: valid messages exist, poison message does NOT
  const emails = await SupportEmail.find().lean();
  assert.equal(emails.length, 2, 'Zero SupportEmail documents created for poison message');
  const ids = emails.map((e) => e.graphMessageId);
  assert.ok(ids.includes('msg-valid-1'));
  assert.ok(ids.includes('msg-valid-2'));
  assert.ok(!ids.includes('msg-poison-1'), 'Poison message must NOT exist in SupportEmail collection');

  // 3. Queue jobs: exactly 2 processing jobs created for valid messages; ZERO for poison message
  const jobs = await SupportEmailProcessingJob.find().lean();
  assert.equal(jobs.length, 2, 'Exactly 2 jobs enqueued; ZERO for poison message');

  // 4. Check SupportEmailAuditLog: durable sanitized quarantine record exists
  const quarantineLog = await SupportEmailAuditLog.findOne({
    action: 'validation_quarantined',
    targetId: 'msg-poison-1'
  }).lean();
  assert.ok(quarantineLog, 'Quarantine record must be durably stored in SupportEmailAuditLog');
  assert.equal(quarantineLog.targetType, 'graph_message');
  assert.equal(quarantineLog.metadata.rawReceivedDateTime, 'invalid-not-a-date');
  assert.equal(quarantineLog.metadata.mailbox, mailbox);
  assert.ok(quarantineLog.metadata.reason.includes('receivedDateTime'));
});

// 29. Poison-message: multiple malformed messages in a page are all quarantined while valid messages ingest
test('poison-message: multiple malformed messages in a page are all quarantined while valid messages ingest', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const client = new GraphClient({
    authService: { getAccessToken: async () => 'token' },
    httpRequester: async () => ({
      status: 200,
      data: {
        value: [
          createMockGraphMessage({ id: 'msg-valid-multi-1' }),
          { id: 'msg-poison-m1', receivedDateTime: 'bad-1', subject: 'Poison 1' },
          { id: 'msg-poison-m2', subject: 'Poison 2 (missing timestamp)' },
          createMockGraphMessage({ id: 'msg-valid-multi-2' })
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=token-multi-poison'
      }
    })
  });

  const cursor = { mailbox, folder, deltaLink: null, activationAt };
  const result = await executeSyncPass({ cursor, mailbox, folder, graphClient: client, baselineStrategy: 'unfiltered' });

  assert.equal(result.count, 2, 'Two valid messages ingested');
  assert.equal(result.quarantinedCount, 2, 'Both malformed messages quarantined');

  const quarantineLogs = await SupportEmailAuditLog.find({ action: 'validation_quarantined' }).lean();
  assert.equal(quarantineLogs.length, 2, 'Exactly 2 quarantine audit logs created');
  const targetIds = quarantineLogs.map((l) => l.targetId);
  assert.ok(targetIds.includes('msg-poison-m1'));
  assert.ok(targetIds.includes('msg-poison-m2'));
});

// 30. Poison-message: crash after recording validation failure before cursor advancement retries idempotently without duplicate quarantine logs
test('poison-message: crash after recording validation failure before cursor advancement retries idempotently without duplicate quarantine logs', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const pageMessages = [
    createMockGraphMessage({ id: 'msg-valid-crash-1' }),
    { id: 'msg-poison-crash-1', receivedDateTime: 'corrupt-time', subject: 'Poison' }
  ];

  // 1. Worker 1 runs batch: records valid email and quarantines poison message, then crashes before saving cursor
  const batchRes1 = await ingestMessageBatch({
    messages: pageMessages,
    mailbox,
    folder,
    activationAt
  });
  assert.equal(batchRes1.ingestedCount, 1);
  assert.equal(batchRes1.quarantinedCount, 1);

  // Check audit log count
  assert.equal(await SupportEmailAuditLog.countDocuments({ action: 'validation_quarantined' }), 1);

  // 2. Next worker (or retry) encounters the exact same page messages
  const batchRes2 = await ingestMessageBatch({
    messages: pageMessages,
    mailbox,
    folder,
    activationAt
  });
  assert.equal(batchRes2.duplicateCount, 1, 'Valid email skipped as duplicate on replay');
  assert.equal(batchRes2.quarantinedCount, 1, 'Poison email re-quarantined cleanly');

  // CRITICAL: Replay must NOT create duplicate quarantine records in audit log
  const finalQuarantineCount = await SupportEmailAuditLog.countDocuments({ action: 'validation_quarantined' });
  assert.equal(finalQuarantineCount, 1, 'Replay of poison message must NEVER create duplicate quarantine logs');

  const finalJobCount = await SupportEmailProcessingJob.countDocuments();
  assert.equal(finalJobCount, 1, 'Job count remains exactly 1');
});

// 31. Poison-message: replay of the same invalid message does not create duplicate quarantine records
test('poison-message: replay of the same invalid message does not create duplicate quarantine records', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';

  const invalidMsg = { id: 'msg-repeat-invalid', receivedDateTime: 'not-a-date', subject: 'Repeated Invalid' };

  // Run quarantine twice directly
  const res1 = await quarantineInvalidMessage({
    graphMessage: invalidMsg,
    mailbox,
    folder,
    reason: 'Malformed date'
  });
  assert.equal(res1.isReplay, false, 'First run is not replay');

  const res2 = await quarantineInvalidMessage({
    graphMessage: invalidMsg,
    mailbox,
    folder,
    reason: 'Malformed date'
  });
  assert.equal(res2.isReplay, true, 'Second run is marked as replay');

  const count = await SupportEmailAuditLog.countDocuments({
    action: 'validation_quarantined',
    targetId: 'msg-repeat-invalid'
  });
  assert.equal(count, 1, 'Audit log contains exactly one quarantine document');
});

// 32. Poison-message: database failure while recording quarantine record aborts sync and prevents cursor advancement
test('poison-message: database failure while recording quarantine record aborts sync and prevents cursor advancement', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // Temporarily stub SupportEmailAuditLog.create to simulate DB failure
  const originalCreate = SupportEmailAuditLog.create;
  SupportEmailAuditLog.create = async () => {
    throw new Error('MongoNetworkTimeoutException: failed to write quarantine log');
  };

  try {
    const client = new GraphClient({
      authService: { getAccessToken: async () => 'token' },
      httpRequester: async () => ({
        status: 200,
        data: {
          value: [
            { id: 'msg-poison-db-fail', receivedDateTime: 'invalid-time', subject: 'Poison DB Fail' }
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=token-should-not-advance'
        }
      })
    });

    const cursor = { mailbox, folder, deltaLink: null, activationAt };

    // Sync pass must throw because the poison message could not be durably accounted for!
    await assert.rejects(
      async () => {
        await executeSyncPass({ cursor, mailbox, folder, graphClient: client, baselineStrategy: 'unfiltered' });
      },
      { message: /MongoNetworkTimeoutException/ },
      'Sync pass must reject if quarantine record cannot be saved durably'
    );

    // Cursor must NOT have advanced!
    assert.equal(cursor.deltaLink, null, 'Cursor deltaLink must NOT advance when durable quarantine fails');
  } finally {
    SupportEmailAuditLog.create = originalCreate;
  }
});

// 33. Deduplication: missing and empty internetMessageId values bypass partial unique index without collision
test('deduplication: missing and empty internetMessageId values bypass partial unique index without collision', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // Message 1: internetMessageId is null
  const msg1 = createMockGraphMessage({
    id: 'msg-no-mid-1',
    internetMessageId: null,
    receivedDateTime: '2026-11-13T09:00:00.000Z'
  });
  // Message 2: internetMessageId is empty string
  const msg2 = createMockGraphMessage({
    id: 'msg-no-mid-2',
    internetMessageId: '',
    receivedDateTime: '2026-11-13T09:05:00.000Z'
  });
  // Message 3: internetMessageId is whitespace only
  const msg3 = createMockGraphMessage({
    id: 'msg-no-mid-3',
    internetMessageId: '   ',
    receivedDateTime: '2026-11-13T09:10:00.000Z'
  });

  const res1 = await ingestEmailMessage({ graphMessage: msg1, mailbox, folder });
  const res2 = await ingestEmailMessage({ graphMessage: msg2, mailbox, folder });
  const res3 = await ingestEmailMessage({ graphMessage: msg3, mailbox, folder });

  assert.equal(res1.isDuplicate, false);
  assert.equal(res2.isDuplicate, false);
  assert.equal(res3.isDuplicate, false);

  const docs = await SupportEmail.find({ graphMessageId: { $in: ['msg-no-mid-1', 'msg-no-mid-2', 'msg-no-mid-3'] } }).lean();
  assert.equal(docs.length, 3, 'All 3 emails without internetMessageId must be ingested without collision');
  for (const doc of docs) {
    assert.equal(doc.internetMessageId, null, 'Normalized internetMessageId must be null');
  }
});

// 34. Deduplication: duplicate-key error 11000 from an unexpected index is strictly rethrown rather than assumed an email duplicate
test('deduplication: duplicate-key error 11000 from an unexpected index is strictly rethrown rather than assumed an email duplicate', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  const originalCreate = SupportEmail.create;
  SupportEmail.create = async () => {
    const err = new Error('E11000 duplicate key error collection: supportemails index: unexpected_custom_index_1 dup key: { customField: "foo" }');
    err.code = 11000;
    err.keyPattern = { customField: 1 };
    throw err;
  };

  try {
    const msg = createMockGraphMessage({ id: 'msg-unexpected-dup' });
    await assert.rejects(
      async () => {
        await ingestEmailMessage({ graphMessage: msg, mailbox, folder });
      },
      (err) => {
        assert.equal(err.code, 11000);
        assert.ok(err.keyPattern.customField === 1);
        return true;
      },
      'Unexpected 11000 error must be rethrown, NOT swallowed as email duplicate'
    );
  } finally {
    SupportEmail.create = originalCreate;
  }
});

// 35. Deduplication: concurrent ingestion of returning message with new Graph ID safely restores inInbox with zero duplicate jobs
test('deduplication: concurrent ingestion of returning message with new Graph ID safely restores inInbox with zero duplicate jobs', async () => {
  const mailbox = 'support@guidexpert.com';
  const folder = 'inbox';
  const activationAt = new Date('2026-11-13T08:00:00.000Z');

  await EmailIngestionPolicy.create({ mailbox, activationAt, enabled: true });

  // 1. Initial message arrives
  const initial = createMockGraphMessage({
    id: 'msg-initial-orig',
    internetMessageId: '<concurrent-return-test@guidexpert.com>'
  });
  const resInit = await ingestEmailMessage({ graphMessage: initial, mailbox, folder });
  assert.equal(resInit.isDuplicate, false);

  // Initial jobs = 1
  assert.equal(await SupportEmailProcessingJob.countDocuments(), 1);

  // 2. Email moved out of Inbox
  await ingestEmailMessage({
    graphMessage: { id: 'msg-initial-orig', '@removed': { reason: 'deleted' } },
    mailbox,
    folder
  });
  const docRemoved = await SupportEmail.findById(resInit.email._id).lean();
  assert.equal(docRemoved.metadata.inInbox, false);

  // 3. Email returned to Inbox: Two concurrent ingestion calls with NEW Graph ID but same internetMessageId
  const returningPayload = createMockGraphMessage({
    id: 'msg-new-graph-id-conc',
    internetMessageId: '<concurrent-return-test@guidexpert.com>'
  });

  const [resA, resB] = await Promise.all([
    ingestEmailMessage({ graphMessage: returningPayload, mailbox, folder }),
    ingestEmailMessage({ graphMessage: returningPayload, mailbox, folder })
  ]);

  // Both should recognize as duplicate via internetMessageId index
  assert.equal(resA.isDuplicate, true);
  assert.equal(resB.isDuplicate, true);

  // Document in DB has inInbox restored to true
  const docRestored = await SupportEmail.findById(resInit.email._id).lean();
  assert.equal(docRestored.metadata.inInbox, true);
  assert.equal(docRestored.metadata.isRemoved, false);

  // Exactly 1 email doc and 1 job in entire DB!
  const totalEmails = await SupportEmail.countDocuments();
  assert.equal(totalEmails, 1, 'Total SupportEmail documents remains exactly 1');

  const totalJobs = await SupportEmailProcessingJob.countDocuments();
  assert.equal(totalJobs, 1, 'Total processing jobs remains exactly 1; ZERO duplicate jobs');
});

