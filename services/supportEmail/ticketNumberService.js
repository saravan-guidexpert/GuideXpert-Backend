'use strict';

const SupportTicketCounter = require('../../models/SupportTicketCounter');

/**
 * Design Justification for Ticket Number Generation:
 *
 * 1. Human Usability:
 *    Support tickets interact with students, parents, and counselors over email,
 *    phone, and WhatsApp. Requiring users to reference 24-character hexadecimal
 *    Mongo ObjectIds (`67347a8c4f92bc31f9994c20`) causes high transcription error
 *    and frustration. A structured format `GX-YYYYMMDD-XXXX` is memorable and clear.
 *
 * 2. Cross-System Keying:
 *    Google Sheets projections, admin exports, and CRM logs use human-readable ticket
 *    numbers as the visible identifier while MongoDB preserves the immutable `_id`.
 *
 * 3. Race-Free Concurrency:
 *    Multiple worker processes running on Vercel or local background loops can claim
 *    and process emails in parallel. Using MongoDB's atomic `$inc` operator via
 *    `findOneAndUpdate` on a dedicated counter document ensures strictly monotonic,
 *    collision-free sequence assignment without application-level distributed locks.
 *
 * 4. Partitioning by Day:
 *    Partitioning sequence keys by day (`GX-YYYYMMDD`) isolates counter contention,
 *    keeps sequence numbers compact (padded to 4 digits: `0001`), and naturally reflects
 *    inbound volume per date.
 */

/**
 * Formats a Date object as YYYYMMDD string.
 */
function formatDateKey(date = new Date()) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Atomically generates the next unique ticket number.
 * Format: GX-YYYYMMDD-XXXX (e.g. GX-20261113-0001)
 *
 * @param {Object} [options]
 * @param {Date} [options.date] Date for the ticket sequence (defaults to now)
 * @param {String} [options.prefix] Ticket prefix (defaults to 'GX')
 * @returns {Promise<string>} Next ticket number
 */
async function generateTicketNumber(options = {}) {
  const prefix = options.prefix || 'GX';
  const dateKey = formatDateKey(options.date || new Date());
  const counterKey = `${prefix}-${dateKey}`;

  const counterDoc = await SupportTicketCounter.findOneAndUpdate(
    { key: counterKey },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const seqNumber = counterDoc.seq;
  const paddedSeq = String(seqNumber).padStart(4, '0');
  return `${counterKey}-${paddedSeq}`;
}

module.exports = {
  generateTicketNumber,
  formatDateKey
};

