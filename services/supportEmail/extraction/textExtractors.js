'use strict';

const { findEntry, xmlText } = require('../zipArchive');

function bounded(text, maxChars) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars || 100000);
}

function extractPdfText(buffer, limits = {}) {
  const raw = buffer.toString('latin1');
  const pageMarkers = raw.match(/\/Type\s*\/Page(?![s])/g);
  const pageCount = pageMarkers ? pageMarkers.length : 0;
  if (pageCount > (limits.maxPdfPages || 30)) {
    return { ok: false, code: 'too_many_pages', pageCount };
  }
  const parts = [];
  const pattern = /\(((?:\\.|[^\\)]){0,2000})\)/g;
  let match = pattern.exec(raw);
  while (match) {
    const decoded = match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    if (decoded.trim()) parts.push(decoded.trim());
    match = pattern.exec(raw);
  }
  const text = bounded(parts.join(' '), limits.maxExtractedChars);
  if (!text) return { ok: false, code: 'pdf_text_unavailable', pageCount };
  return { ok: true, text, pageCount };
}

function extractDocxText(entries, limits = {}) {
  const document = findEntry(entries, 'word/document.xml');
  if (!document) return { ok: false, code: 'docx_document_missing' };
  const text = bounded(xmlText(document.content.toString('utf8')), limits.maxExtractedChars);
  if (!text) return { ok: false, code: 'docx_text_unavailable' };
  return { ok: true, text, pageCount: null };
}

function extractXlsxText(entries, limits = {}) {
  const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name));
  const shared = findEntry(entries, 'xl/sharedStrings.xml');
  const chunks = [];
  if (shared) chunks.push(xmlText(shared.content.toString('utf8')));
  sheets.forEach((sheet) => chunks.push(xmlText(sheet.content.toString('utf8'))));
  const text = bounded(chunks.join(' '), limits.maxExtractedChars);
  if (!text) return { ok: false, code: 'xlsx_text_unavailable' };
  return { ok: true, text, pageCount: sheets.length || null };
}

/**
 * Images are stored, but the existing text LLM client cannot read pixels.
 * Text extraction stays unavailable unless a caller injects an extractor.
 */
function extractImageText() {
  return {
    ok: false,
    code: 'image_text_extraction_unavailable',
    missing: 'SUPPORT_EMAIL_IMAGE_TEXT_EXTRACTOR'
  };
}

function extractByKind({ kind, buffer, entries, limits, imageExtractor }) {
  if (kind === 'pdf') return extractPdfText(buffer, limits);
  if (kind === 'docx') return extractDocxText(entries || [], limits);
  if (kind === 'xlsx') return extractXlsxText(entries || [], limits);
  if (kind === 'png' || kind === 'jpeg') {
    if (typeof imageExtractor === 'function') return imageExtractor({ kind, buffer });
    return extractImageText();
  }
  return { ok: false, code: 'unsupported_kind' };
}

module.exports = {
  extractPdfText,
  extractDocxText,
  extractXlsxText,
  extractImageText,
  extractByKind
};
