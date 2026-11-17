'use strict';

const zlib = require('zlib');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_HEADER = 0x06054b50;
const ZIP64_END_HEADER = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;

function unsafeEntryName(name) {
  if (!name || name.includes('\0')) return true;
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return true;
  const parts = name.split(/[/\\]/).filter(Boolean);
  if (!parts.length || parts.length > 6) return true;
  return parts.some((part) => part === '..' || part === '.');
}

function nestedArchive(content) {
  return content.length >= 4
    && content[0] === 0x50
    && content[1] === 0x4b
    && content[2] === 0x03
    && content[3] === 0x04;
}

function inflateBounded(data, maxOutput) {
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(data, { maxOutputLength: maxOutput }, (error, result) => {
      if (!error) {
        resolve(result);
        return;
      }
      if (error.code !== 'ERR_BUFFER_TOO_LARGE') {
        zlib.inflate(data, { maxOutputLength: maxOutput }, (wrappedError, wrapped) => {
          if (wrappedError) reject(wrappedError);
          else resolve(wrapped);
        });
        return;
      }
      reject(error);
    });
  });
}

function fail(code) {
  return { ok: false, code };
}

function readUint64(buffer, offset) {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  if (high !== 0 || low > Number.MAX_SAFE_INTEGER) return null;
  return low;
}

/**
 * ZIP64 extra fields are read only to locate a compressed slice that already
 * fits in the downloaded buffer. The uncompressed size is ignored.
 */
function signatureBuffer(signature) {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(signature);
  return needle;
}

const LOCAL_SIGNATURE = signatureBuffer(LOCAL_HEADER);

function readZip64Sizes(extra, needUncompressed, needCompressed, needOffset) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const start = offset + 4;
    if (start + size > extra.length) return null;
    if (id === ZIP64_EXTRA) {
      let cursor = start;
      const end = start + size;
      if (needUncompressed) {
        if (cursor + 8 > end) return null;
        cursor += 8;
      }
      let compressedSize = null;
      if (needCompressed) {
        if (cursor + 8 > end) return null;
        compressedSize = readUint64(extra, cursor);
        if (compressedSize == null) return null;
        cursor += 8;
      }
      let localOffset = null;
      if (needOffset) {
        if (cursor + 8 > end) return null;
        localOffset = readUint64(extra, cursor);
        if (localOffset == null) return null;
      }
      return { compressedSize, localOffset };
    }
    offset = start + size;
  }
  return null;
}

function findEocd(source) {
  if (source.length < 22) return -1;
  const start = Math.max(0, source.length - (22 + 65535));
  for (let offset = source.length - 22; offset >= start; offset -= 1) {
    if (source.readUInt32LE(offset) !== END_HEADER) continue;
    const commentLength = source.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === source.length) return offset;
  }
  return -1;
}

function locateCentralDirectory(source) {
  const eocd = findEocd(source);
  if (eocd < 0) return fail('zip_header_invalid');
  const disk = source.readUInt16LE(eocd + 4);
  const startDisk = source.readUInt16LE(eocd + 6);
  if (disk !== 0 || startDisk !== 0) return fail('zip_spanned_unsupported');

  let entryCount = source.readUInt16LE(eocd + 10);
  let centralSize = source.readUInt32LE(eocd + 12);
  let centralOffset = source.readUInt32LE(eocd + 16);
  const needsZip64 = entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (!needsZip64) return { ok: true, entryCount, centralSize, centralOffset };

  if (eocd < 20 || source.readUInt32LE(eocd - 20) !== ZIP64_LOCATOR) return fail('zip64_unsupported');
  const zip64Offset = readUint64(source, eocd - 12);
  if (zip64Offset == null || zip64Offset + 56 > source.length) return fail('zip64_unsupported');
  if (source.readUInt32LE(zip64Offset) !== ZIP64_END_HEADER) return fail('zip64_unsupported');
  entryCount = readUint64(source, zip64Offset + 32);
  centralSize = readUint64(source, zip64Offset + 40);
  centralOffset = readUint64(source, zip64Offset + 48);
  if (entryCount == null || centralSize == null || centralOffset == null) return fail('zip64_unsupported');
  return { ok: true, entryCount, centralSize, centralOffset };
}

/**
 * Reads a ZIP archive from its central directory.
 * Local sizes are not trusted: streaming DOCX/XLSX writers leave them zero
 * and append a data descriptor. Inflation stays asynchronous and capped.
 */
