'use strict';

/**
 * Install Answer Studio prompt indexes and backfill lifecycle / platform pointers.
 *
 * This does not run on server startup. Do not point it at a database unless
 * you intend to migrate that database.
 *
 *   node scripts/migrateAnswerStudioPromptIndexes.js --dry-run
 *   node scripts/migrateAnswerStudioPromptIndexes.js
 *
 * Existing rows without a lifecycle are classified once:
 *   active === true                      → active
 *   activatedAt or deactivatedAt present → inactive
 *   otherwise                            → draft
 * More than one active row for a platform, duplicate { key, version },
 * or duplicate platform-state rows stop the script. Nothing is deleted.
 *
 * Verify after a successful run:
 *   db.answerStudioPrompts.getIndexes()
 *   db.answerStudioPromptStates.getIndexes()
 * The prompt index must be unique on { key: 1, version: 1 }.
 * The state index must be unique on { platform: 1 }.
 */

const AnswerStudioPrompt = require('../models/AnswerStudioPrompt');
const AnswerStudioPromptState = require('../models/AnswerStudioPromptState');
const { sameKey } = require('../services/answerStudio/promptIndexes');

const PROMPT_INDEX = { key: 1, version: 1 };
const STATE_INDEX = { platform: 1 };
const PROMPT_INDEX_NAME = 'answerStudioPrompts_key_version';
const STATE_INDEX_NAME = 'answerStudioPromptStates_platform';

class MigrationStopped extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MigrationStopped';
    this.details = details;
  }
}

function classifyLegacyPrompt(doc) {
  if (doc.lifecycle === 'draft' || doc.lifecycle === 'active' || doc.lifecycle === 'inactive') {
    return doc.lifecycle;
  }
  if (doc.active === true) return 'active';
  if (doc.activatedAt || doc.deactivatedAt) return 'inactive';
  return 'draft';
}

async function duplicatePromptVersions() {
  return AnswerStudioPrompt.aggregate([
    { $group: { _id: { key: '$key', version: '$version' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
}

async function duplicateActivePrompts() {
  const rows = await AnswerStudioPrompt.find({}).select('key platform version active lifecycle activatedAt deactivatedAt').lean();
  const activeByPlatform = new Map();
  for (const row of rows) {
    if (classifyLegacyPrompt(row) !== 'active') continue;
    const list = activeByPlatform.get(row.platform) || [];
    list.push({ id: String(row._id), key: row.key, version: row.version });
    activeByPlatform.set(row.platform, list);
  }
  return [...activeByPlatform.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([platform, prompts]) => ({ platform, prompts }));
}

async function duplicateStates() {
  return AnswerStudioPromptState.aggregate([
    { $group: { _id: '$platform', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
}

function assertIndex(indexes, key, name) {
  const found = indexes.find((index) => sameKey(index.key, key));
  if (!found || found.unique !== true) {
    throw new MigrationStopped(`Index ${name} is missing or is not unique.`, { indexes });
  }
  return found;
}

async function backfillLifecycle(apply) {
  const rows = await AnswerStudioPrompt.find({
    $or: [{ lifecycle: { $exists: false } }, { lifecycle: null }],
  }).lean();
  const plan = rows.map((row) => ({ id: row._id, lifecycle: classifyLegacyPrompt(row) }));
  if (apply) {
    for (const item of plan) {
      await AnswerStudioPrompt.updateOne(
        { _id: item.id },
        { $set: { lifecycle: item.lifecycle, active: item.lifecycle === 'active' } }
      );
    }
  }
  return plan.length;
}

async function backfillStates(apply) {
  const prompts = await AnswerStudioPrompt.find({}).lean();
  const chosen = new Map();
  for (const row of prompts) {
    if (classifyLegacyPrompt(row) !== 'active') continue;
    if (chosen.has(row.platform)) {
      throw new MigrationStopped('Multiple active prompts remain for one platform.', {
        platform: row.platform,
      });
    }
    chosen.set(row.platform, row._id);
  }
  for (const platform of ['quora', 'reddit']) {
    const existing = await AnswerStudioPromptState.find({ platform }).lean();
    if (existing.length > 1) {
      throw new MigrationStopped('Duplicate prompt state documents.', {
        platform,
        ids: existing.map((row) => String(row._id)),
      });
    }
    const promptId = chosen.get(platform) || null;
    if (existing.length === 1) {
      const current = existing[0].activePromptId ? String(existing[0].activePromptId) : null;
      const expected = promptId ? String(promptId) : null;
      if (current !== expected) {
        throw new MigrationStopped('Existing prompt state does not match the active prompt.', {
          platform,
          stateId: String(existing[0]._id),
          activePromptId: current,
          expected,
        });
      }
      continue;
    }
    if (apply) {
      await AnswerStudioPromptState.create({
        platform,
        activePromptId: promptId,
        revision: promptId ? 1 : 0,
      });
    }
  }
}

async function ensureIndex(collection, key, name, apply) {
  const indexes = await collection.indexes();
  const found = indexes.find((index) => sameKey(index.key, key));
  if (found && found.unique === true) return found;
  if (found && found.unique !== true) {
    throw new MigrationStopped(`Index ${found.name} exists but is not unique.`, { name: found.name, key: found.key });
  }
  if (!apply) return null;
  await collection.createIndex(key, { unique: true, name });
  return assertIndex(await collection.indexes(), key, name);
}

async function migrateAnswerStudioPromptIndexes({ apply }) {
  const duplicateVersions = await duplicatePromptVersions();
  if (duplicateVersions.length) {
    throw new MigrationStopped('Duplicate prompt key and version rows exist.', {
      duplicates: duplicateVersions.map((row) => ({
        key: row._id.key,
        version: row._id.version,
        ids: row.ids.map(String),
      })),
    });
  }
  const duplicateActive = await duplicateActivePrompts();
  if (duplicateActive.length) {
    throw new MigrationStopped('Multiple active prompts exist for one platform.', {
      duplicates: duplicateActive,
    });
  }
  const states = await duplicateStates();
  if (states.length) {
    throw new MigrationStopped('Duplicate prompt state documents exist.', {
      duplicates: states.map((row) => ({ platform: row._id, ids: row.ids.map(String) })),
    });
  }

  const lifecycleUpdates = await backfillLifecycle(apply);
  await backfillStates(apply);
  const promptIndex = await ensureIndex(AnswerStudioPrompt.collection, PROMPT_INDEX, PROMPT_INDEX_NAME, apply);
  const stateIndex = await ensureIndex(AnswerStudioPromptState.collection, STATE_INDEX, STATE_INDEX_NAME, apply);
  if (apply) {
    assertIndex(await AnswerStudioPrompt.collection.indexes(), PROMPT_INDEX, PROMPT_INDEX_NAME);
    assertIndex(await AnswerStudioPromptState.collection.indexes(), STATE_INDEX, STATE_INDEX_NAME);
  }
  return { lifecycleUpdates, promptIndex, stateIndex, apply };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const connectDB = require('../config/db');
  await connectDB();
  try {
    const result = await migrateAnswerStudioPromptIndexes({ apply: !dryRun });
    console.log('[answer-studio] prompt index migration', dryRun ? 'dry-run' : 'applied', result);
    process.exit(0);
  } catch (error) {
    console.error('[answer-studio] prompt index migration stopped:', error.message);
    if (error.details) console.error(JSON.stringify(error.details, null, 2));
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[answer-studio] prompt index migration failed:', error);
    process.exit(1);
  });
}

module.exports = {
  classifyLegacyPrompt,
  migrateAnswerStudioPromptIndexes,
  MigrationStopped,
};
