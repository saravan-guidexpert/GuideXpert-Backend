'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');

const SupportEmail = require('../models/SupportEmail');
const SupportEmailAttachment = require('../models/SupportEmailAttachment');
const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');
const SupportTicket = require('../models/SupportTicket');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const GoogleSheetsSyncJob = require('../models/GoogleSheetsSyncJob');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');

describe('supportEmail models & indexes', () => {
  before(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  test('SupportEmail rejects duplicate graphMessageId with unique index', async () => {
    await SupportEmail.create({
      graphMessageId: 'msg-unique-123',
      receivedDateTime: new Date()
    });

    await assert.rejects(
      async () => {
        await SupportEmail.create({
          graphMessageId: 'msg-unique-123',
          receivedDateTime: new Date()
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('SupportEmail partial unique index on internetMessageId allows nulls but rejects duplicate strings', async () => {
    // 1. Multiple emails with null/missing internetMessageId should succeed
    const email1 = await SupportEmail.create({
      graphMessageId: 'msg-null-1',
      internetMessageId: null,
      receivedDateTime: new Date()
    });
    const email2 = await SupportEmail.create({
      graphMessageId: 'msg-null-2',
      internetMessageId: null,
      receivedDateTime: new Date()
    });
    assert.ok(email1._id);
    assert.ok(email2._id);

    // 2. Email with valid internetMessageId succeeds
    await SupportEmail.create({
      graphMessageId: 'msg-with-id-1',
      internetMessageId: 'id-alpha@niatindia.com',
      receivedDateTime: new Date()
    });

    // 3. Second email with same non-empty internetMessageId is rejected with E11000
    await assert.rejects(
      async () => {
        await SupportEmail.create({
          graphMessageId: 'msg-with-id-2',
          internetMessageId: 'id-alpha@niatindia.com',
          receivedDateTime: new Date()
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('SupportEmailAttachment enforces unique { emailId, graphAttachmentId }', async () => {
    const emailId = new mongoose.Types.ObjectId();
    await SupportEmailAttachment.create({
      emailId,
      graphAttachmentId: 'att-1',
      name: 'file1.pdf',
      size: 1024
    });

    await assert.rejects(
      async () => {
        await SupportEmailAttachment.create({
          emailId,
          graphAttachmentId: 'att-1',
          name: 'duplicate_file.pdf',
          size: 2048
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('SupportEmailProcessingJob enforces unique { emailId, stage }', async () => {
    const emailId = new mongoose.Types.ObjectId();
    await SupportEmailProcessingJob.create({
      emailId,
      stage: 'fetch',
      state: 'pending'
    });

    await assert.rejects(
      async () => {
        await SupportEmailProcessingJob.create({
          emailId,
          stage: 'fetch',
          state: 'pending'
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );

    // Different stage for same emailId is allowed
    const attJob = await SupportEmailProcessingJob.create({
      emailId,
      stage: 'attachments',
      state: 'pending'
    });
    assert.ok(attJob._id);
  });

  test('SupportTicket enforces unique ticketNumber and dedupeKey', async () => {
    await SupportTicket.create({
      ticketNumber: 'GX-20261113-0001',
      dedupeKey: 'conv:conv-1',
      requester: { email: 'student@example.com' }
    });

    // Duplicate ticketNumber rejected
    await assert.rejects(
      async () => {
        await SupportTicket.create({
          ticketNumber: 'GX-20261113-0001',
          dedupeKey: 'conv:conv-2'
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );

    // Duplicate dedupeKey rejected
    await assert.rejects(
      async () => {
        await SupportTicket.create({
          ticketNumber: 'GX-20261113-0002',
          dedupeKey: 'conv:conv-1'
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('SupportEmailWebhookEvent enforces unique dedupeKey', async () => {
    await SupportEmailWebhookEvent.create({
      subscriptionId: 'sub-1',
      resource: 'Users/support@niatindia.com/Messages/123',
      changeType: 'created',
      dedupeKey: 'sub-1:Users/support@niatindia.com/Messages/123:created'
    });

    await assert.rejects(
      async () => {
        await SupportEmailWebhookEvent.create({
          subscriptionId: 'sub-1',
          resource: 'Users/support@niatindia.com/Messages/123',
          changeType: 'created',
          dedupeKey: 'sub-1:Users/support@niatindia.com/Messages/123:created'
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('EmailSyncCursor enforces unique { mailbox, folder }', async () => {
    await EmailSyncCursor.create({
      mailbox: 'support@niatindia.com',
      folder: 'inbox'
    });

    await assert.rejects(
      async () => {
        await EmailSyncCursor.create({
          mailbox: 'support@niatindia.com',
          folder: 'inbox'
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('GoogleSheetsSyncJob enforces unique { ticketId, spreadsheetId, tab }', async () => {
    const ticketId = new mongoose.Types.ObjectId();
    await GoogleSheetsSyncJob.create({
      ticketId,
      spreadsheetId: 'sheet-123',
      tab: 'Inbound'
    });

    await assert.rejects(
      async () => {
        await GoogleSheetsSyncJob.create({
          ticketId,
          spreadsheetId: 'sheet-123',
          tab: 'Inbound'
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('EmailIngestionPolicy enforces unique mailbox', async () => {
    await EmailIngestionPolicy.create({
      mailbox: 'support@niatindia.com',
      activationAt: new Date()
    });

    await assert.rejects(
      async () => {
        await EmailIngestionPolicy.create({
          mailbox: 'support@niatindia.com',
          activationAt: new Date()
        });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });
});

