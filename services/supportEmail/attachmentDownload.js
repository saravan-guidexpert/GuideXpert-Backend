'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const TEMP_PREFIX = 'gx-se-';

class ByteCap extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.seen = 0;
  }

  _transform(chunk, encoding, callback) {
    this.seen += chunk.length;
    if (this.seen > this.maxBytes) {
      const error = new Error('file_too_large');
      error.code = 'file_too_large';
      callback(error);
      return;
    }
    callback(null, chunk);
  }
}

function tempFilePath() {
  return path.join(os.tmpdir(), `${TEMP_PREFIX}${crypto.randomBytes(12).toString('hex')}`);
}

async function removeTemp(filePath) {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => {});
}

async function openSource(gateway, mailbox, messageId, attachmentId, maxBytes) {
  if (typeof gateway.openAttachmentStream === 'function') {
    return gateway.openAttachmentStream(mailbox, messageId, attachmentId, { maxBytes });
  }
  const full = await gateway.getAttachment(mailbox, messageId, attachmentId);
  if (!full || typeof full.contentBytes !== 'string' || !full.contentBytes) return null;
  return Readable.from(Buffer.from(full.contentBytes, 'base64'));
}

/**
 * Downloads one attachment into a temp file and stops at the byte cap.
 * The temp file is removed on success and on failure.
 */
async function readBoundedAttachment({
  gateway,
  mailbox,
  messageId,
  attachmentId,
  declaredSize,
  maxBytes
}) {
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    return { ok: false, code: 'attachment_size_missing' };
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || declaredSize > maxBytes) {
    return { ok: false, code: 'file_too_large' };
  }

  const cap = Math.min(declaredSize, maxBytes);
  const filePath = tempFilePath();
  let source = null;
  try {
    source = await openSource(gateway, mailbox, messageId, attachmentId, cap);
    if (!source) return { ok: false, code: 'content_missing' };
    await pipeline(source, new ByteCap(cap), fs.createWriteStream(filePath));
    const stat = await fs.promises.stat(filePath);
    if (stat.size > cap) return { ok: false, code: 'file_too_large' };
    if (stat.size !== cap) return { ok: false, code: 'download_incomplete' };
    const buffer = await fs.promises.readFile(filePath);
    return { ok: true, buffer };
  } catch (error) {
    if (source && typeof source.destroy === 'function') source.destroy();
    return { ok: false, code: error && error.code === 'file_too_large' ? 'file_too_large' : 'download_failed' };
  } finally {
    await removeTemp(filePath);
  }
}

async function sweepTempFiles(maxAgeMs, now = Date.now(), execute = true) {
  const directory = await fs.promises.readdir(os.tmpdir());
  let removed = 0;
  const failed = [];
  for (const name of directory) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const filePath = path.join(os.tmpdir(), name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      if (!execute) {
        removed += 1;
        continue;
      }
      await fs.promises.unlink(filePath);
      removed += 1;
    } catch (error) {
      if (error && error.code !== 'ENOENT') failed.push({ code: 'temp_delete_failed' });
    }
  }
  return { removed, failed };
}

module.exports = {
  TEMP_PREFIX,
  readBoundedAttachment,
  sweepTempFiles,
  tempFilePath
};
