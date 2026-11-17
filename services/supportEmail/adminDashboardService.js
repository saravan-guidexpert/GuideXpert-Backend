'use strict';

const mongoose = require('mongoose');
const Admin = require('../../models/Admin');
const { GridFSBucket, ObjectId } = require('mongodb');
const SupportEmail = require('../../models/SupportEmail');
const SupportEmailAttachment = require('../../models/SupportEmailAttachment');
const SupportEmailProcessingJob = require('../../models/SupportEmailProcessingJob');
const SupportEmailAiRun = require('../../models/SupportEmailAiRun');
const SupportEmailAuditLog = require('../../models/SupportEmailAuditLog');
const SupportEmailWebhookEvent = require('../../models/SupportEmailWebhookEvent');
const SupportEmailRun = require('../../models/SupportEmailRun');
const SupportTicket = require('../../models/SupportTicket');
const SupportTicketEvent = require('../../models/SupportTicketEvent');
const GoogleSheetsSyncJob = require('../../models/GoogleSheetsSyncJob');
const GraphSubscription = require('../../models/GraphSubscription');
const EmailSyncCursor = require('../../models/EmailSyncCursor');
const { BUCKET_NAME } = require('./attachmentStorage');
const { enqueueJob } = require('./queueService');
const {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  JOB_STATES
} = require('../../constants/supportEmail');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 366 * DAY_MS;
const MAX_PAGE_SIZE = 50;
const RETRYABLE = [JOB_STATES.FAILED, JOB_STATES.DEAD_LETTER];

