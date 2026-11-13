'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeInternetMessageId,
  normalizeEmailAddress,
  buildWebhookDedupeKey,
  buildEmailDedupeKey,
  getTicketGroupingWindow,
  buildTicketDedupeKey,
  buildContentHash
} = require('../services/supportEmail/dedupeService');

describe('supportEmail dedupeService', () => {
  test('normalizeInternetMessageId strips angle brackets and whitespace', () => {
    assert.equal(
      normalizeInternetMessageId('  <message-12345@domain.com>  '),
      'message-12345@domain.com'
    );
    assert.equal(normalizeInternetMessageId('plain-id@domain.com'), 'plain-id@domain.com');
    assert.equal(normalizeInternetMessageId('<>'), null);
    assert.equal(normalizeInternetMessageId('   '), null);
    assert.equal(normalizeInternetMessageId(null), null);
    assert.equal(normalizeInternetMessageId(undefined), null);
  });

  test('normalizeEmailAddress trims and lowercases addresses', () => {
    assert.equal(normalizeEmailAddress('  STUDENT@NIATINDIA.COM '), 'student@niatindia.com');
    assert.equal(normalizeEmailAddress(''), '');
    assert.equal(normalizeEmailAddress(null), '');
  });

  test('buildWebhookDedupeKey creates deterministic compound keys and resolves message IDs', () => {
    const key = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/abc',
      changeType: 'created'
    });
    assert.equal(key, 'sub-xyz:Users/support@niatindia.com/Messages/abc:abc:created');

    assert.throws(() => {
      buildWebhookDedupeKey({ subscriptionId: 'sub-xyz' });
    });
  });

  test('repeated webhook notification for the same event generates identical dedupe key', () => {
    const delivery1 = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/msg-123',
      changeType: 'created',
      resourceId: 'msg-123'
    });

    const delivery2 = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/msg-123',
      changeType: 'created',
      resourceId: 'msg-123'
    });

    assert.equal(delivery1, delivery2, 'Repeated deliveries of the same event must match');
  });

  test('a legitimate later notification for the same resource is not suppressed', () => {
    // 1. Different changeType (e.g. updated vs created) generates distinct key
    const createdKey = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/msg-123',
      changeType: 'created',
      resourceId: 'msg-123'
    });

    const updatedKey = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/msg-123',
      changeType: 'updated',
      resourceId: 'msg-123'
    });

    assert.notEqual(createdKey, updatedKey, 'Different changeTypes for the same resource must have distinct keys');

    // 2. Folder subscription distinguishes messages via resourceId
    const folderKeyMsg1 = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: "Users/support@niatindia.com/mailFolders('inbox')/messages",
      changeType: 'created',
      resourceId: 'msg-111'
    });

    const folderKeyMsg2 = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: "Users/support@niatindia.com/mailFolders('inbox')/messages",
      changeType: 'created',
      resourceId: 'msg-222'
    });

    assert.notEqual(folderKeyMsg1, folderKeyMsg2, 'Different messages in folder subscription must have distinct keys');

    // 3. Time bucketed notifications for later delivery windows generate distinct keys
    const timeBucket1Key = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/msg-123',
      changeType: 'created',
      timeBucket: '20261113'
    });
    const timeBucket2Key = buildWebhookDedupeKey({
      subscriptionId: 'sub-xyz',
      resource: 'Users/support@niatindia.com/Messages/msg-123',
      changeType: 'created',
      timeBucket: '20261120'
    });
    assert.notEqual(timeBucket1Key, timeBucket2Key, 'Different time buckets must not suppress legitimate later events');
  });

  test('buildEmailDedupeKey prefers graphMessageId and falls back to normalized internetMessageId', () => {
    assert.equal(
      buildEmailDedupeKey('graph-id-1', '<msg-id-1@domain>'),
      'graph:graph-id-1'
    );
    assert.equal(
      buildEmailDedupeKey(null, '<msg-id-1@domain>'),
      'msgid:msg-id-1@domain'
    );
    assert.throws(() => {
      buildEmailDedupeKey(null, null);
    });
  });

  test('replies within one conversation are linked to the same ticket dedupe key', () => {
    const reply1 = buildTicketDedupeKey({
      conversationId: 'conv-abc-123',
      fromAddress: 'parent@example.com',
      subject: 'Admission Query'
    });

    const reply2 = buildTicketDedupeKey({
      conversationId: 'conv-abc-123',
      fromAddress: 'counselor@niatindia.com',
      subject: 'Re: Admission Query'
    });

    assert.equal(reply1, 'conv:conv-abc-123');
    assert.equal(reply2, 'conv:conv-abc-123');
    assert.equal(reply1, reply2, 'Replies in same conversation must share dedupe key');
  });

  test('different conversations are not accidentally merged even from same sender and subject', () => {
    const conv1 = buildTicketDedupeKey({
      conversationId: 'conv-111',
      fromAddress: 'student@example.com',
      subject: 'Fee Structure'
    });

    const conv2 = buildTicketDedupeKey({
      conversationId: 'conv-222',
      fromAddress: 'student@example.com',
      subject: 'Fee Structure'
    });

    assert.equal(conv1, 'conv:conv-111');
    assert.equal(conv2, 'conv:conv-222');
    assert.notEqual(conv1, conv2, 'Distinct conversations must never be merged');
  });

  test('two separate enquiries from the same sender with identical subjects outside grouping window are separated', () => {
    const day1 = new Date('2026-01-01T10:00:00Z');
    const day30 = new Date('2026-01-31T10:00:00Z');

    const enquiry1 = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Admission Query',
      receivedDateTime: day1,
      windowDays: 7
    });

    const enquiry2 = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Admission Query',
      receivedDateTime: day30,
      windowDays: 7
    });

    assert.notEqual(
      enquiry1,
      enquiry2,
      'Enquiries 30 days apart must not merge into the same ticket dedupe key'
    );
  });

  test('fixed 7-day epoch bucket behavior: dates immediately before and after boundary fall into adjacent buckets', () => {
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    // Epoch boundary at index 2960
    const boundaryTimeMs = windowMs * 2960;
    const justBefore = new Date(boundaryTimeMs - 1);
    const justAfter = new Date(boundaryTimeMs + 1);

    const windowBefore = getTicketGroupingWindow(justBefore, 7);
    const windowAfter = getTicketGroupingWindow(justAfter, 7);
    assert.equal(windowBefore, 2959);
    assert.equal(windowAfter, 2960);

    const keyBefore = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Scholarship',
      receivedDateTime: justBefore,
      windowDays: 7
    });

    const keyAfter = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Scholarship',
      receivedDateTime: justAfter,
      windowDays: 7
    });

    assert.notEqual(keyBefore, keyAfter, 'Dates across fixed bucket boundary must have different bucket keys');

    // Dates within the same fixed bucket share the exact same key
    const midBucket = new Date(boundaryTimeMs + 3600000); // 1 hour after boundary
    const laterInBucket = new Date(boundaryTimeMs + 86400000 * 3); // 3 days after boundary
    const keyMid = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Scholarship',
      receivedDateTime: midBucket,
      windowDays: 7
    });
    const keyLater = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Scholarship',
      receivedDateTime: laterInBucket,
      windowDays: 7
    });
    assert.equal(keyMid, keyLater, 'Dates within the same fixed bucket must share dedupe key');
  });

  test('webhook dedupe handles notifications without resourceData.id and extracts message IDs from various URL formats', () => {
    // 1. URL pattern /messages/{id}
    const key1 = buildWebhookDedupeKey({
      subscriptionId: 'sub-1',
      resource: 'Users/support@niatindia.com/messages/AAMkADk0-1',
      changeType: 'created'
    });
    assert.equal(key1, 'sub-1:Users/support@niatindia.com/messages/AAMkADk0-1:AAMkADk0-1:created');

    // 2. URL pattern with mailFolders /mailFolders('inbox')/messages/{id}
    const key2 = buildWebhookDedupeKey({
      subscriptionId: 'sub-1',
      resource: "Users/support@niatindia.com/mailFolders('inbox')/messages/AAMkADk0-2",
      changeType: 'created'
    });
    assert.equal(key2, "sub-1:Users/support@niatindia.com/mailFolders('inbox')/messages/AAMkADk0-2:AAMkADk0-2:created");

    // 3. URL pattern with query parameters
    const key3 = buildWebhookDedupeKey({
      subscriptionId: 'sub-1',
      resource: 'me/messages/AAMkADk0-3?$select=subject',
      changeType: 'created'
    });
    assert.equal(key3, 'sub-1:me/messages/AAMkADk0-3?$select=subject:AAMkADk0-3:created');

    // 4. Fallback when neither resourceId nor URL message ID is available
    // Does NOT invent a fake identifier; cleanly falls back to collection-level identifier
    const keyFallback = buildWebhookDedupeKey({
      subscriptionId: 'sub-1',
      resource: "Users/support@niatindia.com/mailFolders('inbox')/messages",
      changeType: 'created'
    });
    assert.equal(keyFallback, "sub-1:Users/support@niatindia.com/mailFolders('inbox')/messages::created");
  });

  test('enquiries from same sender with identical subjects within grouping window are merged', () => {
    const day1 = new Date('2026-01-01T10:00:00Z');
    const day2 = new Date('2026-01-02T10:00:00Z'); // within same 7-day window

    const enquiry1 = buildTicketDedupeKey({
      conversationId: null,
      fromAddress: 'student@example.com',
      subject: 'Admission Query',
      receivedDateTime: day1,
      windowDays: 7
    });

    const enquiry2 = buildTicketDedupeKey({
      conversationId: '',
      fromAddress: 'STUDENT@EXAMPLE.COM',
      subject: 'Re: Admission query',
      receivedDateTime: day2,
      windowDays: 7
    });

    assert.equal(enquiry1, enquiry2, 'Enquiries within 7-day window must merge');
  });

  test('buildContentHash computes stable SHA-256 digests', () => {
    const hash1 = buildContentHash({
      from: 'student@example.com',
      subject: 'Document Submission',
      bodyText: 'Please find attached marksheet.\nThank you.',
      attachmentShas: ['sha-b', 'sha-a']
    });

    const hash2 = buildContentHash({
      from: { address: 'STUDENT@EXAMPLE.COM' },
      subject: 'Re: document submission',
      bodyText: 'Please   find attached marksheet.  Thank you.',
      attachmentShas: ['sha-a', 'sha-b'] // sorted order
    });

    assert.equal(hash1, hash2, 'Normalized content and sorted attachment SHAs must produce identical hash');

    const hashDifferent = buildContentHash({
      from: 'student@example.com',
      subject: 'Document Submission',
      bodyText: 'Different body text',
      attachmentShas: ['sha-a']
    });
    assert.notEqual(hash1, hashDifferent);
  });
});
