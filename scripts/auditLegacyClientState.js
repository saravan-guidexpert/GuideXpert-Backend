'use strict';

/**
 * READ-ONLY legacy `clientState` audit.
 *
 * Reports how many GraphSubscription documents still contain a plaintext `clientState` field.
 * This script performs only countDocuments/find reads. It never updates, deletes, or creates
 * indexes, and it intentionally emits only non-sensitive identifiers and status:
 *
 *   - document _id
 *   - subscriptionId
 *   - local status
 *   - whether a clientStateHash is present (boolean only)
 *
 * It NEVER outputs plaintext clientState, clientStateHash, tokens, mailbox addresses, or any
 * other secret. Safe remediation is a separate, administrator-reviewed procedure documented in
 * docs/support-email-automation/PHASE_2B_FINAL_SECURITY_REVIEW.md (§2.5).
 */

require('../config/mongooseSafety');
require('dotenv').config();

const mongoose = require('mongoose');
const GraphSubscription = require('../models/GraphSubscription');
const { describeUri } = require('../config/mongooseSafety');
const { sanitizeText } = require('../services/supportEmail/observability');

const LEGACY_FIELD = 'clientState';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Projects a raw MongoDB document onto the audit allow-list. Never spread the source document.
 *
 * @param {Object} doc Raw MongoDB document
 * @returns {{documentId: string|null, subscriptionId: string|null, status: string|null, hasClientStateHash: boolean}}
 */
function projectAuditDocument(doc) {
  return {
    documentId: doc && doc._id ? String(doc._id) : null,
    subscriptionId: doc && doc.subscriptionId ? String(doc.subscriptionId) : null,
    status: doc && doc.status ? String(doc.status) : null,
    hasClientStateHash: Boolean(
      doc && typeof doc.clientStateHash === 'string' && doc.clientStateHash.length > 0
    )
  };
}

/**
 * Audits legacy plaintext clientState fields. Read-only.
 *
 * @param {Object} [options]
 * @param {Object} [options.model] Mongoose model (defaults to GraphSubscription)
 * @param {number} [options.limit=100] Maximum documents to list (capped at 1000)
 * @returns {Promise<Object>} Privacy-safe audit report
 */
async function auditLegacyClientState({ model = GraphSubscription, limit = DEFAULT_LIMIT } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const collection = model.collection;
  const filter = { [LEGACY_FIELD]: { $exists: true, $ne: null } };

  const totalDocuments = await collection.countDocuments(filter);
  const docs = await collection
    .find(filter, {
      projection: { _id: 1, subscriptionId: 1, status: 1, clientStateHash: 1 }
    })
    .limit(safeLimit)
    .toArray();

  const documents = docs.map(projectAuditDocument);

  return {
    field: LEGACY_FIELD,
    totalDocuments,
    returnedDocuments: documents.length,
    truncated: totalDocuments > documents.length,
    documentsWithoutHash: documents.filter((doc) => !doc.hasClientStateHash).length,
    documents
  };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--uri=')) options.uri = arg.slice('--uri='.length);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--json') options.json = true;
  }
  return options;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const uri = args.uri || process.env.MONGODB_URI;

  (async () => {
    if (!uri) {
      console.error('[Legacy clientState audit] No database URI supplied. Use --uri=<uri> or MONGODB_URI.');
      process.exitCode = 1;
      return;
    }

    try {
      console.log(`[Legacy clientState audit] Target: ${describeUri(uri)} (READ-ONLY)`);
      await mongoose.connect(uri);
      const report = await auditLegacyClientState({ limit: args.limit });

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Documents containing plaintext "${report.field}": ${report.totalDocuments}`);
        console.log(`Listed: ${report.returnedDocuments} (truncated: ${report.truncated})`);
        console.log(`Listed without a clientStateHash: ${report.documentsWithoutHash}`);
        for (const doc of report.documents) {
          console.log(
            `- documentId=${doc.documentId} subscriptionId=${doc.subscriptionId || 'null'} ` +
            `status=${doc.status || 'null'} hasClientStateHash=${doc.hasClientStateHash}`
          );
        }
      }
      if (report.documentsWithoutHash > 0) {
        console.warn(
          '[Legacy clientState audit] Some legacy documents have no clientStateHash. ' +
          'Do NOT delete plaintext until the safe replacement procedure is complete.'
        );
      }
    } catch (err) {
      console.error('[Legacy clientState audit] Failed:', sanitizeText(err.message));
      process.exitCode = 1;
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  })();
}

module.exports = {
  LEGACY_FIELD,
  projectAuditDocument,
  auditLegacyClientState
};
