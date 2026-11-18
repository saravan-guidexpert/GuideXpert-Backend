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
const GraphSubscription = require('../../models/GraphSubscription');
const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const { APPROVED_MAILBOX, mailboxScopeStatus } = require('./mailboxScopeService');
const { isBulkProcessingEnabled } = require('./processingConfig');
const { validDate } = require('./ingestionSafety');
const { ACTIVATION_TIME_ZONE, formatActivationLocal } = require('./activationTime');
const EmailSyncCursor = require('../../models/EmailSyncCursor');
const { BUCKET_NAME } = require('./attachmentStorage');
const { enqueueJob } = require('./queueService');
const {
  TICKET_CATEGORIES,
  DEFAULT_TICKET_CATEGORY,
  normalizeTicketCategory,
  isKnownTicketCategory,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  JOB_STATES
} = require('../../constants/supportEmail');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 366 * DAY_MS;
const MAX_PAGE_SIZE = 50;
const RECENT_LIMIT = 8;
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

function receivedRange(query = {}) {
  const parts = {};
  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) throw coded('invalid_range');
    parts.$gte = startOfDay(from);
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) throw coded('invalid_range');
    parts.$lte = endOfDay(to);
  }
  if (parts.$gte && parts.$lte && parts.$gte > parts.$lte) throw coded('invalid_range');
  if (parts.$gte && parts.$lte && parts.$lte.getTime() - parts.$gte.getTime() > MAX_RANGE_MS) throw coded('range_too_large');
  return Object.keys(parts).length ? parts : null;
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
    ticket: source.ticket || 'pending'
  };
}

/** Groups on the persisted ticket category, folding missing or unknown values into the default. */
function categoryExpression() {
  return {
    $cond: [{ $in: [{ $ifNull: ['$category', null] }, TICKET_CATEGORIES] }, '$category', DEFAULT_TICKET_CATEGORY]
  };
}

const AUDIT_METADATA_KEYS = ['outcome', 'testMode', 'promptVersion', 'stage', 'previousState', 'noted', 'graphGets', 'attachmentGets'];

function publicAudit(row, adminNames) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const safe = {};
  AUDIT_METADATA_KEYS.forEach((key) => {
    if (metadata[key] !== undefined && typeof metadata[key] !== 'object') safe[key] = metadata[key];
  });
  ['before', 'after'].forEach((key) => {
    if (metadata[key] && typeof metadata[key] === 'object') {
      safe[key] = {
        category: metadata[key].category,
        priority: metadata[key].priority,
        status: metadata[key].status
      };
    }
  });
  return {
    id: String(row._id),
    action: row.action,
    targetType: row.targetType,
    actor: row.adminId ? (adminNames.get(String(row.adminId)) || 'admin') : 'system',
    createdAt: row.createdAt,
    details: safe
  };
}

