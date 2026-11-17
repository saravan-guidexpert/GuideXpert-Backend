'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const SupportEmail = require('../models/SupportEmail');
const SupportEmailAttachment = require('../models/SupportEmailAttachment');
const SupportEmailProcessingJob = require('../models/SupportEmailProcessingJob');
const SupportTicket = require('../models/SupportTicket');
const GoogleSheetsSyncJob = require('../models/GoogleSheetsSyncJob');
const { readZipEntries } = require('../services/supportEmail/zipArchive');
const { validateAttachment } = require('../services/supportEmail/attachmentValidation');
const { extractDocxText, extractXlsxText } = require('../services/supportEmail/extraction/textExtractors');
const { processAttachments } = require('../services/supportEmail/attachmentService');
const { readBoundedAttachment, tempFilePath } = require('../services/supportEmail/attachmentDownload');
const { storeAttachment } = require('../services/supportEmail/attachmentStorage');
const { runAttachmentRetention } = require('../services/supportEmail/attachmentRetentionService');
const { getProcessingConfig } = require('../services/supportEmail/processingConfig');
const { syncTicketSheet } = require('../services/supportEmail/sheetsSyncService');
const { classifyEmail } = require('../services/supportEmail/classificationService');
const { createTicketForEmail } = require('../services/supportEmail/ticketService');
const { runProcessingBatch, acquireLock, releaseLock } = require('../services/supportEmail/pipelineService');
const SupportEmailRun = require('../models/SupportEmailRun');

function zipStored(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach((file) => {
    const name = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const method = file.method || 0;
    const uncompressed = file.declaredUncompressed == null ? data.length : file.declaredUncompressed;
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  });
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([centralBuf, end]));
}

function limits(extra) {
  return Object.assign({
    maxZipEntries: 4,
    maxZipEntryBytes: 4096,
    maxZipUncompressedBytes: 4096,
    maxZipCompressionRatio: 20
  }, extra || {});
}

async function seedEmail() {
  return SupportEmail.create({
    graphMessageId: `msg-${Date.now()}-${Math.random()}`,
    receivedDateTime: new Date('2026-01-01T00:00:00.000Z'),
    conversationId: `conv-${Math.random()}`,
    subject: 'Attachment',
    from: { name: 'Asha Rao', address: 'asha@example.com' },
    hasAttachments: true,
    metadata: { mailbox: 'support@example.com', folder: 'inbox' }
  });
}

