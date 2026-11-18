'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const { executeSyncPass } = require('../services/supportEmail/deltaSyncService');
const { reconcileMailbox } = require('../services/supportEmail/reconciliationService');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const { APPROVED_MAILBOX } = require('../services/supportEmail/mailboxScopeService');

before(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED;
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX;
});

after(async () => {
  await teardownTestDb();
});

test('sync refuses an unfiltered baseline and a missing activation before any Graph read', async () => {
  const calls = [];
  const graphClient = { async get(url) { calls.push(url); return { value: [] }; } };
  await assert.rejects(
    () => executeSyncPass({
      cursor: { deltaLink: null, activationAt: new Date('2026-11-18T00:00:00.000Z'), baselineStrategy: 'unfiltered' },
      mailbox: APPROVED_MAILBOX,
      graphClient,
      baselineStrategy: 'unfiltered'
    }),
    (error) => error.code === 'unsafe_unfiltered_baseline'
  );
  await assert.rejects(
    () => executeSyncPass({
      cursor: { deltaLink: null },
      mailbox: APPROVED_MAILBOX,
      graphClient
    }),
    (error) => error.code === 'activation_missing'
  );
  assert.equal(calls.length, 0);
});

test('reconciliation makes no Graph request when activation or mailbox scope is missing', async () => {
  const calls = [];
  const graphClient = { async get(url) { calls.push(String(url)); return { value: [] }; }, requests: calls };
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED = '1';
  process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX = APPROVED_MAILBOX;
  await EmailIngestionPolicy.collection.insertOne({ mailbox: APPROVED_MAILBOX, enabled: true, activationAt: null });
  const missingActivation = await reconcileMailbox({ mailbox: APPROVED_MAILBOX, graphClient });
  assert.equal(missingActivation.skipped, true);
  assert.equal(missingActivation.reason, 'activation_missing');

  await EmailIngestionPolicy.deleteMany({});
  delete process.env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED;
  await EmailIngestionPolicy.create({
    mailbox: APPROVED_MAILBOX,
    enabled: true,
    activationAt: new Date('2026-11-18T00:00:00.000Z')
  });
  const unverified = await reconcileMailbox({ mailbox: APPROVED_MAILBOX, graphClient });
  assert.equal(unverified.reason, 'MAILBOX_SCOPE_UNVERIFIED');
  assert.equal(calls.length, 0);
});
