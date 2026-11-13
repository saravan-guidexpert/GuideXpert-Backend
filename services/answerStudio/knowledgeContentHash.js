'use strict';

const crypto = require('crypto');

function normalizeFactualText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Hash of title and body only. Source, tags, and category are not part of the
 * fact, so two records are not duplicates just because they share a title.
 */
function knowledgeContentHash(title, body) {
  const payload = `${normalizeFactualText(title)}\n${normalizeFactualText(body)}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

module.exports = {
  normalizeFactualText,
  knowledgeContentHash,
};
