'use strict';

const SupportEmailAttachment = require('../../models/SupportEmailAttachment');
const SupportEmailProcessingJob = require('../../models/SupportEmailProcessingJob');
const SupportTicket = require('../../models/SupportTicket');
const { deleteAttachment } = require('./attachmentStorage');
const { sweepTempFiles } = require('./attachmentDownload');
const { getProcessingConfig } = require('./processingConfig');
const { JOB_STATES } = require('../../constants/supportEmail');

const ACTIVE_JOB_STATES = [JOB_STATES.PENDING, JOB_STATES.CLAIMED, JOB_STATES.PROCESSING];
const INACTIVE_TICKET_STATUS = 'closed';

async function emailIsProtected(emailId) {
  const job = await SupportEmailProcessingJob.findOne({
    emailId,
    state: { $in: ACTIVE_JOB_STATES }
  }).select('_id').lean();
  if (job) return true;
  const activeTicket = await SupportTicket.findOne({
    emailIds: emailId,
    status: { $ne: INACTIVE_TICKET_STATUS }
  }).select('_id').lean();
  if (activeTicket) return true;
  const closedTicket = await SupportTicket.findOne({
    emailIds: emailId,
    status: INACTIVE_TICKET_STATUS
  }).select('_id').lean();
  return !closedTicket;
}

/**
 * Deletes expired attachment bytes and extracted text.
 * Closed tickets can expire. Open tickets, unresolved tickets, and live jobs cannot.
 * Mailbox messages are never deleted. A dry run only reports counts.
 */
async function runAttachmentRetention(options = {}) {
  const execute = options.execute === true;
  const now = options.now || new Date();
  const config = options.config || getProcessingConfig({ enabled: false });
  const binaryCutoff = new Date(now.getTime() - config.attachmentRetentionMs);
  const textCutoff = new Date(now.getTime() - config.extractedTextRetentionMs);
  const deadline = now.getTime() + Math.min(config.timeBudgetMs, 20000);
  const report = {
    execute,
    examined: 0,
    protected: 0,
    binaries: 0,
    texts: 0,
    documents: 0,
    tempFiles: 0,
    failed: []
  };

  const mutationBudget = config.retentionBatchSize;
  const scanBudget = Math.min(mutationBudget * 20, 500);
  let cursor = null;
  let mutations = 0;

  while (report.examined < scanBudget && mutations < mutationBudget && Date.now() < deadline) {
    const query = {
      createdAt: { $lte: binaryCutoff },
      $or: [
        { storageKey: { $type: 'string', $gt: '' } },
        { extractedText: { $type: 'string', $gt: '' } }
      ]
    };
    if (cursor) query._id = { $gt: cursor };
    const page = await SupportEmailAttachment.find(query)
      .sort({ _id: 1 })
      .limit(Math.min(50, scanBudget - report.examined))
      .lean();
    if (!page.length) break;

    for (const candidate of page) {
      cursor = candidate._id;
      if (Date.now() >= deadline || report.examined >= scanBudget || mutations >= mutationBudget) break;
      report.examined += 1;
      if (typeof options.beforeMutate === 'function') await options.beforeMutate(candidate);
      if (await emailIsProtected(candidate.emailId)) {
        report.protected += 1;
        continue;
      }

      const current = await SupportEmailAttachment.findById(candidate._id);
      if (!current) continue;
      if (typeof options.beforeDelete === 'function') await options.beforeDelete(current);
      if (await emailIsProtected(current.emailId)) {
        report.protected += 1;
        continue;
      }

      const binaryDue = Boolean(current.storageKey) && current.createdAt <= binaryCutoff;
      const textDue = Boolean(current.extractedText) && current.createdAt <= textCutoff;
      let binaryCleared = !current.storageKey;
      let mutated = false;

      if (binaryDue) {
        if (!execute) {
          report.binaries += 1;
          mutated = true;
        } else {
          try {
            await (options.deleteFile || deleteAttachment)(current.storageKey);
            current.storageKey = null;
            current.metadata = Object.assign({}, current.metadata, { binaryPurgedAt: now.toISOString() });
            current.markModified('metadata');
            await current.save();
            binaryCleared = true;
            report.binaries += 1;
            mutated = true;
          } catch (error) {
            report.failed.push({ code: error.code || 'binary_delete_failed' });
          }
        }
      }

      if (!execute && textDue) {
        report.texts += 1;
        mutated = true;
      }
      const binaryWouldGo = binaryCleared || (!execute && binaryDue);
      const textStillNeeded = Boolean(current.extractedText) && !textDue;
      if (binaryWouldGo && !textStillNeeded) {
        if (!execute) {
          report.documents += 1;
          mutated = true;
        } else if (await emailIsProtected(current.emailId)) {
          report.protected += 1;
        } else {
          try {
            await (options.deleteDocument || ((id) => SupportEmailAttachment.deleteOne({ _id: id })))(current._id);
            report.documents += 1;
            if (textDue) report.texts += 1;
            mutated = true;
          } catch (error) {
            report.failed.push({ code: error.code || 'document_delete_failed' });
          }
        }
      }
      if (mutated) mutations += 1;
    }
  }

  const temps = await sweepTempFiles(config.tempMaxAgeMs, now.getTime(), execute);
  report.tempFiles = temps.removed;
  report.failed.push(...temps.failed);
  return report;
}

module.exports = {
  runAttachmentRetention,
  emailIsProtected
};
