'use strict';

require('../config/mongooseSafety');
require('dotenv').config();

const mongoose = require('mongoose');
const { isLocalUri, describeUri } = require('../config/mongooseSafety');

// Import all support email models
const SupportEmail = require('../models/SupportEmail');
const SupportEmailAttachment = require('../models/SupportEmailAttachment');
const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');
const SupportEmailAiRun = require('../models/SupportEmailAiRun');
const SupportTicket = require('../models/SupportTicket');
const SupportTicketEvent = require('../models/SupportTicketEvent');
const SupportEmailAuditLog = require('../models/SupportEmailAuditLog');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const GraphSubscription = require('../models/GraphSubscription');
const GoogleSheetsSyncJob = require('../models/GoogleSheetsSyncJob');
const SupportEmailRun = require('../models/SupportEmailRun');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const SupportTicketCounter = require('../models/SupportTicketCounter');

/**
 * Proposed index plan for Phase 1 collections (Appendix A).
 */
const INDEX_PLAN = [
  {
    model: SupportEmail,
    collectionName: 'supportemails',
    indexes: [
      { key: { graphMessageId: 1 }, options: { unique: true, name: 'graphMessageId_1_unique' } },
      {
        key: { internetMessageId: 1 },
        options: {
          unique: true,
          partialFilterExpression: { internetMessageId: { $type: 'string', $gt: '' } },
          name: 'internetMessageId_1_unique_partial'
        }
      },
      { key: { receivedDateTime: -1 }, options: { name: 'receivedDateTime_-1' } },
      { key: { conversationId: 1, receivedDateTime: -1 }, options: { name: 'conversationId_1_receivedDateTime_-1' } },
      { key: { 'pipeline.state': 1, receivedDateTime: 1 }, options: { name: 'pipeline_state_1_receivedDateTime_1' } }
    ]
  },
  {
    model: SupportEmailAttachment,
    collectionName: 'supportemailattachments',
    indexes: [
      { key: { emailId: 1, graphAttachmentId: 1 }, options: { unique: true, name: 'emailId_1_graphAttachmentId_1_unique' } },
      { key: { emailId: 1, isInline: 1 }, options: { name: 'emailId_1_isInline_1' } },
      { key: { sha256: 1 }, options: { name: 'sha256_1' } }
    ]
  },
  {
    model: SupportEmailProcessingJob,
    collectionName: 'supportemailprocessingjobs',
    indexes: [
      { key: { emailId: 1, stage: 1 }, options: { unique: true, name: 'emailId_1_stage_1_unique' } },
      { key: { state: 1, nextAttemptAt: 1, priority: -1 }, options: { name: 'state_1_nextAttemptAt_1_priority_-1' } },
      { key: { leaseExpiresAt: 1 }, options: { name: 'leaseExpiresAt_1' } }
    ]
  },
  {
    model: SupportEmailAiRun,
    collectionName: 'supportemailairuns',
    indexes: [
      { key: { emailId: 1, createdAt: -1 }, options: { name: 'emailId_1_createdAt_-1' } },
      { key: { inputHash: 1, promptVersion: 1, stage: 1 }, options: { name: 'inputHash_1_promptVersion_1_stage_1' } }
    ]
  },
  {
    model: SupportTicket,
    collectionName: 'supporttickets',
    indexes: [
      { key: { ticketNumber: 1 }, options: { unique: true, name: 'ticketNumber_1_unique' } },
      { key: { dedupeKey: 1 }, options: { unique: true, name: 'dedupeKey_1_unique' } },
      { key: { status: 1, createdAt: -1 }, options: { name: 'status_1_createdAt_-1' } },
      { key: { assignedTo: 1, status: 1 }, options: { name: 'assignedTo_1_status_1' } },
      { key: { category: 1, createdAt: -1 }, options: { name: 'category_1_createdAt_-1' } }
    ]
  },
  {
    model: SupportTicketEvent,
    collectionName: 'supportticketevents',
    indexes: [
      { key: { ticketId: 1, createdAt: -1 }, options: { name: 'ticketId_1_createdAt_-1' } },
      { key: { type: 1, createdAt: -1 }, options: { name: 'type_1_createdAt_-1' } }
    ]
  },
  {
    model: SupportEmailAuditLog,
    collectionName: 'supportemailauditlogs',
    indexes: [
      { key: { createdAt: -1 }, options: { name: 'createdAt_-1' } },
      { key: { action: 1, createdAt: -1 }, options: { name: 'action_1_createdAt_-1' } },
      { key: { targetId: 1, createdAt: -1 }, options: { name: 'targetId_1_createdAt_-1' } },
      { key: { action: 1, targetType: 1, targetId: 1 }, options: { name: 'action_1_targetType_1_targetId_1' } }
    ]
  },
  {
    model: SupportEmailWebhookEvent,
    collectionName: 'supportemailwebhookevents',
    indexes: [
      { key: { dedupeKey: 1 }, options: { unique: true, name: 'dedupeKey_1_unique' } },
      { key: { receivedAt: -1 }, options: { name: 'receivedAt_-1' } },
      { key: { status: 1, receivedAt: 1 }, options: { name: 'status_1_receivedAt_1' } },
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'expiresAt_1_ttl' } }
    ]
  },
  {
    model: EmailSyncCursor,
    collectionName: 'emailsynccursors',
    indexes: [
      { key: { mailbox: 1, folder: 1 }, options: { unique: true, name: 'mailbox_1_folder_1_unique' } },
      { key: { syncStatus: 1, syncLeaseExpiresAt: 1 }, options: { name: 'syncStatus_1_syncLeaseExpiresAt_1' } },
      { key: { hasPendingSync: 1, syncStatus: 1, syncLeaseExpiresAt: 1 }, options: { name: 'hasPendingSync_1_syncStatus_1_syncLeaseExpiresAt_1' } }
    ]
  },
  {
    model: GraphSubscription,
    collectionName: 'graphsubscriptions',
    indexes: [
      { key: { subscriptionId: 1 }, options: { unique: true, name: 'subscriptionId_1_unique' } },
      { key: { expirationDateTime: 1 }, options: { name: 'expirationDateTime_1' } },
      { key: { mailbox: 1, status: 1 }, options: { name: 'mailbox_1_status_1' } }
    ]
  },
  {
    model: GoogleSheetsSyncJob,
    collectionName: 'googlesheetssyncjobs',
    indexes: [
      { key: { ticketId: 1, spreadsheetId: 1, tab: 1 }, options: { unique: true, name: 'ticketId_1_spreadsheetId_1_tab_1_unique' } },
      { key: { state: 1, nextAttemptAt: 1 }, options: { name: 'state_1_nextAttemptAt_1' } }
    ]
  },
  {
    model: SupportEmailRun,
    collectionName: 'supportemailruns',
    indexes: [
      { key: { runKey: 1, startedAt: -1 }, options: { name: 'runKey_1_startedAt_-1' } },
      { key: { startedAt: -1 }, options: { name: 'startedAt_-1' } }
    ]
  },
  {
    model: EmailIngestionPolicy,
    collectionName: 'emailingestionpolicies',
    indexes: [
      { key: { mailbox: 1 }, options: { unique: true, name: 'mailbox_1_unique' } }
    ]
  },
  {
    model: SupportTicketCounter,
    collectionName: 'supportticketcounters',
    indexes: [
      { key: { key: 1 }, options: { unique: true, name: 'key_1_unique' } }
    ]
  }
];