/** Merges queue jobs, AI run summaries (never raw responses) and single-email test entries by time. */
function buildProcessingHistory({ jobs, aiRuns, auditRows }) {
  const entries = [];
  jobs.forEach((row) => entries.push({
    kind: 'job',
    stage: row.stage,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    error: row.deadLetterReason || row.lastError || null,
    at: row.completedAt || row.updatedAt || row.createdAt
  }));
  aiRuns.forEach((row) => entries.push({
    kind: 'ai_run',
    stage: 'ai',
    state: row.outcome,
    model: row.model,
    promptVersion: row.promptVersion,
    confidence: row.confidence,
    latencyMs: row.latencyMs,
    totalTokens: row.usage ? row.usage.totalTokens : 0,
    error: row.error || null,
    at: row.createdAt
  }));
  auditRows.filter((row) => row.action === 'single_email_test').forEach((row) => entries.push({
    kind: 'single_email_test',
    stage: 'single_email_test',
    state: row.metadata && row.metadata.outcome ? row.metadata.outcome : 'completed',
    promptVersion: row.metadata ? row.metadata.promptVersion : undefined,
    error: null,
    at: row.createdAt
  }));
  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function publicClassification(run) {
  const parsed = run && run.parsed && typeof run.parsed === 'object' ? run.parsed : {};
  return {
    summary: parsed.summary || '',
    category: normalizeTicketCategory(parsed.category),
    subcategory: parsed.subcategory || '',
    intent: parsed.intent || '',
    sentiment: parsed.sentiment || '',
    priority: parsed.priority || '',
    urgency: parsed.urgency || '',
    confidence: run ? run.confidence : null,
    recommendedAction: parsed.recommendedAction || '',
    needsHumanReview: Boolean(parsed.needsHumanReview) || !isKnownTicketCategory(parsed.category) || (run && run.outcome === 'needs_review'),
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
    category,
    priority,
    ai,
    emailTrend,
    failureTrend,
    recentTickets,
    recentFailures
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
    SupportTicket.aggregate([
      { $match: ticketMatch },
      { $group: { _id: categoryExpression(), count: { $sum: 1 } } },
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
    ]),
    SupportTicket.find(ticketMatch)
      .select('ticketNumber category priority status primaryEmailId createdAt')
      .sort({ createdAt: -1 })
      .limit(RECENT_LIMIT)
      .lean(),
    SupportEmailProcessingJob.find({
      updatedAt: { $gte: range.from, $lte: range.to },
      state: { $in: [JOB_STATES.FAILED, JOB_STATES.DEAD_LETTER] }
    })
      .select('emailId stage state attempts maxAttempts lastError deadLetterReason updatedAt')
      .sort({ updatedAt: -1 })
      .limit(RECENT_LIMIT)
      .lean()
  ]);
  const recentEmails = await SupportEmail.find({
    _id: { $in: [...recentTickets.map((row) => row.primaryEmailId), ...recentFailures.map((row) => row.emailId)].filter(Boolean) }
  }).select('subject from receivedDateTime').lean();
  const recentEmailById = new Map(recentEmails.map((row) => [String(row._id), row]));
  return {
    range,
    recentTickets: recentTickets.map((row) => {
      const email = recentEmailById.get(String(row.primaryEmailId));
      return {
        id: String(row._id),
        ticketNumber: row.ticketNumber,
        subject: email ? email.subject : '',
        sender: email ? publicSender(email.from) : { name: '', email: '' },
        category: normalizeTicketCategory(row.category),
        priority: row.priority,
        status: row.status,
        receivedAt: email ? email.receivedDateTime : row.createdAt
      };
    }),
    recentFailures: recentFailures.map((row) => {
      const email = recentEmailById.get(String(row.emailId));
      return {
        id: String(row._id),
        emailId: String(row.emailId),
        subject: email ? email.subject : '',
        stage: row.stage,
        state: row.state,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        reason: row.deadLetterReason || row.lastError || null,
        updatedAt: row.updatedAt
      };
    }),
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
    filter.category = query.category === DEFAULT_TICKET_CATEGORY
      ? { $nin: TICKET_CATEGORIES.filter((item) => item !== DEFAULT_TICKET_CATEGORY) }
      : query.category;
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
  const received = receivedRange(query);
  const sort = query.sort === 'priority'
    ? { priorityRank: -1, updatedAt: -1 }
    : { [query.sort === 'updated' ? 'updatedAt' : 'createdAt']: query.direction === 'asc' ? 1 : -1 };
  const priorityRank = { $switch: {
    branches: [
      { case: { $eq: ['$priority', 'urgent'] }, then: 4 },
      { case: { $eq: ['$priority', 'high'] }, then: 3 },
      { case: { $eq: ['$priority', 'medium'] }, then: 2 },
      { case: { $eq: ['$priority', 'low'] }, then: 1 }
    ],
    default: 0
  } };
  const match = [{ $match: filter }];
  if (received) {
    match.push(
      {
        $lookup: {
          from: SupportEmail.collection.name,
          localField: 'primaryEmailId',
          foreignField: '_id',
          as: 'receivedEmail',
          pipeline: [{ $project: { receivedDateTime: 1 } }]
        }
      },
      { $match: { 'receivedEmail.receivedDateTime': received } }
    );
  }
  const pipeline = [
    ...match,
    { $addFields: { priorityRank } },
    { $sort: sort },
    { $skip: paging.skip },
    { $limit: paging.limit },
    { $project: { receivedEmail: 0 } }
  ];
  const [rows, countRows] = await Promise.all([
    SupportTicket.aggregate(pipeline),
    SupportTicket.aggregate([...match, { $count: 'total' }])
  ]);
  const total = countRows[0] ? countRows[0].total : 0;
  const emailIds = rows.map((row) => row.primaryEmailId).filter(Boolean);
  const emails = await SupportEmail.find({ _id: { $in: emailIds } }).select('subject from receivedDateTime pipeline').lean();
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
    pages: Math.max(1, Math.ceil(total / paging.limit)),
    tickets: rows.map((row) => {
      const email = byId.get(String(row.primaryEmailId));
      const assignee = row.assignedTo ? adminById.get(String(row.assignedTo)) : null;
      return {
        id: String(row._id),
        ticketNumber: row.ticketNumber,
        subject: email ? email.subject : '',
        sender: email ? publicSender(email.from) : { name: row.requester && row.requester.name, email: row.requester && row.requester.email },
        category: normalizeTicketCategory(row.category),
        priority: row.priority,
        status: row.status,
        processingStatus: email && email.pipeline && email.pipeline.state ? email.pipeline.state : 'received',
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
    .select('subject from receivedDateTime bodyText conversationId pipeline toRecipients ccRecipients internetMessageId graphMessageId')
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
  const emailIds = ticket.emailIds || [];
  const targetIds = [String(ticket._id), ...emailIds.map(String), ...emails.map((row) => row.graphMessageId).filter(Boolean)];
  const [aiRun, attachments, events, jobs, aiRuns, auditRows] = await Promise.all([
    ticket.aiRunId ? SupportEmailAiRun.findById(ticket.aiRunId).select('parsed confidence outcome error').lean() : null,
    SupportEmailAttachment.find({ emailId: { $in: ticket.emailIds } })
      .select('name contentType size scanStatus extractStatus extractError pageCount storageKey extractedText')
      .lean(),
    SupportTicketEvent.find({ ticketId: ticket._id }).sort({ createdAt: -1 }).limit(20).lean(),
    SupportEmailProcessingJob.find({ emailId: { $in: emailIds } })
      .select('stage state attempts maxAttempts lastError deadLetterReason createdAt updatedAt completedAt')
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(),
    SupportEmailAiRun.find({ emailId: { $in: emailIds } })
      .select('model promptVersion outcome confidence latencyMs usage error createdAt')
      .sort({ createdAt: 1 })
      .limit(20)
      .lean(),
    SupportEmailAuditLog.find({ $or: [{ targetId: { $in: targetIds } }, { 'metadata.ticketId': String(ticket._id) }] })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean()
  ]);
  const auditAdmins = auditRows.map((row) => row.adminId).filter(Boolean);
  const adminRows = auditAdmins.length ? await Admin.find({ _id: { $in: auditAdmins } }).select('name username').lean() : [];
  const adminNames = new Map(adminRows.map((row) => [String(row._id), row.name || row.username]));
  const auditHistory = auditRows.map((row) => publicAudit(row, adminNames));
  const processingHistory = buildProcessingHistory({ jobs, aiRuns, auditRows });
  const failedJobs = jobs.filter((row) => row.lastError || row.deadLetterReason);
  const lastFailedJob = failedJobs.length ? failedJobs[failedJobs.length - 1] : null;
  return {
    id: String(ticket._id),
    ticketNumber: ticket.ticketNumber,
    category: normalizeTicketCategory(ticket.category),
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
    recipients: {
      to: primary ? (primary.toRecipients || []).map(publicSender) : [],
      cc: primary ? (primary.ccRecipients || []).map(publicSender) : []
    },
    internetMessageId: primary ? primary.internetMessageId || '' : '',
    retry: {
      totalAttempts: jobs.reduce((sum, row) => sum + (row.attempts || 0), 0),
      failedJobs: jobs.filter((row) => row.state === JOB_STATES.FAILED || row.state === JOB_STATES.DEAD_LETTER).length,
      lastError: lastFailedJob ? (lastFailedJob.deadLetterReason || lastFailedJob.lastError) : null
    },
    auditHistory,
    processingHistory,
    conversation: conversation.map((row) => ({
      id: String(row._id),
      subject: row.subject,
      sender: publicSender(row.from),
      receivedAt: row.receivedDateTime,
      bodyText: row.bodyText || ''
    })),
    classification: publicClassification(aiRun),
    attachments: attachments.map((row) => publicAttachment(row, true)),
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
  const [rows, total, attachmentFailures, graphFailures, stateCounts] = await Promise.all([
    SupportEmailProcessingJob.find(filter).sort({ updatedAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    SupportEmailProcessingJob.countDocuments(filter),
    SupportEmailAttachment.find({ extractStatus: { $in: ['failed', 'corrupted'] } })
      .select('name extractStatus extractError emailId updatedAt')
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
    EmailSyncCursor.find({ syncStatus: 'failed' }).select('mailbox folder syncStatus error updatedAt').limit(20).lean(),
    SupportEmailProcessingJob.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }])
  ]);
  const counts = { pending: 0, claimed: 0, processing: 0, failed: 0, dead_letter: 0, completed: 0 };
  stateCounts.forEach((row) => { if (row._id in counts) counts[row._id] = row.count; });
  return {
    counts,
    startsWorker: false,
    page: paging.page,
    limit: paging.limit,
    total,
    jobs: rows.map((row) => ({
      id: String(row._id),
      emailId: String(row.emailId),
      stage: row.stage,
      state: row.state,
      reason: row.deadLetterReason || row.lastError || null,
      lastError: row.lastError || null,
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
  if (job.stage === 'sheets') throw coded('stage_disconnected', 409);
  const updated = await enqueueJob({ emailId: job.emailId, stage: job.stage, requeue: true });
  await audit(admin, 'job_requeued', 'support_email_job', job._id, { stage: job.stage, previousState: job.state });
  return { id: String(updated._id), state: updated.state, stage: updated.stage };
}

const SCOPE_BLOCKER_TEXT = 'MAILBOX_SCOPE_UNVERIFIED: Exchange Online application RBAC for support@niatindia.com is not recorded. This restricts which mailbox the application can read. It does not change Outlook delivery, forwarding, or user permissions. A Microsoft 365 administrator must configure and verify that restriction before any message is retrieved.';

function healthItem(key, label, verified, detail, extra = {}) {
  return { key, label, verified, detail, ...extra };
}

async function storageProbe() {
  const db = mongoose.connection && mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
  if (!db) return { verified: 'unknown', detail: 'Database is not connected, so attachment storage cannot be checked.' };
  try {
    const files = await db.collection(`${BUCKET_NAME}.files`).estimatedDocumentCount();
    return { verified: true, detail: `Attachment storage is readable (${files} stored files).` };
  } catch (error) {
    return { verified: false, detail: 'Attachment storage could not be read.' };
  }
}

/**
 * Builds structured health rows. A row is verified true only when something observed it.
 * Anything that was not observed is 'unknown' and must never be presented as healthy.
 */
async function buildHealthItems(data, lastGraphCheck) {
  const items = [];
  if (!lastGraphCheck) {
    items.push(healthItem('graph_auth', 'Graph authentication', 'unknown', 'The Graph token test has not been run. A Super Admin can run it from this page.'));
  } else if (lastGraphCheck.metadata && lastGraphCheck.metadata.ok === true) {
    items.push(healthItem('graph_auth', 'Graph authentication', true, 'Last token test succeeded.', { checkedAt: lastGraphCheck.createdAt }));
  } else {
    items.push(healthItem('graph_auth', 'Graph authentication', false, 'Last token test failed.', { checkedAt: lastGraphCheck.createdAt }));
  }

  const policy = data.policies.find((row) => row.mailbox === APPROVED_MAILBOX);
  const activation = validDate(policy && policy.activationAt);
  const activationLabel = activation ? `${formatActivationLocal(activation)} (${ACTIVATION_TIME_ZONE}), stored as ${activation.toISOString()}` : '';
  if (!policy) {
    items.push(healthItem('mailbox_policy', 'Mailbox policy', false, 'Missing policy. A Super Admin must create an ingestion policy for support@niatindia.com and approve an activation time.'));
  } else if (!policy.activationAt) {
    items.push(healthItem('mailbox_policy', 'Mailbox policy', false, `Policy status: ${policy.enabled ? 'enabled' : 'disabled'}. Missing activation timestamp. Choose a time and approve it. Mail received before that time is rejected.`));
  } else if (!activation) {
    items.push(healthItem('mailbox_policy', 'Mailbox policy', false, `Policy status: ${policy.enabled ? 'enabled' : 'disabled'}. Invalid activation timestamp. Enter a real date and time and approve it.`));
  } else if (policy.enabled !== true) {
    items.push(healthItem('mailbox_policy', 'Mailbox policy', false, `Policy status: disabled. Activation ${activationLabel}. Ingestion stays blocked until a Super Admin enables this policy.`, { activationAt: policy.activationAt }));
  } else {
    items.push(healthItem('mailbox_policy', 'Mailbox policy', true, `Policy status: enabled. Activation ${activationLabel}.`, { activationAt: policy.activationAt }));
  }

  const bulkOn = isBulkProcessingEnabled();
  items.push(healthItem(
    'bulk_processing',
    'Bulk processing',
    bulkOn ? false : true,
    bulkOn
      ? 'Global processing is enabled because SUPPORT_EMAIL_PROCESSING_ENABLED is 1. Set it to 0 so the normal worker stays off. The single-email test does not start that worker.'
      : 'Global processing is disabled. SUPPORT_EMAIL_PROCESSING_ENABLED is not 1, so the normal worker does not run.'
  ));

  const scope = mailboxScopeStatus();
  items.push(healthItem(
    'exchange_scope',
    'Exchange mailbox scope',
    scope.status === 'VERIFIED',
    scope.status === 'VERIFIED' ? 'An administrator recorded that the app is scoped to the approved mailbox.' : SCOPE_BLOCKER_TEXT,
    { value: scope.status }
  ));

  if (!data.webhook) {
    items.push(healthItem('webhook', 'Webhook', 'unknown', 'No webhook event has been received yet. A validation handshake alone does not prove live delivery.'));
  } else if (data.webhook.errorCategory) {
    items.push(healthItem('webhook', 'Webhook', false, `Last webhook event failed (${data.webhook.errorCategory}).`, { receivedAt: data.webhook.receivedAt }));
  } else {
    items.push(healthItem('webhook', 'Webhook', true, 'A webhook event was received and recorded.', { receivedAt: data.webhook.receivedAt }));
  }

  const liveSubscription = data.subscriptions.find((row) => row.mailbox === APPROVED_MAILBOX && row.healthy);
  if (liveSubscription) {
    items.push(healthItem('subscription', 'Graph subscription', true, 'An active subscription exists for the approved mailbox.', { expiresAt: liveSubscription.expiresAt }));
  } else {
    items.push(healthItem('subscription', 'Graph subscription', false, 'No active, unexpired subscription is recorded for the approved mailbox.'));
  }

  const syncFailed = data.sync.cursors.find((row) => row.status === 'failed');
  if (syncFailed) {
    items.push(healthItem('last_sync', 'Last mailbox sync', false, 'The latest sync failed.', { error: syncFailed.error }));
  } else if (data.sync.lastSuccessfulAt) {
    items.push(healthItem('last_sync', 'Last mailbox sync', true, 'A sync completed successfully.', { at: data.sync.lastSuccessfulAt }));
  } else {
    items.push(healthItem('last_sync', 'Last mailbox sync', 'unknown', 'No successful sync is recorded.'));
  }

  const queue = Object.fromEntries(data.queue.map((row) => [row.state, row.count]));
  const stuck = (queue.failed || 0) + (queue.dead_letter || 0);
  items.push(healthItem(
    'queue',
    'Processing queue',
    stuck === 0,
    stuck === 0 ? `Queue has ${queue.pending || 0} pending jobs and no failures.` : `${stuck} jobs are failed or dead-lettered.`,
    { pending: queue.pending || 0, failed: queue.failed || 0, deadLetter: queue.dead_letter || 0 }
  ));

  const connected = mongoose.connection.readyState === 1;
  items.push(healthItem('database', 'Database', connected, connected ? 'Database connection is open.' : 'Database connection is not open.'));

  const storage = await storageProbe();
  items.push(healthItem('storage', 'Attachment storage', storage.verified, storage.detail));

  const lastRun = data.processing[0];
  if (!lastRun) {
    items.push(healthItem('last_processing_run', 'Last processing run', 'unknown', 'The processing worker has not run.'));
  } else {
    items.push(healthItem('last_processing_run', 'Last processing run', lastRun.success === true, lastRun.success === true ? 'Last run finished successfully.' : 'Last run did not finish successfully.', { at: lastRun.finishedAt || lastRun.startedAt }));
  }
  return items;
}

async function health() {
  const [
    cursor,
    policies,
    webhook,
    subscriptions,
    backlog,
    runs,
    storage,
    retention,
    lastGraphCheck
  ] = await Promise.all([
    EmailSyncCursor.find().select('mailbox folder syncStatus lastSuccessfulSyncAt baselineCompletedAt activationAt deltaLink error').sort({ lastSuccessfulSyncAt: -1 }).limit(10).lean(),
    EmailIngestionPolicy.find().select('mailbox enabled activationAt activationApprovedAt activationApprovedBy baselineCompletedAt').sort({ mailbox: 1 }).lean(),
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
      .lean(),
    SupportEmailAuditLog.findOne({ action: 'graph_auth_diagnostic' }).select('metadata createdAt').sort({ createdAt: -1 }).lean()
  ]);
  const latestSync = cursor.find((row) => row.lastSuccessfulSyncAt) || null;
  const approverIds = policies.map((row) => row.activationApprovedBy).filter(Boolean);
  const approvers = approverIds.length ? await Admin.find({ _id: { $in: approverIds } }).select('name username').lean() : [];
  const approverNames = new Map(approvers.map((row) => [String(row._id), row.name || row.username]));
  const result = {
    sync: {
      lastSuccessfulAt: latestSync ? latestSync.lastSuccessfulSyncAt : null,
      cursors: cursor.map((row) => ({
        mailbox: row.mailbox,
        folder: row.folder,
        status: row.syncStatus,
        lastSuccessfulAt: row.lastSuccessfulSyncAt,
        activationAt: row.activationAt,
        baselineCompletedAt: row.baselineCompletedAt,
        hasDeltaLink: Boolean(row.deltaLink),
        error: row.syncStatus === 'failed' ? row.error : null
      }))
    },
    ingestion: {
      approvedMailbox: APPROVED_MAILBOX,
      mailboxScope: mailboxScopeStatus().status,
      processingEnabled: isBulkProcessingEnabled(),
      processingFlag: String(process.env.SUPPORT_EMAIL_PROCESSING_ENABLED == null ? '' : process.env.SUPPORT_EMAIL_PROCESSING_ENABLED).trim(),
      policies: policies.map((row) => {
        const activation = validDate(row.activationAt);
        return {
          mailbox: row.mailbox,
          enabled: row.enabled === true,
          status: row.enabled === true ? 'enabled' : 'disabled',
          activationAt: activation,
          activationTimeZone: ACTIVATION_TIME_ZONE,
          activationLocal: activation ? formatActivationLocal(activation) : '',
          activationApprovedAt: row.activationApprovedAt || null,
          configuredBy: row.activationApprovedBy ? {
            id: String(row.activationApprovedBy),
            name: approverNames.get(String(row.activationApprovedBy)) || 'admin'
          } : null,
          baselineCompletedAt: row.baselineCompletedAt,
          approved: row.mailbox === APPROVED_MAILBOX
        };
      })
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
  result.items = await buildHealthItems({
    policies: result.ingestion.policies,
    webhook: result.webhook,
    subscriptions: result.subscriptions,
    sync: result.sync,
    queue: result.queue,
    processing: result.processing
  }, lastGraphCheck);
  result.summary = {
    verified: result.items.filter((item) => item.verified === true).length,
    failed: result.items.filter((item) => item.verified === false).length,
    unknown: result.items.filter((item) => item.verified === 'unknown').length
  };
  return result;
}

async function recordGraphDiagnostic(admin, graph) {
  await audit(admin, 'graph_auth_diagnostic', 'graph_authentication', 'graph', {
    ok: Boolean(graph && graph.ok),
    code: graph && graph.code
  });
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
  recordGraphDiagnostic,
  openAttachment
};
