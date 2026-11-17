'use strict';

const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');

const BUCKET_NAME = 'support_email_attachments';

function getBucket() {
  const db = mongoose.connection.db;
  if (!db) {
    const err = new Error('storage_unavailable');
    err.code = 'storage_unavailable';
    throw err;
  }
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

/**
 * Private GridFS bucket for support-email attachments.
 * This is separate from the student resource bucket and has no public URL.
 */
async function storeAttachment(buffer, metadata = {}) {
  const bucket = getBucket();
  return new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(metadata.filename || 'attachment', {
      metadata: {
        mimeType: metadata.mimeType || 'application/octet-stream',
        sha256: metadata.sha256 || null,
        emailId: metadata.emailId ? String(metadata.emailId) : null
      }
    });
    upload.on('error', (error) => {
      if (upload.id) bucket.delete(upload.id).catch(() => {});
      reject(error);
    });
    upload.on('finish', () => resolve(String(upload.id)));
    upload.end(buffer);
  });
}

async function deleteAttachment(storageKey) {
  if (!storageKey) return;
  const bucket = getBucket();
  try {
    await bucket.delete(new ObjectId(storageKey));
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.message !== 'FileNotFound') throw err;
  }
}

module.exports = {
  BUCKET_NAME,
  storeAttachment,
  deleteAttachment
};