describe('support email phase 3 hardening', () => {
  before(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  test('rejects zip bombs, lying sizes, too many entries, nested archives and bad headers', async () => {
    const payload = Buffer.alloc(80 * 1024, 0x61);
    const compressed = zlib.deflateRawSync(payload);
    assert.ok(compressed.length < 4096);
    const bomb = await readZipEntries(zipStored([{
      name: 'word/document.xml',
      method: 8,
      data: compressed,
      declaredUncompressed: 10
    }]), limits());
    assert.equal(bomb.ok, false);
    assert.ok(['zip_compression_ratio', 'zip_uncompressed_too_large'].includes(bomb.code));

    const lying = await readZipEntries(zipStored([{
      name: 'word/document.xml',
      data: Buffer.alloc(5000, 0x62),
      declaredUncompressed: 1
    }]), limits());
    assert.equal(lying.ok, false);
    assert.equal(lying.code, 'zip_uncompressed_too_large');

    const many = await readZipEntries(zipStored(
      Array.from({ length: 5 }, (_, index) => ({ name: `word/part-${index}.xml`, data: 'x' }))
    ), limits({ maxZipEntries: 4 }));
    assert.equal(many.code, 'too_many_zip_entries');

    const nested = await readZipEntries(zipStored([{
      name: 'word/document.xml',
      data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('nested')])
    }]), limits());
    assert.equal(nested.code, 'nested_archive');

    const malformed = await readZipEntries(Buffer.from('this is not a zip archive at all!!'), limits());
    assert.equal(malformed.code, 'zip_header_invalid');
    const truncated = await readZipEntries(Buffer.alloc(40), limits());
    assert.equal(truncated.ok, false);

    const escaped = await readZipEntries(zipStored([{ name: '../word/document.xml', data: '<w:t>no</w:t>' }]), limits());
    assert.equal(escaped.code, 'unsafe_path');

    const aggregate = await readZipEntries(zipStored([
      { name: 'word/a.xml', data: Buffer.alloc(3000, 0x61) },
      { name: 'word/b.xml', data: Buffer.alloc(3000, 0x62) }
    ]), limits({ maxZipEntryBytes: 4000, maxZipUncompressedBytes: 5000 }));
    assert.equal(aggregate.code, 'zip_uncompressed_too_large');
  });

  test('a rejected archive is recorded and the email remains', async () => {
    const email = await seedEmail();
    const payload = Buffer.alloc(80 * 1024, 0x61);
    const archive = zipStored([{
      name: '[Content_Types].xml',
      data: '<Types></Types>'
    }, {
      name: 'word/document.xml',
      method: 8,
      data: zlib.deflateRawSync(payload),
      declaredUncompressed: 12
    }]);
    let downloads = 0;
    await processAttachments(email._id, {
      config: getProcessingConfig({
        enabled: true,
        maxZipEntryBytes: 4096,
        maxZipUncompressedBytes: 4096,
        maxZipCompressionRatio: 20
      }),
      graphClient: {
        async listAttachments() {
          return { value: [{ id: 'bomb', name: 'letter.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: archive.length, isInline: false }] };
        },
        async getAttachment() {
          downloads += 1;
          return { contentBytes: archive.toString('base64') };
        }
      }
    });
    const row = await SupportEmailAttachment.findOne({ emailId: email._id }).lean();
    assert.equal(downloads, 1);
    assert.equal(Boolean(await SupportEmail.findById(email._id)), true);
    assert.equal(row.storageKey, null);
    assert.equal(row.scanStatus, 'flagged');
    assert.ok(['zip_compression_ratio', 'zip_uncompressed_too_large'].includes(row.scanMessage));
  });

  test('missing and zero sizes are not downloaded, and a stream stops at the cap', async () => {
    const email = await seedEmail();
    let downloads = 0;
    await processAttachments(email._id, {
      config: getProcessingConfig({ enabled: true }),
      graphClient: {
        async listAttachments() {
          return {
            value: [
              { id: 'missing', name: 'a.pdf', contentType: 'application/pdf', isInline: false },
              { id: 'zero', name: 'b.pdf', contentType: 'application/pdf', size: 0, isInline: false }
            ]
          };
        },
        async getAttachment() {
          downloads += 1;
          return { contentBytes: Buffer.from('%PDF-1.4').toString('base64') };
        }
      }
    });
    const rows = await SupportEmailAttachment.find({ emailId: email._id }).lean();
    assert.equal(downloads, 0);
    assert.equal(rows.every((row) => row.scanMessage === 'attachment_size_missing'), true);

    let fetched = false;
    const oversized = await readBoundedAttachment({
      gateway: {
        async getAttachment() {
          fetched = true;
          return { contentBytes: Buffer.from('%PDF-1.4').toString('base64') };
        }
      },
      mailbox: 'support@example.com',
      messageId: 'm1',
      attachmentId: 'huge',
      declaredSize: 1024,
      maxBytes: 32
    });
    assert.equal(oversized.code, 'file_too_large');
    assert.equal(fetched, false);

    let chunks = 0;
    const before = new Set((await fs.promises.readdir(os.tmpdir())).filter((name) => name.startsWith('gx-se-')));
    const capped = await readBoundedAttachment({
      gateway: {
        async openAttachmentStream() {
          return Readable.from((function* stream() {
            for (let index = 0; index < 50; index += 1) {
              chunks += 1;
              yield Buffer.alloc(1000, 1);
            }
          })());
        }
      },
      mailbox: 'support@example.com',
      messageId: 'm1',
      attachmentId: 'a1',
      declaredSize: 2500,
      maxBytes: 2500
    });
    assert.equal(capped.ok, false);
    assert.equal(capped.code, 'file_too_large');
    assert.ok(chunks < 40);
    const after = (await fs.promises.readdir(os.tmpdir())).filter((name) => name.startsWith('gx-se-') && !before.has(name));
    assert.equal(after.length, 0);
  });

  test('retention keeps active work, deletes expired closed work, and survives a partial failure', async () => {
    const old = new Date(Date.now() - (200 * 24 * 60 * 60 * 1000));
    const config = getProcessingConfig({
      enabled: false,
      attachmentRetentionDays: 90,
      extractedTextRetentionDays: 180,
      retentionBatchSize: 10,
      tempMaxAgeMs: 1000
    });
    const activeEmail = await seedEmail();
    const closedEmail = await seedEmail();
    const activeKey = await storeAttachment(Buffer.from('%PDF-1.4 active'), { filename: 'active' });
    const closedKey = await storeAttachment(Buffer.from('%PDF-1.4 closed'), { filename: 'closed' });
    const activeRow = await SupportEmailAttachment.create({ emailId: activeEmail._id, graphAttachmentId: 'a', name: 'a.pdf', size: 12, storageKey: activeKey, extractedText: 'active text' });
    const closedRow = await SupportEmailAttachment.create({ emailId: closedEmail._id, graphAttachmentId: 'c', name: 'c.pdf', size: 12, storageKey: closedKey, extractedText: 'closed text' });
    await SupportEmailAttachment.collection.updateMany(
      { _id: { $in: [activeRow._id, closedRow._id] } },
      { $set: { createdAt: old } }
    );
    await SupportTicket.create({
      ticketNumber: 'GX-TEST-0001',
      dedupeKey: `conv:${activeEmail.conversationId}`,
      emailIds: [activeEmail._id],
      status: 'open'
    });
    await SupportTicket.create({
      ticketNumber: 'GX-TEST-0002',
      dedupeKey: `conv:${closedEmail.conversationId}`,
      emailIds: [closedEmail._id],
      status: 'closed'
    });
    const dry = await runAttachmentRetention({ execute: false, config });
    assert.ok(dry.binaries >= 1);
    assert.equal(Boolean((await SupportEmailAttachment.findOne({ emailId: closedEmail._id })).storageKey), true);

    const kept = await runAttachmentRetention({ execute: true, config });
    assert.ok(kept.protected >= 1);
    assert.equal((await SupportEmailAttachment.findOne({ emailId: activeEmail._id })).extractedText, 'active text');

    const failedEmail = await seedEmail();
    const failedKey = await storeAttachment(Buffer.from('%PDF-1.4 failed'), { filename: 'failed' });
    const failedRow = await SupportEmailAttachment.create({
      emailId: failedEmail._id,
      graphAttachmentId: 'f',
      name: 'f.pdf',
      size: 12,
      storageKey: failedKey,
      extractedText: 'failed text'
    });
    await SupportEmailAttachment.collection.updateOne({ _id: failedRow._id }, { $set: { createdAt: old } });
    await SupportTicket.create({
      ticketNumber: 'GX-TEST-0003',
      dedupeKey: `conv:${failedEmail.conversationId}`,
      emailIds: [failedEmail._id],
      status: 'closed'
    });
    let throws = true;
    const partial = await runAttachmentRetention({
      execute: true,
      config,
      deleteFile: async () => {
        if (throws) {
          throws = false;
          const error = new Error('gridfs_down');
          error.code = 'gridfs_down';
          throw error;
        }
      }
    });
    assert.equal(partial.failed.some((failure) => failure.code === 'gridfs_down'), true);
    assert.equal(Boolean((await SupportEmailAttachment.findOne({ emailId: failedEmail._id })).storageKey), true);

    await runAttachmentRetention({ execute: true, config, deleteFile: async () => {} });
    assert.equal(await SupportEmailAttachment.findOne({ emailId: closedEmail._id }), null);
    assert.equal(await SupportEmailAttachment.findOne({ emailId: failedEmail._id }), null);
    assert.equal(Boolean(await SupportEmail.findById(closedEmail._id)), true);

    const stuckEmail = await seedEmail();
    const stuckKey = await storeAttachment(Buffer.from('%PDF-1.4 stuck'), { filename: 'stuck' });
    const stuckRow = await SupportEmailAttachment.create({
      emailId: stuckEmail._id,
      graphAttachmentId: 's',
      name: 's.pdf',
      size: 8,
      storageKey: stuckKey,
      extractedText: 'stuck text'
    });
    await SupportEmailAttachment.collection.updateOne({ _id: stuckRow._id }, { $set: { createdAt: old } });
    await SupportTicket.create({
      ticketNumber: 'GX-TEST-0004',
      dedupeKey: `conv:${stuckEmail.conversationId}`,
      emailIds: [stuckEmail._id],
      status: 'closed'
    });
    let documentThrows = true;
    const stuck = await runAttachmentRetention({
      execute: true,
      config,
      deleteFile: async () => {},
      deleteDocument: async () => {
        if (documentThrows) {
          documentThrows = false;
          const error = new Error('document_delete_failed');
          error.code = 'document_delete_failed';
          throw error;
        }
        await SupportEmailAttachment.deleteOne({ _id: stuckRow._id });
      }
    });
    assert.equal(stuck.failed.some((failure) => failure.code === 'document_delete_failed'), true);
    assert.equal((await SupportEmailAttachment.findById(stuckRow._id)).extractedText, 'stuck text');
    await runAttachmentRetention({
      execute: true,
      config,
      deleteFile: async () => {},
      deleteDocument: async (id) => SupportEmailAttachment.deleteOne({ _id: id })
    });
    assert.equal(await SupportEmailAttachment.findById(stuckRow._id), null);

    const racing = await seedEmail();
    const racingKey = await storeAttachment(Buffer.from('%PDF-1.4 race'), { filename: 'race' });
    const racingRow = await SupportEmailAttachment.create({
      emailId: racing._id,
      graphAttachmentId: 'r',
      name: 'r.pdf',
      size: 8,
      storageKey: racingKey,
      extractedText: 'race'
    });
    await SupportEmailAttachment.collection.updateOne({ _id: racingRow._id }, { $set: { createdAt: old } });
    const raced = await runAttachmentRetention({
      execute: true,
      config,
      beforeMutate: async (candidate) => {
        if (String(candidate.emailId) !== String(racing._id)) return;
        await SupportEmailProcessingJob.create({
          emailId: racing._id,
          stage: 'attachments',
          state: 'processing',
          claimToken: 'live'
        });
      }
    });
    assert.ok(raced.protected >= 1);
    assert.equal((await SupportEmailAttachment.findOne({ emailId: racing._id })).extractedText, 'race');

    const stale = tempFilePath();
    await fs.promises.writeFile(stale, 'temp');
    const oldTime = new Date(Date.now() - 5000);
    await fs.promises.utimes(stale, oldTime, oldTime);
    const swept = await runAttachmentRetention({ execute: true, config });
    assert.ok(swept.tempFiles >= 1);
    assert.equal(fs.existsSync(stale), false);
  });

  test('the run lock outlives the execution window and blocks a second worker', async () => {
    const outcome = await runProcessingBatch({
      enabled: true,
      maxDurationMs: 60000,
      lockMarginMs: 15000,
      timeBudgetMs: 180000
    });
    assert.equal(outcome.processed, 0);
    const run = await SupportEmailRun.findOne({ runKey: 'phase3-process' }).sort({ startedAt: -1 });
    const heldFor = new Date(run.lockExpiresAt).getTime() - new Date(run.startedAt).getTime();
    assert.ok(heldFor >= 75000);
    await SupportEmailRun.updateOne(
      { _id: run._id },
      { $set: { activeLock: true, finishedAt: null, lockExpiresAt: new Date(Date.now() + heldFor) } }
    );
    const second = await runProcessingBatch({ enabled: true, maxDurationMs: 60000, lockMarginMs: 15000 });
    assert.equal(second.skipped, 'lock_held');
  });

  test('processing budget stays inside the Vercel window and unsafe values are rejected', () => {
    const config = getProcessingConfig({ enabled: true, timeBudgetMs: 180000, maxDurationMs: 60000, lockMarginMs: 15000 });
    assert.equal(config.timeBudgetMs, 45000);
    assert.ok(config.leaseMs >= 75000);
    assert.throws(
      () => getProcessingConfig({ maxDurationMs: 1000, lockMarginMs: 15000 }),
      (error) => error.code === 'unsafe_processing_config'
    );
    assert.throws(
      () => getProcessingConfig({ attachmentRetentionDays: 200, extractedTextRetentionDays: 30 }),
      (error) => error.code === 'unsafe_processing_config'
    );
  });

  test('a sheet row written before the database update is reused', async () => {
    const email = await SupportEmail.create({
      graphMessageId: 'sheet-crash',
      receivedDateTime: new Date('2026-11-08T05:14:00.000Z'),
      conversationId: 'conversation-sheet',
      subject: 'Fee receipt',
      from: { name: 'Asha Rao', address: 'asha@example.com' },
      bodyText: 'Where is my receipt?',
      metadata: { mailbox: 'support@example.com', folder: 'inbox' },
      pipeline: { fetch: 'fetched', attachments: 'extracted', ai: 'pending' }
    });
    await classifyEmail(email._id, {
      config: getProcessingConfig({ enabled: true }),
      chatCompletion: async () => ({
        content: JSON.stringify({
          category: 'billing',
          subcategory: 'receipt',
          intent: 'find_receipt',
          priority: 'medium',
          urgency: 'medium',
          sentiment: 'neutral',
          summary: 'Student asked for a fee receipt.',
          studentIdentifiers: { name: '', email: '', phone: '', rollNumber: '', course: '' },
          recommendedAction: 'Look up the receipt.',
          confidence: 0.95,
          needsHumanReview: false
        }),
        model: 'test-model'
      })
    });
    await createTicketForEmail(email._id);
    const ticket = await SupportTicket.findOne({ emailIds: email._id });
    const sheet = new Map();
    let appends = 0;
    const sheetsClient = {
      async findRow({ ticketNumber }) {
        return sheet.has(ticketNumber) ? sheet.get(ticketNumber) : null;
      },
      async appendRow({ values }) {
        appends += 1;
        sheet.set(values[0], 8);
        return { rowNumber: 8 };
      },
      async updateRow({ rowNumber, values }) {
        sheet.set(values[0], rowNumber);
        return { rowNumber };
      }
    };
    const config = getProcessingConfig({ enabled: true, sheetId: 'sheet-1' });
    await syncTicketSheet(email._id, { config, sheetsClient });
    await GoogleSheetsSyncJob.updateOne({ ticketId: ticket._id }, { $set: { rowNumber: null, state: 'pending' } });
    await SupportEmail.updateOne({ _id: email._id }, { $set: { 'pipeline.sheets': 'pending' } });
    await syncTicketSheet(email._id, { config, sheetsClient });
    assert.equal(appends, 1);
    assert.equal(sheet.get(ticket.ticketNumber), 8);
    assert.equal((await GoogleSheetsSyncJob.findOne({ ticketId: ticket._id })).rowNumber, 8);
  });

  test('reads Office-style and streaming DOCX/XLSX without trusting declared sizes', async () => {
    const docxParts = [
      ['[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
      ['word/', ''],
      ['word/document.xml', '<w:document><w:p><w:t>Fee receipt from a streaming writer</w:t></w:p></w:document>'],
      ['word/_rels/document.xml.rels', '<Relationships></Relationships>'],
      ['xl/worksheets/_rels/sheet1.xml.rels', '<Relationships></Relationships>']
    ];
    const streamingDocx = officeArchive({ streaming: true, files: docxParts });
    const streaming = await readZipEntries(streamingDocx, limits({ maxZipEntries: 20 }));
    assert.equal(streaming.ok, true);
    assert.match(extractDocxText(streaming.entries).text, /Fee receipt from a streaming writer/);
    const streamedVerdict = await validateAttachment({
      name: 'letter.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: streamingDocx
    });
    assert.equal(streamedVerdict.kind, 'docx');

    const xlsx = officeArchive({
      streaming: false,
      files: [
        ['[Content_Types].xml', '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
        ['xl/workbook.xml', '<workbook></workbook>'],
        ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="inlineStr"><is><t>Fee receipt</t></is></c></row></sheetData></worksheet>'],
        ['xl/worksheets/_rels/sheet1.xml.rels', '<Relationships></Relationships>'],
        ['docProps/café.xml', '<title>Fees</title>']
      ]
    });
    const sheetVerdict = await validateAttachment({
      name: 'fees.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: xlsx
    });
    assert.equal(sheetVerdict.kind, 'xlsx');
    assert.match(extractXlsxText(sheetVerdict.entries).text, /Fee receipt/);

    const macro = officeArchive({
      streaming: true,
      files: docxParts.concat([['word/vbaProject.bin', 'macro']])
    });
    assert.equal((await readZipEntries(macro, limits({ maxZipEntries: 20 }))).code, 'macro_content');

    const zip64 = zip64Stored('word/document.xml', Buffer.from('<w:t>zip64</w:t>'));
    const widened = await readZipEntries(zip64, limits());
    assert.equal(widened.ok, true);
    assert.match(widened.entries[0].content.toString(), /zip64/);

    const huge = zip64Stored('word/document.xml', Buffer.from('x'), { compressedSize: Number.MAX_SAFE_INTEGER });
    assert.equal((await readZipEntries(huge, limits())).code, 'zip64_unsupported');
  });

  test('a short download is not stored as a complete attachment', async () => {
    const email = await seedEmail();
    await assert.rejects(
      () => processAttachments(email._id, {
        config: getProcessingConfig({ enabled: true }),
        graphClient: {
          async listAttachments() {
            return { value: [{ id: 'partial', name: 'note.pdf', contentType: 'application/pdf', size: 400, isInline: false }] };
          },
          async openAttachmentStream() {
            return Readable.from([Buffer.from('%PDF-1.4 partial')]);
          }
        }
      }),
      (error) => error.code === 'download_incomplete'
    );
    assert.equal(await SupportEmailAttachment.countDocuments({ emailId: email._id }), 0);
    assert.equal(Boolean(await SupportEmail.findById(email._id)), true);
  });

  test('retention keeps non-closed and unlinked files, pages past them, and honors the text window', async () => {
    const old = new Date(Date.now() - (120 * 24 * 60 * 60 * 1000));
    const older = new Date(Date.now() - (200 * 24 * 60 * 60 * 1000));
    const config = getProcessingConfig({
      enabled: false,
      attachmentRetentionDays: 90,
      extractedTextRetentionDays: 180,
      retentionBatchSize: 2,
      tempMaxAgeMs: 60 * 60 * 1000
    });
    async function agedAttachment(email, text, when) {
      const key = await storeAttachment(Buffer.from(`%PDF-1.4 ${text}`), { filename: text });
      const row = await SupportEmailAttachment.create({
        emailId: email._id,
        graphAttachmentId: `g-${text}`,
        name: `${text}.pdf`,
        size: 12,
        storageKey: key,
        extractedText: text
      });
      await SupportEmailAttachment.collection.updateOne({ _id: row._id }, { $set: { createdAt: when } });
      return row;
    }
    const openEmail = await seedEmail();
    const reviewEmail = await seedEmail();
    const resolvedEmail = await seedEmail();
    const unlinkedEmail = await seedEmail();
    const closedEmail = await seedEmail();
    const textEmail = await seedEmail();
    await agedAttachment(openEmail, 'open-text', older);
    await agedAttachment(reviewEmail, 'review-text', older);
    await agedAttachment(resolvedEmail, 'resolved-text', older);
    await agedAttachment(unlinkedEmail, 'unlinked-text', older);
    const closedRow = await agedAttachment(closedEmail, 'closed-text', older);
    const textRow = await agedAttachment(textEmail, 'kept-text', old);
    await SupportTicket.create({ ticketNumber: 'GX-KEEP-OPEN', dedupeKey: `conv:${openEmail.conversationId}`, emailIds: [openEmail._id], status: 'open' });
    await SupportTicket.create({ ticketNumber: 'GX-KEEP-REVIEW', dedupeKey: `conv:${reviewEmail.conversationId}`, emailIds: [reviewEmail._id], status: 'needs_review' });
    await SupportTicket.create({ ticketNumber: 'GX-KEEP-RESOLVED', dedupeKey: `conv:${resolvedEmail.conversationId}`, emailIds: [resolvedEmail._id], status: 'resolved' });
    await SupportTicket.create({ ticketNumber: 'GX-CLOSED-OLD', dedupeKey: `conv:${closedEmail.conversationId}`, emailIds: [closedEmail._id], status: 'closed' });
    await SupportTicket.create({ ticketNumber: 'GX-CLOSED-TEXT', dedupeKey: `conv:${textEmail.conversationId}`, emailIds: [textEmail._id], status: 'closed' });

    const dry = await runAttachmentRetention({ execute: false, config });
    assert.equal(dry.execute, false);
    assert.equal(Boolean((await SupportEmailAttachment.findById(closedRow._id)).storageKey), true);

    const cleaned = await runAttachmentRetention({ execute: true, config, deleteFile: async () => {} });
    assert.equal(await SupportEmailAttachment.findById(closedRow._id), null);
    assert.equal((await SupportEmailAttachment.findOne({ emailId: openEmail._id })).extractedText, 'open-text');
    assert.equal((await SupportEmailAttachment.findOne({ emailId: reviewEmail._id })).extractedText, 'review-text');
    assert.equal((await SupportEmailAttachment.findOne({ emailId: resolvedEmail._id })).extractedText, 'resolved-text');
    assert.equal((await SupportEmailAttachment.findOne({ emailId: unlinkedEmail._id })).extractedText, 'unlinked-text');
    const kept = await SupportEmailAttachment.findById(textRow._id);
    assert.equal(kept.storageKey, null);
    assert.equal(kept.extractedText, 'kept-text');
    assert.ok(cleaned.protected >= 4);

    const racing = await seedEmail();
    const racingRow = await agedAttachment(racing, 'racing-text', older);
    await SupportTicket.create({ ticketNumber: 'GX-RACE-CLOSED', dedupeKey: `conv:${racing.conversationId}`, emailIds: [racing._id], status: 'closed' });
    const raced = await runAttachmentRetention({
      execute: true,
      config,
      deleteFile: async () => {},
      beforeDelete: async (current) => {
        if (String(current.emailId) !== String(racing._id)) return;
        await SupportEmailProcessingJob.create({
          emailId: racing._id,
          stage: 'ticket',
          state: 'processing',
          claimToken: 'still-running'
        });
      }
    });
    assert.ok(raced.protected >= 1);
    assert.equal((await SupportEmailAttachment.findById(racingRow._id)).extractedText, 'racing-text');
  });

  test('a replaced run lock cannot be released by the previous owner', async () => {
    const first = await acquireLock(new Date(), 60000);
    await SupportEmailRun.updateOne({ _id: first._id }, { $set: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const second = await acquireLock(new Date(), 60000);
    assert.notEqual(second.lockToken, first.lockToken);
    await releaseLock(first, {}, null);
    const held = await SupportEmailRun.findById(second._id);
    assert.equal(held.activeLock, true);
    assert.equal(held.lockToken, second.lockToken);
    await releaseLock(second, {}, null);
    assert.equal((await SupportEmailRun.findById(second._id)).activeLock, false);
  });

  test('sheet claims avoid duplicate appends and reject a missing or repeated ticket number', async () => {
    const email = await seedEmail();
    email.bodyText = 'Receipt';
    email.pipeline = { fetch: 'fetched', attachments: 'extracted', ai: 'pending' };
    await email.save();
    await classifyEmail(email._id, {
      config: getProcessingConfig({ enabled: true }),
      chatCompletion: async () => ({
        content: JSON.stringify({
          category: 'billing',
          subcategory: 'receipt',
          intent: 'find_receipt',
          priority: 'medium',
          urgency: 'medium',
          sentiment: 'neutral',
          summary: 'Student asked for a fee receipt.',
          studentIdentifiers: { name: '', email: '', phone: '', rollNumber: '', course: '' },
          recommendedAction: 'Look up the receipt.',
          confidence: 0.95,
          needsHumanReview: false
        }),
        model: 'test-model'
      })
    });
    await createTicketForEmail(email._id);
    const ticket = await SupportTicket.findOne({ emailIds: email._id });
    const config = getProcessingConfig({ enabled: true, sheetId: 'sheet-1' });
    let appends = 0;
    let releaseAppend;
    const appendGate = new Promise((resolve) => {
      releaseAppend = resolve;
    });
    const sheetsClient = {
      async findRow() {
        return null;
      },
      async appendRow({ values }) {
        appends += 1;
        if (appends === 1) await appendGate;
        return { rowNumber: 6, values };
      },
      async updateRow({ rowNumber }) {
        return { rowNumber };
      }
    };
    const first = syncTicketSheet(email._id, { config, sheetsClient });
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (appends === 1) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 2000) {
          clearInterval(timer);
          reject(new Error('append did not start'));
        }
      }, 10);
    });
    const second = await syncTicketSheet(email._id, { config, sheetsClient }).then(
      () => null,
      (error) => error
    );
    releaseAppend();
    await first;
    assert.equal(appends, 1);
    assert.equal(second.code, 'sheets_sync_in_progress');

    await SupportEmail.updateOne({ _id: email._id }, { $set: { 'pipeline.sheets': 'pending' } });
    await GoogleSheetsSyncJob.updateOne({ ticketId: ticket._id }, { $set: { state: 'pending', rowNumber: null, claimToken: null, leaseExpiresAt: null } });
    await assert.rejects(
      () => syncTicketSheet(email._id, {
        config,
        sheetsClient: {
          async findRow() {
            return [4, 9];
          },
          async appendRow() {
            appends += 1;
            return { rowNumber: 10 };
          }
        }
      }),
      (error) => error.code === 'sheets_duplicate_row'
    );
    assert.equal(appends, 1);

    await SupportTicket.collection.updateOne({ _id: ticket._id }, { $set: { ticketNumber: '   ' } });
    await SupportEmail.updateOne({ _id: email._id }, { $set: { 'pipeline.sheets': 'pending' } });
    await GoogleSheetsSyncJob.updateOne({ ticketId: ticket._id }, { $set: { state: 'failed', claimToken: null, leaseExpiresAt: null } });
    await assert.rejects(
      () => syncTicketSheet(email._id, { config, sheetsClient }),
      (error) => error.code === 'sheets_ticket_number_missing'
    );
    assert.equal(appends, 1);
  });
});

function officeArchive({ streaming, files }) {
  const script = [
    'import json,sys,zipfile,io',
    'spec=json.load(sys.stdin)',
    'class Sink:',
    '    def __init__(self):',
    '        self.buf=bytearray()',
    '    def write(self, data):',
    '        self.buf += data',
    '        return len(data)',
    '    def tell(self):',
    '        return len(self.buf)',
    '    def flush(self):',
    '        return None',
    'if spec["streaming"]:',
    '    raw=Sink()',
    '    archive=zipfile.ZipFile(raw,"w",compression=zipfile.ZIP_DEFLATED)',
    '    for item in spec["files"]:',
    '        with archive.open(item[0],"w") as entry:',
    '            entry.write(item[1].encode())',
    '    archive.close()',
    '    sys.stdout.buffer.write(bytes(raw.buf))',
    'else:',
    '    raw=io.BytesIO()',
    '    with zipfile.ZipFile(raw,"w",compression=zipfile.ZIP_DEFLATED) as archive:',
    '        for item in spec["files"]:',
    '            archive.writestr(item[0], item[1])',
    '    sys.stdout.buffer.write(raw.getvalue())'
  ].join('\n');
  return execFileSync('python3', ['-c', script], {
    input: JSON.stringify({ streaming, files }),
    maxBuffer: 8 * 1024 * 1024
  });
}

function zip64Stored(name, data, overrides = {}) {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30 + fileName.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  fileName.copy(local, 30);
  data.copy(local, 30 + fileName.length);
  const extra = Buffer.alloc(4 + 16);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeUInt32LE(data.length, 4);
  const compressedField = overrides.compressedSize == null ? data.length : overrides.compressedSize;
  extra.writeUInt32LE(compressedField >>> 0, 12);
  extra.writeUInt32LE(Math.floor(compressedField / 0x100000000), 16);
  const central = Buffer.alloc(46 + fileName.length + extra.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(extra.length, 30);
  fileName.copy(central, 46);
  extra.copy(central, 46 + fileName.length);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}
