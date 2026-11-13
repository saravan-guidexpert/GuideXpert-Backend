'use strict';

require('../../config/mongooseSafety');

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SupportEmail = require('../../models/SupportEmail');
const SupportEmailAttachment = require('../../models/SupportEmailAttachment');
const SupportEmailProcessingJob = require('../../models/SupportEmailProcessingJob');
const SupportEmailAiRun = require('../../models/SupportEmailAiRun');
const SupportTicket = require('../../models/SupportTicket');
const SupportTicketEvent = require('../../models/SupportTicketEvent');
const SupportEmailAuditLog = require('../../models/SupportEmailAuditLog');
const SupportEmailWebhookEvent = require('../../models/SupportEmailWebhookEvent');
const EmailSyncCursor = require('../../models/EmailSyncCursor');
const GraphSubscription = require('../../models/GraphSubscription');
const GoogleSheetsSyncJob = require('../../models/GoogleSheetsSyncJob');
const SupportEmailRun = require('../../models/SupportEmailRun');
const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const SupportTicketCounter = require('../../models/SupportTicketCounter');

const ALL_SUPPORT_MODELS = [
  SupportEmail,
  SupportEmailAttachment,
  SupportEmailProcessingJob,
  SupportEmailAiRun,
  SupportTicket,
  SupportTicketEvent,
  SupportEmailAuditLog,
  SupportEmailWebhookEvent,
  EmailSyncCursor,
  GraphSubscription,
  GoogleSheetsSyncJob,
  SupportEmailRun,
  EmailIngestionPolicy,
  SupportTicketCounter
];

let memoryServer = null;

async function setupTestDb() {
  if (mongoose.connection.readyState === 1) {
    await clearTestDb();
    return mongoose.connection;
  }

  memoryServer = await MongoMemoryServer.create();
  const uri = memoryServer.getUri();

  await mongoose.connect(uri, {
    dbName: 'guidexpert_support_email_test'
  });

  // Build indexes for all models
  await syncSupportEmailIndexes();
  return mongoose.connection;
}

async function syncSupportEmailIndexes() {
  for (const model of ALL_SUPPORT_MODELS) {
    try {
      await model.createIndexes();
    } catch (err) {
      // ignore if collection already has index
    }
  }
}

async function clearTestDb() {
  if (mongoose.connection.readyState !== 1) return;
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    try {
      await collections[key].deleteMany({});
    } catch (e) {
      // ignore
    }
  }
}

async function teardownTestDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

module.exports = {
  setupTestDb,
  clearTestDb,
  teardownTestDb,
  syncSupportEmailIndexes,
  ALL_SUPPORT_MODELS
};