/**
 * Validates that execution environment is strictly non-production and local.
 */
function validateEnvironmentSafety(uri) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Safety Block] Refusing to run index migration in NODE_ENV=production');
  }

  const effectiveUri = uri || process.env.MONGODB_URI || '';
  if (!isLocalUri(effectiveUri)) {
    throw new Error(
      `[Safety Block] Refusing to run index migration against remote database (${describeUri(effectiveUri)}). Only localhost/127.0.0.1 or in-memory MongoDB is permitted.`
    );
  }
}

/**
 * Checks for duplicates before creating unique indexes.
 */
async function preflightDuplicateCheck(model, indexDef) {
  if (!indexDef.options || !indexDef.options.unique) return [];

  const keys = Object.keys(indexDef.key);
  const matchFilter = indexDef.options.partialFilterExpression || {};

  // For fields in key, ensure they exist and are non-null if not already matched
  for (const k of keys) {
    if (!matchFilter[k]) {
      matchFilter[k] = { $exists: true, $ne: null };
    }
  }

  const groupFields = {};
  for (const k of keys) {
    groupFields[k.replace(/\./g, '_')] = `$${k}`;
  }

  const pipeline = [
    { $match: matchFilter },
    { $group: { _id: groupFields, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 5 }
  ];

  try {
    const duplicates = await model.aggregate(pipeline);
    return duplicates;
  } catch (err) {
    // If collection does not exist yet, aggregation returns empty array
    return [];
  }
}

/**
 * Ensures Support Email indexes.
 *
 * @param {Object} options
 * @param {boolean} [options.execute=false] If false, runs dry-run only
 * @param {string} [options.uri] Optional database URI
 * @param {boolean} [options.silent=false] Suppress console logs
 * @returns {Promise<Object>} Execution report
 */
async function ensureSupportEmailIndexes(options = {}) {
  const execute = Boolean(options.execute);
  const uri = options.uri || process.env.MONGODB_URI;

  validateEnvironmentSafety(uri);

  const report = {
    mode: execute ? 'EXECUTE' : 'DRY-RUN',
    collectionsScanned: INDEX_PLAN.length,
    plannedIndexes: 0,
    createdIndexes: 0,
    existingIndexes: 0,
    duplicateErrors: [],
    details: []
  };

  if (!options.silent) {
    console.log(`[Index Migration] Mode: ${report.mode}`);
    console.log(`[Index Migration] Target: ${describeUri(uri)}`);
    console.log('----------------------------------------------------');
  }

  for (const entry of INDEX_PLAN) {
    const { model, collectionName, indexes } = entry;
    const collectionDetail = {
      collection: collectionName,
      model: model.modelName,
      planned: indexes.length,
      existing: 0,
      created: 0,
      actions: []
    };

    let existingIndexes = [];
    try {
      existingIndexes = await model.collection.indexes();
      collectionDetail.existing = existingIndexes.length;
      report.existingIndexes += existingIndexes.length;
    } catch (e) {
      // Collection may not exist yet
      collectionDetail.existing = 0;
    }

    const existingNames = new Set(existingIndexes.map((idx) => idx.name));
    const existingKeySignatures = new Set(existingIndexes.map((idx) => JSON.stringify(idx.key)));

    for (const idxDef of indexes) {
      report.plannedIndexes++;
      const idxName = idxDef.options?.name || Object.keys(idxDef.key).join('_');
      const keySignature = JSON.stringify(idxDef.key);
      const alreadyExists = existingNames.has(idxName) || existingKeySignatures.has(keySignature);

      if (alreadyExists) {
        collectionDetail.actions.push({ name: idxName, status: 'EXISTS', key: idxDef.key });
        continue;
      }

      // Preflight duplicate check for unique indexes
      if (idxDef.options?.unique) {
        const duplicates = await preflightDuplicateCheck(model, idxDef);
        if (duplicates.length > 0) {
          const errMsg = `Duplicate keys detected in ${collectionName} for unique index ${idxName} (${duplicates.length} duplicate group(s) detected)`;
          report.duplicateErrors.push(errMsg);
          collectionDetail.actions.push({ name: idxName, status: 'BLOCKED_DUPLICATE', error: errMsg });
          if (!options.silent) console.error(`  [ERROR] ${errMsg}`);
          continue;
        }
      }

      if (execute) {
        try {
          await model.collection.createIndexes([
            {
              key: idxDef.key,
              name: idxName,
              ...idxDef.options
            }
          ]);
          collectionDetail.created++;
          report.createdIndexes++;
          collectionDetail.actions.push({ name: idxName, status: 'CREATED', key: idxDef.key });
          if (!options.silent) console.log(`  [CREATED] ${collectionName}.${idxName}`);
        } catch (err) {
          collectionDetail.actions.push({ name: idxName, status: 'FAILED', error: err.message });
          if (!options.silent) console.error(`  [FAILED] ${collectionName}.${idxName}: ${err.message}`);
        }
      } else {
        collectionDetail.actions.push({ name: idxName, status: 'PLANNED', key: idxDef.key, options: idxDef.options });
        if (!options.silent) console.log(`  [PLANNED] ${collectionName}.${idxName} -> ${JSON.stringify(idxDef.key)}`);
      }
    }

    report.details.push(collectionDetail);
  }

  if (report.duplicateErrors.length > 0) {
    const err = new Error(`Index preflight failed with ${report.duplicateErrors.length} duplicate conflicts`);
    err.duplicateErrors = report.duplicateErrors;
    err.report = report;
    throw err;
  }

  return report;
}

// CLI runner
if (require.main === module) {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute') || args.includes('-x');

  (async () => {
    try {
      const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/guidexpert_dev';
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(uri);
      }
      const report = await ensureSupportEmailIndexes({ execute, uri });
      console.log('----------------------------------------------------');
      console.log(`[Index Migration Done] Mode: ${report.mode}, Planned: ${report.plannedIndexes}, Created: ${report.createdIndexes}`);
      await mongoose.disconnect();
      process.exit(0);
    } catch (err) {
      console.error('[Index Migration Error]', err.message);
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
      process.exit(1);
    }
  })();
}

module.exports = {
  ensureSupportEmailIndexes,
  validateEnvironmentSafety,
  preflightDuplicateCheck,
  INDEX_PLAN
};

