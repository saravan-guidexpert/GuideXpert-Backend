'use strict';

const path = require('path');
const { readZipEntries, findEntry } = require('./zipArchive');

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream'
]);

const REJECTED_EXTENSIONS = new Set([
  '.exe', '.dll', '.js', '.bat', '.cmd', '.scr', '.msi', '.com', '.html', '.htm',
  '.svg', '.zip', '.rar', '.7z', '.docm', '.xlsm', '.pptm', '.doc', '.xls'
]);

function extensionOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function startsWithHtml(buffer) {
  const head = buffer.slice(0, 256).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<svg') || head.startsWith('<script');
}

function isPdf(buffer) {
  return buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function isExecutable(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a;
}

function kindFromSignature(buffer, extension) {
  if (isExecutable(buffer)) return 'executable';
  if (isPdf(buffer)) return 'pdf';
  if (isPng(buffer)) return 'png';
  if (isJpeg(buffer)) return 'jpeg';
  if (startsWithHtml(buffer)) return extension === '.svg' || buffer.slice(0, 64).toString('utf8').toLowerCase().includes('<svg') ? 'svg' : 'html';
  if (isZip(buffer)) return 'zip';
  return 'unknown';
}

function officeKind(entries) {
  const types = findEntry(entries, '[Content_Types].xml');
  const text = types ? types.content.toString('utf8').toLowerCase() : '';
  if (text.includes('macroenabled') || text.includes('vbaproject')) return 'macro';
  if (text.includes('wordprocessingml.document.main+xml') || findEntry(entries, 'word/document.xml')) return 'docx';
  if (text.includes('spreadsheetml.sheet.main+xml') || findEntry(entries, 'xl/workbook.xml')) return 'xlsx';
  return 'archive';
}

/**
 * Validates an attachment from its declared type and file signature.
 * The buffer is untrusted. Rejection codes are safe to store and log.
 */
async function validateAttachment({ name, contentType, buffer, limits = {} }) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const extension = extensionOf(name);
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const maxBytes = limits.maxAttachmentBytes || (10 * 1024 * 1024);

  if (!bytes.length) return { ok: false, code: 'empty_file' };
  if (bytes.length > maxBytes) return { ok: false, code: 'file_too_large' };
  if (REJECTED_EXTENSIONS.has(extension)) return { ok: false, code: 'rejected_extension' };
  if (['text/html', 'image/svg+xml', 'application/x-msdownload', 'application/zip', 'application/x-7z-compressed', 'application/vnd.rar'].includes(mime)) {
    return { ok: false, code: 'rejected_mime' };
  }
  if (mime && !ALLOWED_MIME.has(mime)) return { ok: false, code: 'rejected_mime' };

  const signature = kindFromSignature(bytes, extension);
  if (signature === 'executable') return { ok: false, code: 'rejected_executable' };
  if (signature === 'html') return { ok: false, code: 'rejected_html' };
  if (signature === 'svg') return { ok: false, code: 'rejected_svg' };

  if (signature === 'pdf') {
    if (mime && mime !== 'application/pdf' && mime !== 'application/octet-stream') {
      return { ok: false, code: 'mime_signature_mismatch' };
    }
    return { ok: true, kind: 'pdf' };
  }
  if (signature === 'png' || signature === 'jpeg') {
    const expected = signature === 'png' ? 'image/png' : 'image/jpeg';
    if (mime && mime !== expected && mime !== 'application/octet-stream') {
      return { ok: false, code: 'mime_signature_mismatch' };
    }
    return { ok: true, kind: signature };
  }
  if (signature === 'zip') {
    const archive = await readZipEntries(bytes, limits);
    if (!archive.ok) {
      return { ok: false, code: archive.code === 'macro_content' ? 'rejected_macro' : archive.code };
    }
    const office = officeKind(archive.entries);
    if (office === 'macro') return { ok: false, code: 'rejected_macro' };
    if (office === 'docx') {
      if (extension && extension !== '.docx') return { ok: false, code: 'mime_signature_mismatch' };
      return { ok: true, kind: 'docx', entries: archive.entries };
    }
    if (office === 'xlsx') {
      if (extension && extension !== '.xlsx') return { ok: false, code: 'mime_signature_mismatch' };
      return { ok: true, kind: 'xlsx', entries: archive.entries };
    }
    return { ok: false, code: 'rejected_archive' };
  }

  return { ok: false, code: 'unrecognized_signature' };
}

module.exports = {
  validateAttachment
};
