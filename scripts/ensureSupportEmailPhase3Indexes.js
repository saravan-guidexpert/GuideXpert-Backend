'use strict';

/**
 * Phase 3 index migration.
 *
 * Adds the single-flight lock index used by the processing cron.
 * Dry-run unless --execute is passed. Refuses production and remote databases.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const SupportEmailRun = require('../models/SupportEmailRun');
const SupportEmailAttachment = require('../models/SupportEmailAttachment');
const { validateEnvironmentSafety } = require('./ensureSupportEmailIndexes');
const { sanitizeText } = require('../services/supportEmail/observability');

const LOCK_INDEX = {
  key: { runKey: 1 },
  options: {
    unique: true,
    partialFilterExpression: { activeLock: true },
    name: 'runKey_1_active_lock'
  }
};

const ATTACHMENT_CREATED_INDEX = {
  model: SupportEmailAttachment,
  key: { createdAt: 1 },
  options: { name: 'createdAt_1' }
};

async function ensureSupportEmailPhase3Indexes(options = {}) {
  const execute = Boolean(options.execute);
  const uri = options.uri || process.env.MONGODB_URI;
  validateEnvironmentSafety(uri);
  const planned = [
    { model: SupportEmailRun, ...LOCK_INDEX },
    ATTACHMENT_CREATED_INDEX
  ];
  const indexes = [];
  for (const plannedIndex of planned) {
    const existing = await plannedIndex.model.collection.indexes().catch(() => []);
    const already = existing.some((index) => index.name === plannedIndex.options.name);
    const status = already ? 'EXISTS' : (execute ? 'CREATED' : 'PLANNED');
    if (!already && execute) {
      await plannedIndex.model.collection.createIndex(plannedIndex.key, plannedIndex.options);
    }
    indexes.push({ name: plannedIndex.options.name, status });
  }
  return {
    mode: execute ? 'EXECUTE' : 'DRY-RUN',
    index: indexes[0].name,
    status: indexes[0].status,
    indexes
  };
}

if (require.main === module) {
  const execute = process.argv.includes('--execute') || process.argv.includes('-x');
  (async () => {
    try {
      const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/guidexpert_dev';
      if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
      const report = await ensureSupportEmailPhase3Indexes({ execute, uri });
      console.log(`[Phase 3 indexes] ${report.mode} ${report.index} ${report.status}`);
      await mongoose.disconnect();
      process.exit(0);
    } catch (err) {
      console.error('[Phase 3 indexes]', sanitizeText(err.message));
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
      process.exit(1);
    }
  })();
}

module.exports = {
  ensureSupportEmailPhase3Indexes,
  LOCK_INDEX
};
