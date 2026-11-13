'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');

const {
  ensureSupportEmailIndexes,
  validateEnvironmentSafety
} = require('../scripts/ensureSupportEmailIndexes');
const SupportEmail = require('../models/SupportEmail');

describe('ensureSupportEmailIndexes script', () => {
  before(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  test('validateEnvironmentSafety refuses NODE_ENV=production', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => {
          validateEnvironmentSafety('mongodb://127.0.0.1:27017/test');
        },
        /Refusing to run index migration in NODE_ENV=production/
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test('validateEnvironmentSafety refuses remote MongoDB URIs', () => {
    const remoteUris = [
      'mongodb+srv://admin:pass@guidexpert-prod.mongodb.net/guidexpert',
      'mongodb://atlas-host.internal:27017/prod',
      'mongodb://user:pass@192.168.1.50:27017/db'
    ];

    for (const uri of remoteUris) {
      assert.throws(
        () => {
          validateEnvironmentSafety(uri);
        },
        /Refusing to run index migration against remote database/
      );
    }
  });

  test('dry-run mode plans indexes without error and does not mutate without --execute', async () => {
    const uri = mongoose.connection.client.s.url || 'mongodb://127.0.0.1:27017/test';
    const report = await ensureSupportEmailIndexes({
      execute: false,
      uri,
      silent: true
    });

    assert.equal(report.mode, 'DRY-RUN');
    assert.ok(report.plannedIndexes > 20);
    assert.equal(report.createdIndexes, 0);
    assert.equal(report.duplicateErrors.length, 0);
  });

  test('preflight duplicate check catches existing duplicate keys and aborts index creation', async () => {
    const uri = mongoose.connection.client.s.url || 'mongodb://127.0.0.1:27017/test';

    // Drop indexes temporarily on supportemails to insert raw duplicates directly into MongoDB
    try {
      await SupportEmail.collection.dropIndexes();
    } catch (e) {
      // ignore
    }

    // Insert two documents with identical graphMessageId
    await SupportEmail.collection.insertMany([
      { graphMessageId: 'dup-id-123', receivedDateTime: new Date() },
      { graphMessageId: 'dup-id-123', receivedDateTime: new Date() }
    ]);

    await assert.rejects(
      async () => {
        await ensureSupportEmailIndexes({
          execute: true,
          uri,
          silent: true
        });
      },
      (err) => {
        assert.ok(err.message.includes('duplicate conflicts'));
        return true;
      }
    );
  });

  test('execution mode creates planned indexes on local database safely', async () => {
    const uri = mongoose.connection.client.s.url || 'mongodb://127.0.0.1:27017/test';
    const report = await ensureSupportEmailIndexes({
      execute: true,
      uri,
      silent: true
    });

    assert.equal(report.mode, 'EXECUTE');
    assert.ok(report.createdIndexes >= 0);
    assert.equal(report.duplicateErrors.length, 0);

    // Verify indexes exist on collection
    const emailIndexes = await SupportEmail.collection.indexes();
    const indexNames = emailIndexes.map((i) => i.name);
    assert.ok(indexNames.some((n) => n.includes('graphMessageId')));
  });
});