function coded(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status || 400;
  return error;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function resolveRange(query = {}, now = new Date()) {
  const preset = String(query.preset || '7d');
  let from;
  let to = endOfDay(now);
  if (preset === 'today') from = startOfDay(now);
  else if (preset === '7d') from = startOfDay(new Date(now.getTime() - (6 * DAY_MS)));
  else if (preset === '30d') from = startOfDay(new Date(now.getTime() - (29 * DAY_MS)));
  else if (preset === 'custom') {
    from = new Date(query.from);
    to = new Date(query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw coded('invalid_range');
    from = startOfDay(from);
    to = endOfDay(to);
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw coded('range_too_large');
  } else {
    throw coded('invalid_preset');
  }
  return { preset, from, to };
}

function pageQuery(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicSender(from) {
  return {
    name: from && from.name ? String(from.name) : '',
    email: from && from.address ? String(from.address) : ''
  };
}

function publicPipeline(pipeline) {
  const source = pipeline || {};
  return {
    state: source.state || 'received',
    fetch: source.fetch || 'pending',
    attachments: source.attachments || 'pending',
    ai: source.ai || 'pending',
    ticket: source.ticket || 'pending',
    sheets: source.sheets || 'pending'
  };
}

function publicClassification(run) {
  const parsed = run && run.parsed && typeof run.parsed === 'object' ? run.parsed : {};
  return {
    summary: parsed.summary || '',
    category: parsed.category || '',
    subcategory: parsed.subcategory || '',
    intent: parsed.intent || '',
    sentiment: parsed.sentiment || '',
    priority: parsed.priority || '',
    urgency: parsed.urgency || '',
    confidence: run ? run.confidence : null,
    recommendedAction: parsed.recommendedAction || '',
    needsHumanReview: Boolean(parsed.needsHumanReview) || (run && run.outcome === 'needs_review'),
    reviewReason: (run && run.error) || (parsed.needsHumanReview ? 'needs_human_review' : null),
    outcome: run ? run.outcome : null
  };
}

function publicAttachment(row, includeText) {
  return {
    id: String(row._id),
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    scanStatus: row.scanStatus,
    extractStatus: row.extractStatus,
    extractError: row.extractError,
    pageCount: row.pageCount,
    hasFile: Boolean(row.storageKey),
    extractedText: includeText ? (row.extractedText || '') : undefined,
    textAvailable: Boolean(row.extractedText),
    imageTextSupported: false,
    scannedPdfSupported: false
  };
}

async function audit(admin, action, targetType, targetId, metadata) {
  await SupportEmailAuditLog.create({
    adminId: admin && admin._id,
    action,
    targetType,
    targetId: String(targetId),
    metadata: metadata || {}
  });
}

async function overview(query) {
  const range = resolveRange(query);
  const emailMatch = { receivedDateTime: { $gte: range.from, $lte: range.to } };
  const ticketMatch = { createdAt: { $gte: range.from, $lte: range.to } };
  const [
    totalEmails,
    processed,
    pendingProcessing,
    needsReviewEmails,
    failedEmails,
    ticketsCreated,
    needsReviewTickets,
    highPriority,
    urgent,
    sheets,
    category,
    priority,
    ai,
    emailTrend,
    failureTrend
  ] = await Promise.all([
    SupportEmail.countDocuments(emailMatch),
    SupportEmail.countDocuments({ ...emailMatch, 'pipeline.state': 'completed' }),
    SupportEmail.countDocuments({ ...emailMatch, 'pipeline.state': { $in: ['received', 'processing'] } }),
    SupportEmail.countDocuments({ ...emailMatch, 'pipeline.ai': 'needs_review' }),
    SupportEmail.countDocuments({ ...emailMatch, 'pipeline.state': 'failed' }),
    SupportTicket.countDocuments(ticketMatch),
    SupportTicket.countDocuments({ ...ticketMatch, status: 'needs_review' }),
    SupportTicket.countDocuments({ ...ticketMatch, priority: 'high' }),
    SupportTicket.countDocuments({ ...ticketMatch, priority: 'urgent' }),
    GoogleSheetsSyncJob.aggregate([
      { $match: { updatedAt: { $gte: range.from, $lte: range.to } } },
      { $group: { _id: '$state', count: { $sum: 1 } } }
    ]),
    SupportTicket.aggregate([
      { $match: ticketMatch },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    SupportTicket.aggregate([
      { $match: ticketMatch },
      { $group: { _id: '$priority', count: { $sum: 1 } } }
    ]),
    SupportEmailAiRun.aggregate([
      { $match: { createdAt: { $gte: range.from, $lte: range.to } } },
      { $group: { _id: '$outcome', count: { $sum: 1 } } }
    ]),
    SupportEmail.aggregate([
      { $match: emailMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedDateTime' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]),
    SupportEmailProcessingJob.aggregate([
      { $match: { updatedAt: { $gte: range.from, $lte: range.to }, state: { $in: ['completed', 'failed', 'dead_letter'] } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } }, state: '$state' }, count: { $sum: 1 } } },
      { $sort: { '_id.day': 1 } }
    ])
  ]);
  return {
    range,
    totals: {
      emails: totalEmails,
      processed,
      tickets: ticketsCreated,
      pending: pendingProcessing,
      needsReview: needsReviewTickets + needsReviewEmails,
      failed: failedEmails,
      highPriority,
      urgent
    },
    sheets: sheets.map((row) => ({ state: row._id, count: row.count })),
    categories: category.map((row) => ({ category: row._id, count: row.count })),
    priorities: priority.map((row) => ({ priority: row._id, count: row.count })),
    ai: ai.map((row) => ({ outcome: row._id, count: row.count })),
    emailTrend: emailTrend.map((row) => ({ day: row._id, count: row.count })),
    processingTrend: failureTrend.map((row) => ({ day: row._id.day, state: row._id.state, count: row.count }))
  };
}

async function listTickets(query) {
  const paging = pageQuery(query);
  const filter = {};
  if (query.category) {
    if (!TICKET_CATEGORIES.includes(query.category)) throw coded('invalid_category');
    filter.category = query.category;
  }
  if (query.priority) {
    if (!TICKET_PRIORITIES.includes(query.priority)) throw coded('invalid_priority');
    filter.priority = query.priority;
  }
  if (query.status) {
    if (!TICKET_STATUSES.includes(query.status)) throw coded('invalid_status');
    filter.status = query.status;
  }
  if (query.review === '1') filter.status = 'needs_review';
  const text = String(query.q || '').trim().slice(0, 80);
  if (text) {
    const pattern = new RegExp(escapeRegex(text), 'i');
    const emails = await SupportEmail.find({
      $or: [{ subject: pattern }, { 'from.address': pattern }, { 'from.name': pattern }]
    }).select('_id').limit(200).lean();
    filter.$or = [
      { ticketNumber: pattern },
      { 'requester.email': pattern },
      { 'requester.name': pattern },
      { emailIds: { $in: emails.map((row) => row._id) } }
    ];
  }
  const sort = query.sort === 'priority'
    ? { priorityRank: -1, updatedAt: -1 }
    : { [query.sort === 'updated' ? 'updatedAt' : 'createdAt']: query.direction === 'asc' ? 1 : -1 };
  const pipeline = [
    { $match: filter },
    { $addFields: { priorityRank: { $switch: {
      branches: [
        { case: { $eq: ['$priority', 'urgent'] }, then: 4 },
        { case: { $eq: ['$priority', 'high'] }, then: 3 },
        { case: { $eq: ['$priority', 'medium'] }, then: 2 },
        { case: { $eq: ['$priority', 'low'] }, then: 1 }
      ],
      default: 0
    } } } },
    { $sort: sort },
    { $skip: paging.skip },
    { $limit: paging.limit }
  ];
  const [rows, total] = await Promise.all([
    SupportTicket.aggregate(pipeline),
    SupportTicket.countDocuments(filter)
  ]);
  const emailIds = rows.map((row) => row.primaryEmailId).filter(Boolean);
  const emails = await SupportEmail.find({ _id: { $in: emailIds } }).select('subject from receivedDateTime').lean();
  const byId = new Map(emails.map((row) => [String(row._id), row]));
  const adminIds = rows.map((row) => row.assignedTo).filter(Boolean);
  const admins = adminIds.length
    ? await Admin.find({ _id: { $in: adminIds } }).select('name username').lean()
    : [];
  const adminById = new Map(admins.map((row) => [String(row._id), row]));
  return {
    page: paging.page,
    limit: paging.limit,
    total,
    tickets: rows.map((row) => {
      const email = byId.get(String(row.primaryEmailId));
      const assignee = row.assignedTo ? adminById.get(String(row.assignedTo)) : null;
      return {
        id: String(row._id),
        ticketNumber: row.ticketNumber,
        subject: email ? email.subject : '',
        sender: email ? publicSender(email.from) : { name: row.requester && row.requester.name, email: row.requester && row.requester.email },
        category: row.category,
        priority: row.priority,
        status: row.status,
        assignedTo: assignee ? { id: String(assignee._id), name: assignee.name || assignee.username } : null,
        receivedAt: email ? email.receivedDateTime : row.createdAt,
        updatedAt: row.updatedAt
      };
    })
  };
}

async function ticketDetail(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw coded('ticket_not_found', 404);
  const ticket = await SupportTicket.findById(id).lean();
  if (!ticket) throw coded('ticket_not_found', 404);
  const emails = await SupportEmail.find({ _id: { $in: ticket.emailIds } })
    .select('subject from receivedDateTime bodyText conversationId pipeline')
    .sort({ receivedDateTime: 1 })
    .lean();
  const primary = emails.find((row) => String(row._id) === String(ticket.primaryEmailId)) || emails[0] || null;
  const conversation = primary && primary.conversationId
    ? await SupportEmail.find({ conversationId: primary.conversationId })
      .select('subject from receivedDateTime bodyText')
      .sort({ receivedDateTime: 1 })
      .limit(20)
      .lean()
    : emails;
  const [aiRun, attachments, sheet, events] = await Promise.all([
    ticket.aiRunId ? SupportEmailAiRun.findById(ticket.aiRunId).select('parsed confidence outcome error').lean() : null,
    SupportEmailAttachment.find({ emailId: { $in: ticket.emailIds } })
      .select('name contentType size scanStatus extractStatus extractError pageCount storageKey extractedText')
      .lean(),
    GoogleSheetsSyncJob.findOne({ ticketId: ticket._id }).select('state rowNumber lastError syncedAt attempts').lean(),
    SupportTicketEvent.find({ ticketId: ticket._id }).sort({ createdAt: -1 }).limit(20).lean()
  ]);
  return {
    id: String(ticket._id),
    ticketNumber: ticket.ticketNumber,
    category: ticket.category,
    subCategory: ticket.subCategory,
    priority: ticket.priority,
    status: ticket.status,
    sentiment: ticket.sentiment,
    confidence: ticket.confidence,
    summary: ticket.enquiry && ticket.enquiry.summary,
    sender: primary ? publicSender(primary.from) : { name: '', email: '' },
    receivedAt: primary ? primary.receivedDateTime : ticket.createdAt,
    subject: primary ? primary.subject : '',
    bodyText: primary ? primary.bodyText : '',
    pipeline: publicPipeline(primary && primary.pipeline),
    conversation: conversation.map((row) => ({
      id: String(row._id),
      subject: row.subject,
      sender: publicSender(row.from),
      receivedAt: row.receivedDateTime,
      bodyText: row.bodyText || ''
    })),
    classification: publicClassification(aiRun),
    attachments: attachments.map((row) => publicAttachment(row, true)),
    sheets: sheet ? {
      state: sheet.state,
      rowNumber: sheet.rowNumber,
      lastError: sheet.lastError,
      syncedAt: sheet.syncedAt,
      attempts: sheet.attempts
    } : { state: 'missing' },
    events: events.map((row) => ({
      type: row.type,
      actorType: row.actorType,
      createdAt: row.createdAt,
      before: row.before,
      after: row.after
    }))
  };
}

async function reviewTicket(id, admin, body) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw coded('ticket_not_found', 404);
  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw coded('ticket_not_found', 404);
  const before = { category: ticket.category, priority: ticket.priority, status: ticket.status, subCategory: ticket.subCategory };
  if (body.category) {
    if (!TICKET_CATEGORIES.includes(body.category)) throw coded('invalid_category');
    ticket.category = body.category;
  }
  if (body.subCategory != null) ticket.subCategory = String(body.subCategory).trim().slice(0, 100);
  if (body.priority) {
    if (!TICKET_PRIORITIES.includes(body.priority)) throw coded('invalid_priority');
    ticket.priority = body.priority;
  }
  if (body.status) {
    if (!TICKET_STATUSES.includes(body.status)) throw coded('invalid_status');
    ticket.status = body.status;
  }
  const note = body.note != null ? String(body.note).trim().slice(0, 500) : '';
  if (!body.category && !body.priority && !body.status && !note && body.subCategory == null) throw coded('review_empty');
  await ticket.save();
  const after = { category: ticket.category, priority: ticket.priority, status: ticket.status, subCategory: ticket.subCategory };
  const actorId = admin && admin._id ? String(admin._id) : null;
  if (before.category !== after.category) {
    await SupportTicketEvent.create({ ticketId: ticket._id, type: 'category_changed', actorType: 'admin', actorId, before, after });
  }
  if (before.priority !== after.priority) {
    await SupportTicketEvent.create({ ticketId: ticket._id, type: 'priority_changed', actorType: 'admin', actorId, before, after });
  }
  if (before.status !== after.status) {
    await SupportTicketEvent.create({ ticketId: ticket._id, type: 'status_changed', actorType: 'admin', actorId, before, after });
  }
  if (note) {
    await SupportTicketEvent.create({ ticketId: ticket._id, type: 'comment_added', actorType: 'admin', actorId, metadata: { note } });
  }
  await audit(admin, 'ticket_reviewed', 'support_ticket', ticket._id, { before, after, noted: Boolean(note) });
  return { id: String(ticket._id), ...after };
}

async function listJobs(query) {
  const paging = pageQuery(query);
  const filter = {};
  if (query.state) {
    if (!Object.values(JOB_STATES).includes(query.state)) throw coded('invalid_state');
    filter.state = query.state;
  } else {
    filter.state = { $in: [JOB_STATES.FAILED, JOB_STATES.DEAD_LETTER] };
  }
  if (query.stage) filter.stage = String(query.stage);
  const [rows, total, attachmentFailures, sheetFailures, graphFailures] = await Promise.all([
    SupportEmailProcessingJob.find(filter).sort({ updatedAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    SupportEmailProcessingJob.countDocuments(filter),
    SupportEmailAttachment.find({ extractStatus: { $in: ['failed', 'corrupted'] } })
      .select('name extractStatus extractError emailId updatedAt')
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
    GoogleSheetsSyncJob.find({ state: { $in: ['failed', 'exhausted'] } })
      .select('state lastError attempts updatedAt ticketId')
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
    EmailSyncCursor.find({ syncStatus: 'failed' }).select('mailbox folder syncStatus error updatedAt').limit(20).lean()
  ]);
  return {
    page: paging.page,
    limit: paging.limit,
    total,
    jobs: rows.map((row) => ({
      id: String(row._id),
      emailId: String(row.emailId),
      stage: row.stage,
      state: row.state,
      reason: row.deadLetterReason || row.lastError || null,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastAttempt: row.updatedAt,
      nextRetry: row.state === JOB_STATES.PENDING ? row.nextAttemptAt : null,
      deadLetter: row.state === JOB_STATES.DEAD_LETTER
    })),
    attachmentFailures: attachmentFailures.map((row) => ({
      id: String(row._id),
      name: row.name,
      status: row.extractStatus,
      reason: row.extractError,
      updatedAt: row.updatedAt
    })),
    sheetFailures: sheetFailures.map((row) => ({
      id: String(row._id),
      state: row.state,
      reason: row.lastError,
      attempts: row.attempts,
      updatedAt: row.updatedAt
    })),
    graphFailures: graphFailures.map((row) => ({
      mailbox: row.mailbox,
      folder: row.folder,
      status: row.syncStatus,
      reason: row.error,
      updatedAt: row.updatedAt
    }))
  };
}

async function retryJob(id, admin) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw coded('job_not_found', 404);
  const job = await SupportEmailProcessingJob.findById(id);
  if (!job) throw coded('job_not_found', 404);
  if (!RETRYABLE.includes(job.state)) throw coded('job_not_retryable', 409);
  const updated = await enqueueJob({ emailId: job.emailId, stage: job.stage, requeue: true });
  await audit(admin, 'job_requeued', 'support_email_job', job._id, { stage: job.stage, previousState: job.state });
  return { id: String(updated._id), state: updated.state, stage: updated.stage };
}

async function health() {
  const [
    cursor,
    webhook,
    subscriptions,
    backlog,
    runs,
    storage,
    retention
  ] = await Promise.all([
    EmailSyncCursor.find().select('mailbox folder syncStatus lastSuccessfulSyncAt error').sort({ lastSuccessfulSyncAt: -1 }).limit(10).lean(),
    SupportEmailWebhookEvent.find().select('status changeType lifecycleEventType receivedAt errorCategory').sort({ receivedAt: -1 }).limit(1).lean(),
    GraphSubscription.find().select('mailbox folder status expirationDateTime subscriptionId').sort({ expirationDateTime: -1 }).limit(10).lean(),
    SupportEmailProcessingJob.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }]),
    SupportEmailRun.find({ runKey: 'phase3-process' }).select('startedAt finishedAt success activeLock').sort({ startedAt: -1 }).limit(5).lean(),
    SupportEmailAttachment.aggregate([
      { $group: { _id: null, files: { $sum: { $cond: [{ $ifNull: ['$storageKey', false] }, 1, 0] } }, bytes: { $sum: '$size' } } }
    ]),
    SupportEmailAttachment.find({ 'metadata.binaryPurgedAt': { $type: 'string' } })
      .select('metadata.binaryPurgedAt metadata.textPurgedAt')
      .sort({ updatedAt: -1 })
      .limit(1)
      .lean()
  ]);
  const latestSync = cursor.find((row) => row.lastSuccessfulSyncAt) || null;
  return {
    sync: {
      lastSuccessfulAt: latestSync ? latestSync.lastSuccessfulSyncAt : null,
      cursors: cursor.map((row) => ({
        mailbox: row.mailbox,
        folder: row.folder,
        status: row.syncStatus,
        lastSuccessfulAt: row.lastSuccessfulSyncAt,
        error: row.syncStatus === 'failed' ? row.error : null
      }))
    },
    webhook: webhook[0] ? {
      status: webhook[0].status,
      changeType: webhook[0].changeType,
      lifecycleEventType: webhook[0].lifecycleEventType,
      receivedAt: webhook[0].receivedAt,
      errorCategory: webhook[0].errorCategory
    } : null,
    subscriptions: subscriptions.map((row) => ({
      mailbox: row.mailbox,
      folder: row.folder,
      status: row.status,
      expiresAt: row.expirationDateTime,
      healthy: row.status === 'active' && new Date(row.expirationDateTime).getTime() > Date.now()
    })),
    queue: backlog.map((row) => ({ state: row._id, count: row.count })),
    processing: runs.map((row) => ({
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      success: row.success,
      active: row.activeLock
    })),
    storage: {
      files: storage[0] ? storage[0].files : 0,
      declaredBytes: storage[0] ? storage[0].bytes : 0
    },
    retention: {
      lastBinaryPurgeAt: retention[0] && retention[0].metadata ? retention[0].metadata.binaryPurgedAt : null,
      lastTextPurgeAt: retention[0] && retention[0].metadata ? retention[0].metadata.textPurgedAt : null,
      executionRecorded: Boolean(retention[0])
    }
  };
}

function safeDownloadType(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  if (mime === 'application/pdf' || mime === 'image/png' || mime === 'image/jpeg') return mime;
  return 'application/octet-stream';
}

async function openAttachment(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw coded('attachment_not_found', 404);
  const row = await SupportEmailAttachment.findById(id).lean();
  if (!row || !row.storageKey) throw coded('attachment_not_found', 404);
  const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
  return {
    stream: bucket.openDownloadStream(new ObjectId(row.storageKey)),
    name: row.name || 'attachment',
    contentType: safeDownloadType(row.contentType)
  };
}

module.exports = {
  resolveRange,
  overview,
  listTickets,
  ticketDetail,
  reviewTicket,
  listJobs,
  retryJob,
  health,
  openAttachment
};
