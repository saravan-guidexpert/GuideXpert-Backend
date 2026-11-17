'use strict';

const crypto = require('crypto');
const SupportEmailAttachment = require('../../models/SupportEmailAttachment');
const { validateAttachment } = require('./attachmentValidation');
const { extractByKind } = require('./extraction/textExtractors');
const { storeAttachment } = require('./attachmentStorage');
const { readBoundedAttachment } = require('./attachmentDownload');
const { createGraphGateway, loadEmail, setPipelineStage, codedError } = require('./bodyProcessingService');
const { STAGES } = require('../../constants/supportEmail');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function recordAttachment(email, remote, fields) {
  return SupportEmailAttachment.findOneAndUpdate(
    { emailId: email._id, graphAttachmentId: String(remote.id) },
    {
      $set: {
        name: String(remote.name || 'attachment').slice(0, 255),
        contentType: String(remote.contentType || 'application/octet-stream').slice(0, 128),
        size: Number(remote.size || fields.size || 0),
        isInline: Boolean(remote.isInline),
        ...fields
      },
      $setOnInsert: {
        emailId: email._id,
        graphAttachmentId: String(remote.id)
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Downloads allow-listed attachments, stores them privately, and extracts text.
 * A rejected or unreadable file is recorded and does not drop the email.
 */
async function processAttachments(emailId, deps = {}) {
  const email = await loadEmail(emailId);
  if (email.pipeline.attachments === 'extracted' || email.pipeline.attachments === 'partial') {
    return { enqueue: STAGES.AI, extracted: 0, failed: 0, alreadyDone: true };
  }
  if (!email.hasAttachments) {
    await setPipelineStage(email, STAGES.ATTACHMENTS, 'extracted');
    return { enqueue: STAGES.AI, extracted: 0, failed: 0 };
  }
  if (email.pipeline.attachments !== 'processing') {
    await setPipelineStage(email, STAGES.ATTACHMENTS, 'processing');
  }

  const mailbox = email.metadata && email.metadata.mailbox;
  if (!mailbox) throw codedError('mailbox_missing');
  const gateway = createGraphGateway(deps.graphClient);
  const listed = await gateway.listAttachments(mailbox, email.graphMessageId);
  const items = Array.isArray(listed && listed.value) ? listed.value : [];
  let usedBytes = 0;
  let extracted = 0;
  let failed = 0;

  for (const item of items) {
    if (!item || !item.id) continue;
    const existing = await SupportEmailAttachment.findOne({
      emailId: email._id,
      graphAttachmentId: String(item.id)
    }).lean();
    if (existing && existing.storageKey && ['extracted', 'unsupported'].includes(existing.extractStatus)) {
      usedBytes += Number(existing.size || 0);
      if (existing.extractStatus === 'extracted') extracted += 1;
      continue;
    }
    const declaredSize = Number(item.size);
    if (item.isInline && declaredSize > 0 && declaredSize < 2048) {
      await recordAttachment(email, item, { scanStatus: 'skipped', extractStatus: 'skipped', scanMessage: 'inline_tracking_pixel' });
      continue;
    }
    const room = deps.config.maxMessageAttachmentBytes - usedBytes;
    const downloaded = await readBoundedAttachment({
      gateway,
      mailbox,
      messageId: email.graphMessageId,
      attachmentId: item.id,
      declaredSize,
      maxBytes: Math.min(deps.config.maxAttachmentBytes, room)
    });
    if (!downloaded.ok) {
      if (downloaded.code === 'download_failed' || downloaded.code === 'download_incomplete') {
        throw codedError(downloaded.code);
      }
      await recordAttachment(email, item, {
        scanStatus: downloaded.code === 'content_missing' ? 'failed' : 'flagged',
        extractStatus: downloaded.code === 'content_missing' ? 'failed' : 'skipped',
        scanMessage: downloaded.code,
        extractError: downloaded.code === 'content_missing' ? downloaded.code : null,
        size: Number.isFinite(declaredSize) ? declaredSize : 0
      });
      failed += 1;
      continue;
    }
    const bytes = downloaded.buffer;
    usedBytes += bytes.length;
    let verdict;
    try {
      verdict = await validateAttachment({
        name: item.name,
        contentType: item.contentType,
        buffer: bytes,
        limits: deps.config
      });
    } catch (error) {
      await recordAttachment(email, item, {
        size: bytes.length,
        scanStatus: 'failed',
        extractStatus: 'failed',
        extractError: 'zip_read_failed'
      });
      failed += 1;
      continue;
    }
    if (!verdict.ok) {
      await recordAttachment(email, item, {
        size: bytes.length,
        sha256: sha256(bytes),
        scanStatus: 'flagged',
        extractStatus: 'skipped',
        scanMessage: verdict.code
      });
      failed += 1;
      continue;
    }

    const digest = sha256(bytes);
    const extractedText = extractByKind({
      kind: verdict.kind,
      buffer: bytes,
      entries: verdict.entries,
      limits: deps.config
    });
    let storageKey = null;
    try {
      storageKey = await storeAttachment(bytes, {
        filename: digest,
        mimeType: item.contentType,
        sha256: digest,
        emailId: email._id
      });
    } catch (err) {
      await recordAttachment(email, item, {
        size: bytes.length,
        sha256: digest,
        scanStatus: 'clean',
        extractStatus: 'failed',
        extractError: 'storage_unavailable'
      });
      failed += 1;
      continue;
    }

    await recordAttachment(email, item, {
      size: bytes.length,
      sha256: digest,
      storageKey,
      scanStatus: 'clean',
      extractStatus: extractedText.ok ? 'extracted' : (extractedText.code === 'image_text_extraction_unavailable' ? 'unsupported' : 'failed'),
      extractError: extractedText.ok ? null : extractedText.code,
      extractedText: extractedText.ok ? extractedText.text : null,
      pageCount: extractedText.pageCount || null
    });
    if (extractedText.ok) extracted += 1;
    else failed += 1;
  }

  const fresh = await loadEmail(emailId);
  const terminal = failed > 0 ? 'partial' : 'extracted';
  if (fresh.pipeline.attachments === 'processing' || fresh.pipeline.attachments === 'pending') {
    await setPipelineStage(fresh, STAGES.ATTACHMENTS, terminal);
  }
  fresh.attachmentCount = items.length;
  await fresh.save();
  return { enqueue: STAGES.AI, extracted, failed };
}

module.exports = {
  processAttachments
};
