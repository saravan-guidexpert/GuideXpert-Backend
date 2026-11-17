'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');
const GoogleSheetsSyncJob = require('../../models/GoogleSheetsSyncJob');
const SupportTicket = require('../../models/SupportTicket');
const SupportTicketEvent = require('../../models/SupportTicketEvent');
const { loadEmail, setPipelineStage, codedError } = require('./bodyProcessingService');
const { STAGES } = require('../../constants/supportEmail');

const SHEET_HEADERS = Object.freeze([
  'Ticket number',
  'Category',
  'Priority',
  'Status',
  'Summary',
  'Created at',
  'Updated at'
]);

function quoteTab(tab) {
  return `'${String(tab || 'Tickets').replace(/'/g, "''")}'`;
}

function rowForTicket(ticket) {
  return [
    ticket.ticketNumber || '',
    ticket.category || '',
    ticket.priority || '',
    ticket.status || '',
    (ticket.enquiry && ticket.enquiry.summary) || '',
    ticket.createdAt ? new Date(ticket.createdAt).toISOString() : '',
    ticket.updatedAt ? new Date(ticket.updatedAt).toISOString() : ''
  ];
}

function rowHash(values) {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function locatedRow(found) {
  if (Array.isArray(found)) {
    return { rowNumber: found.length === 1 ? found[0] : null, duplicates: found.length };
  }
  if (found && typeof found === 'object') {
    return {
      rowNumber: found.rowNumber || null,
      duplicates: found.duplicates || (found.duplicate ? 2 : 0)
    };
  }
  if (typeof found === 'number') return { rowNumber: found, duplicates: 1 };
  return { rowNumber: null, duplicates: 0 };
}

function createSheetsClient() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;
  if (!raw) throw codedError('sheets_credentials_missing');
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw codedError('sheets_credentials_invalid');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  return {
    async findRow({ spreadsheetId, tab, ticketNumber }) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteTab(tab)}!A:A`
      });
      const rows = (response.data && response.data.values) || [];
      const matches = [];
      rows.forEach((row, index) => {
        if (row && row[0] === ticketNumber) matches.push(index + 1);
      });
      if (matches.length > 1) {
        const error = new Error('sheets_duplicate_row');
        error.code = 'sheets_duplicate_row';
        throw error;
      }
      return matches.length === 1 ? matches[0] : null;
    },
    async appendRow({ spreadsheetId, tab, values }) {
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${quoteTab(tab)}!A:G`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] }
      });
      const updatedRange = response.data && response.data.updates && response.data.updates.updatedRange;
      const match = /![A-Z]+(\d+)/.exec(updatedRange || '');
      return { rowNumber: match ? Number(match[1]) : null };
    },
    async updateRow({ spreadsheetId, tab, rowNumber, values }) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoteTab(tab)}!A${rowNumber}:G${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [values] }
      });
      return { rowNumber };
    }
  };
}

/**
 * Upserts one ticket summary into the dedicated support sheet.
 * A sheets failure is recorded on the outbox and does not delete the ticket.
 */
async function syncTicketSheet(emailId, deps = {}) {
  const email = await loadEmail(emailId);
  if (email.pipeline.sheets === 'synced') return { done: true };
  const sheetId = deps.config.sheetId;
  const tab = deps.config.sheetTab || 'Tickets';
  if (!sheetId) throw codedError('support_email_sheet_id_missing');

  const ticket = await SupportTicket.findOne({ emailIds: email._id });
  if (!ticket) throw codedError('ticket_missing');
  if (!ticket.ticketNumber || !String(ticket.ticketNumber).trim()) {
    throw codedError('sheets_ticket_number_missing');
  }
  const values = rowForTicket(ticket);
  const hash = rowHash(values);
  let job = await GoogleSheetsSyncJob.findOne({ ticketId: ticket._id, spreadsheetId: sheetId, tab });
  if (job && job.state === 'synced' && job.rowHash === hash && job.rowNumber) {
    await setPipelineStage(email, STAGES.SHEETS, 'synced');
    return { done: true, unchanged: true, rowNumber: job.rowNumber };
  }
  if (!job) {
    try {
      job = await GoogleSheetsSyncJob.create({
        ticketId: ticket._id,
        spreadsheetId: sheetId,
        tab,
        state: 'pending',
        rowHash: hash
      });
    } catch (error) {
      if (!error || error.code !== 11000) throw error;
      job = await GoogleSheetsSyncJob.findOne({ ticketId: ticket._id, spreadsheetId: sheetId, tab });
      if (!job) throw codedError('sheets_job_missing');
    }
  }

  const client = deps.sheetsClient || createSheetsClient();
  const now = new Date();
  const claimToken = crypto.randomBytes(16).toString('hex');
  const claimed = await GoogleSheetsSyncJob.findOneAndUpdate(
    {
      _id: job._id,
      $or: [
        { claimToken: null },
        { claimToken: { $exists: false } },
        { leaseExpiresAt: { $lte: now } }
      ]
    },
    {
      $set: {
        claimToken,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + (deps.config.leaseMs || 75000)),
        state: 'processing'
      }
    },
    { new: true }
  );
  if (!claimed) throw codedError('sheets_sync_in_progress');
  job = claimed;
  try {
    if (!job.rowNumber && typeof client.findRow === 'function') {
      const located = locatedRow(await client.findRow({
        spreadsheetId: sheetId,
        tab,
        ticketNumber: ticket.ticketNumber
      }));
      if (located.duplicates > 1) throw codedError('sheets_duplicate_row');
      if (located.rowNumber) {
        job.rowNumber = located.rowNumber;
        await job.save();
      }
    }
    const written = job.rowNumber
      ? await client.updateRow({ spreadsheetId: sheetId, tab, rowNumber: job.rowNumber, values })
      : await client.appendRow({ spreadsheetId: sheetId, tab, values });
    if (!written || !written.rowNumber) throw codedError('sheets_row_missing');
    job.rowNumber = written.rowNumber;
    job.rowHash = hash;
    job.state = 'synced';
    job.syncedAt = new Date();
    job.lastError = null;
    job.claimToken = null;
    job.leaseExpiresAt = null;
    await job.save();
    ticket.sheetsRowNumber = job.rowNumber;
    await ticket.save();
    await SupportTicketEvent.create({
      ticketId: ticket._id,
      type: 'sheets_synced',
      actorType: 'system',
      metadata: { rowNumber: job.rowNumber }
    });
    await setPipelineStage(email, STAGES.SHEETS, 'synced');
    return { done: true, rowNumber: job.rowNumber };
  } catch (err) {
    job.state = 'failed';
    job.lastError = err.code || 'sheets_write_failed';
    job.attempts += 1;
    job.claimToken = null;
    job.leaseExpiresAt = null;
    await job.save();
    if (email.pipeline.sheets === 'pending') {
      await setPipelineStage(email, STAGES.SHEETS, 'failed');
    }
    const safe = codedError(err.code || 'sheets_write_failed');
    throw safe;
  }
}

module.exports = {
  SHEET_HEADERS,
  rowForTicket,
  syncTicketSheet,
  createSheetsClient
};
