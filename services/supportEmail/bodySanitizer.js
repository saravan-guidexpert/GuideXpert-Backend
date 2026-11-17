'use strict';

const BLOCK_TAG = /<(script|style|iframe|object|embed|svg|link|meta|form|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'blockquote', 'a']);

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripDangerousMarkup(html) {
  let current = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  let previous;
  do {
    previous = current;
    current = current.replace(BLOCK_TAG, '');
  } while (current !== previous);
  return current
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '');
}

function toSafeSnippet(html) {
  return stripDangerousMarkup(html).replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (full, tag, attrs) => {
    const name = String(tag || '').toLowerCase();
    if (!ALLOWED.has(name)) return '';
    if (full.startsWith('</')) return `</${name}>`;
    if (name === 'br') return '<br>';
    if (name === 'a') {
      const href = /href\s*=\s*(['"])(https?:\/\/[^'"]+)\1/i.exec(attrs || '');
      return href ? `<a href="${href[2]}">` : '<a>';
    }
    return `<${name}>`;
  });
}

function htmlToText(html) {
  const source = stripDangerousMarkup(html)
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<\/blockquote>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(source)
    .replace(/\r\n|\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePlainText(text) {
  return decodeEntities(text)
    .replace(/\r\n|\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Produces bounded plain text and a sanitized HTML snippet.
 * Quoted conversation text is kept. Scripts, styles, and unsafe markup are removed.
 */
function sanitizeEmailBody({ content = '', contentType = 'text', maxText = 100000, maxHtml = 20000 } = {}) {
  const type = String(contentType || 'text').toLowerCase();
  const raw = String(content || '');
  if (type === 'html') {
    const text = htmlToText(raw).slice(0, maxText);
    const htmlSnippet = toSafeSnippet(raw).slice(0, maxHtml);
    return { text, htmlSnippet, contentType: 'html' };
  }
  return {
    text: normalizePlainText(raw).slice(0, maxText),
    htmlSnippet: '',
    contentType: 'text'
  };
}

module.exports = {
  sanitizeEmailBody,
  htmlToText,
  normalizePlainText
};
