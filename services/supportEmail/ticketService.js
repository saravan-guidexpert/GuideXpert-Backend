'use strict';

const SupportTicket = require('../../models/SupportTicket');
const SupportTicketEvent = require('../../models/SupportTicketEvent');
const SupportEmailAiRun = require('../../models/SupportEmailAiRun');
const SupportEmailAttachment = require('../../models/SupportEmailAttachment');
const { buildTicketDedupeKey } = require('./dedupeService');
const { generateTicketNumber } = require('./ticketNumberService');
const { loadEmail, setPipelineStage, codedError } = require('./bodyProcessingService');
const { emptyClassification } = require('./classificationSchema');
const { STAGES, normalizeTicketCategory, isKnownTicketCategory } = require('../../constants/supportEmail');

function ticketStatus(classification) {
  if (!classification) return 'needs_review';
  return classification.needsHumanReview || !isKnownTicketCategory(classification.category) ? 'needs_review' : 'open';
}

function ticketFields(email, classification, aiRunId, attachmentIds) {
  const student = classification.studentIdentifiers || {};
  return {
    primaryEmailId: email._id,
    requester: {
      name: (email.from && email.from.name) || '',
      email: (email.from && email.from.address) || '',
      phone: student.phone || ''
    },
    student: {
      name: student.name || '',
      email: student.email || '',
      phone: student.phone || '',
      rollNumber: student.rollNumber || '',
      course: student.course || ''
    },
    enquiry: {
      summary: classification.summary || '',
      details: ''
    },
    category: normalizeTicketCategory(classification.category),
    subCategory: classification.subcategory || '',
    priority: classification.priority || 'medium',
    sentiment: classification.sentiment || 'neutral',
    confidence: classification.confidence,
    status: ticketStatus(classification),
    taxonomyVersion: '1.0',
    aiRunId: aiRunId || null,
    tags: ticketStatus(classification) === 'needs_review' ? ['manual_review'] : [],
    metadata: {
      intent: classification.intent || '',
      urgency: classification.urgency || '',
      recommendedAction: classification.recommendedAction || '',
      attachmentIds,
      unclassified: Boolean(classification.unclassified)
    }
  };
}

async function latestClassification(email) {
  const run = await SupportEmailAiRun.findOne({ emailId: email._id }).sort({ createdAt: -1 }).lean();
  if (run && run.parsed) return { classification: run.parsed, aiRunId: run._id };
  return { classification: emptyClassification(), aiRunId: null };
}

/**
 * Creates or links a ticket from the source email. Duplicate workers converge
 * on the unique dedupe key. This function never sends a reply.
 */
async function markSheetsDisconnected(email, sheetsState) {
  if (sheetsState === 'pending') return;
  if ((email.pipeline && email.pipeline.sheets) === 'pending') {
    await setPipelineStage(email, STAGES.SHEETS, sheetsState);
  }
}

async function createTicketForEmail(emailId, options = {}) {
  const sheetsState = options.sheetsState || 'not_used';
  const email = await loadEmail(emailId);
  if (['created', 'linked', 'merged'].includes(email.pipeline.ticket)) {
    const existing = await SupportTicket.findOne({ emailIds: email._id }).lean();
    await markSheetsDisconnected(email, sheetsState);
    return { outcome: email.pipeline.ticket, ticketId: existing && existing._id };
  }

  const { classification, aiRunId } = await latestClassification(email);
  const dedupeKey = buildTicketDedupeKey({
    conversationId: email.conversationId,
    fromAddress: email.from && email.from.address,
    subject: email.subject,
    receivedDateTime: email.receivedDateTime
  });
  const attachmentIds = (await SupportEmailAttachment.find({ emailId: email._id }).select('_id').lean())
    .map((row) => row._id);

  let ticket = await SupportTicket.findOne({ dedupeKey });
  let outcome = 'linked';
  if (!ticket) {
    try {
      ticket = await SupportTicket.create({
        ticketNumber: await generateTicketNumber({ date: email.receivedDateTime || new Date() }),
        dedupeKey,
        emailIds: [email._id],
        ...ticketFields(email, classification, aiRunId, attachmentIds)
      });
      outcome = 'created';
      await SupportTicketEvent.create({
        ticketId: ticket._id,
        type: 'created',
        actorType: classification.unclassified ? 'system' : 'ai',
        after: { status: ticket.status, category: ticket.category },
        metadata: { emailId: String(email._id) }
      });
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      ticket = await SupportTicket.findOne({ dedupeKey });
      if (!ticket) throw codedError('ticket_conflict');
      outcome = 'linked';
    }
  }

  if (outcome === 'linked') {
    await SupportTicket.updateOne({ _id: ticket._id }, { $addToSet: { emailIds: email._id } });
    const linked = await SupportTicketEvent.findOne({
      ticketId: ticket._id,
      type: 'linked_email',
      'metadata.emailId': String(email._id)
    }).lean();
    if (!linked) {
      await SupportTicketEvent.create({
        ticketId: ticket._id,
        type: 'linked_email',
        actorType: 'system',
        metadata: { emailId: String(email._id) }
      });
    }
  }

  await setPipelineStage(email, STAGES.TICKET, outcome === 'created' ? 'created' : 'linked');
  await markSheetsDisconnected(email, sheetsState);
  return { outcome, ticketId: ticket._id };
}

module.exports = {
  createTicketForEmail
};