async function readZipEntries(buffer, limits = {}) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const maxEntries = limits.maxZipEntries || 100;
  const perEntryCap = limits.maxZipEntryBytes || (8 * 1024 * 1024);
  const aggregateCap = limits.maxZipUncompressedBytes || (20 * 1024 * 1024);
  const ratio = limits.maxZipCompressionRatio || 100;
  const located = locateCentralDirectory(source);
  if (!located.ok) return located;
  if (located.centralOffset > source.length || located.centralSize > source.length - located.centralOffset) {
    return fail('zip_truncated');
  }

  const centralEnd = located.centralOffset + located.centralSize;
  const listed = [];
  let cursor = located.centralOffset;
  while (cursor + 46 <= centralEnd) {
    if (source.readUInt32LE(cursor) !== CENTRAL_HEADER) return fail('zip_header_invalid');
    if (listed.length >= maxEntries) return fail('too_many_zip_entries');
    const flags = source.readUInt16LE(cursor + 8);
    const method = source.readUInt16LE(cursor + 10);
    let compressedSize = source.readUInt32LE(cursor + 20);
    const uncompressedField = source.readUInt32LE(cursor + 24);
    const nameLength = source.readUInt16LE(cursor + 28);
    const extraLength = source.readUInt16LE(cursor + 30);
    const commentLength = source.readUInt16LE(cursor + 32);
    let localOffset = source.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (nameLength <= 0 || next > centralEnd) return fail('zip_truncated');
    const name = source.slice(nameStart, nameStart + nameLength).toString('utf8');
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const zip64 = readZip64Sizes(
        source.slice(extraStart, extraStart + extraLength),
        uncompressedField === 0xffffffff,
        compressedSize === 0xffffffff,
        localOffset === 0xffffffff
      );
      if (!zip64) return fail('zip64_unsupported');
      if (compressedSize === 0xffffffff) compressedSize = zip64.compressedSize;
      if (localOffset === 0xffffffff) localOffset = zip64.localOffset;
    }
    if (!Number.isSafeInteger(compressedSize) || compressedSize < 0 || compressedSize > source.length) {
      return fail('zip64_unsupported');
    }
    if (!Number.isSafeInteger(localOffset) || localOffset < 0 || localOffset > source.length) {
      return fail('zip_truncated');
    }
    listed.push({ name, flags, method, compressedSize, localOffset });
    cursor = next;
  }
  if (cursor !== centralEnd || listed.length !== located.entryCount) return fail('zip_header_invalid');
  if (!listed.length) return fail('zip_entries_missing');

  const ordered = listed.slice().sort((left, right) => left.localOffset - right.localOffset);
  const entries = [];
  let totalUncompressed = 0;
  let previousEnd = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const lower = entry.name.toLowerCase();
    if (entry.flags & 0x1) return fail('zip_encrypted');
    if (unsafeEntryName(entry.name)) return fail('unsafe_path');
    if (lower.includes('vbaproject') || lower.includes('macros/')) return fail('macro_content');
    if (entry.method !== 0 && entry.method !== 8) return fail('zip_method_unsupported');
    if (entry.localOffset + 30 > source.length || source.readUInt32LE(entry.localOffset) !== LOCAL_HEADER) {
      return fail('zip_header_invalid');
    }
    const localFlags = source.readUInt16LE(entry.localOffset + 6);
    const localMethod = source.readUInt16LE(entry.localOffset + 8);
    const localCompressed = source.readUInt32LE(entry.localOffset + 18);
    const localNameLength = source.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = source.readUInt16LE(entry.localOffset + 28);
    if (localMethod !== entry.method) return fail('zip_header_invalid');
    if ((localFlags & 0x8) === 0 && localCompressed !== entry.compressedSize) return fail('zip_size_mismatch');
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart < previousEnd || dataStart + entry.compressedSize > source.length) return fail('zip_truncated');
    const nextBoundary = index + 1 < ordered.length ? ordered[index + 1].localOffset : located.centralOffset;
    if (nextBoundary < dataStart + entry.compressedSize) return fail('zip_truncated');
    if (source.slice(dataStart + entry.compressedSize, nextBoundary).includes(LOCAL_SIGNATURE)) {
      return fail('zip_header_invalid');
    }
    previousEnd = dataStart + entry.compressedSize;

    if (entry.name.endsWith('/')) continue;
    const compressed = source.slice(dataStart, dataStart + entry.compressedSize);
    const remaining = aggregateCap - totalUncompressed;
    if (remaining <= 0) return fail('zip_uncompressed_too_large');

    let content;
    if (compressed.length === 0) {
      content = Buffer.alloc(0);
    } else {
      const ratioCap = compressed.length * ratio;
      const allowed = Math.min(perEntryCap, remaining, ratioCap);
      if (allowed <= 0) return fail('zip_compression_ratio');
      if (entry.method === 0) {
        if (compressed.length > allowed) {
          return fail(compressed.length > ratioCap ? 'zip_compression_ratio' : 'zip_uncompressed_too_large');
        }
        content = compressed;
      } else {
        try {
          content = await inflateBounded(compressed, allowed);
        } catch (error) {
          if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
            return fail(ratioCap <= Math.min(perEntryCap, remaining) ? 'zip_compression_ratio' : 'zip_uncompressed_too_large');
          }
          return fail('zip_inflate_failed');
        }
      }
      if (!content || content.length > allowed) return fail('zip_uncompressed_too_large');
    }

    if (nestedArchive(content)) return fail('nested_archive');
    totalUncompressed += content.length;
    if (totalUncompressed > aggregateCap) return fail('zip_uncompressed_too_large');
    entries.push({ name: entry.name, content });
  }

  if (!entries.length) return fail('zip_entries_missing');
  return { ok: true, entries };
}

function findEntry(entries, name) {
  const target = name.toLowerCase();
  return entries.find((entry) => entry.name.toLowerCase() === target) || null;
}

function xmlText(xml) {
  return String(xml || '')
    .replace(/<w:p\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  readZipEntries,
  findEntry,
  xmlText
};
