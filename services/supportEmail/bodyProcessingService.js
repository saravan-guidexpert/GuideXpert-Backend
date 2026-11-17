'use strict';

const { GraphClient } = require('./graphClient');
const SupportEmail = require('../../models/SupportEmail');
const { sanitizeEmailBody } = require('./bodySanitizer');
const { buildContentHash } = require('./dedupeService');
const { assertValidPipelineTransition, deriveOverallPipelineState } = require('./stateMachine');
const { STAGES } = require('../../constants/supportEmail');

const MESSAGE_SELECT = [
  'id',
  'internetMessageId',
  'conversationId',
  'receivedDateTime',
  'sentDateTime',
  'subject',
  'bodyPreview',
  'body',
  'hasAttachments',
  'from',
  'toRecipients',
  'ccRecipients',
  'importance',
  'isRead',
  'isDraft'
].join(',');

function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function createGraphGateway(client) {
  if (client && typeof client.get !== 'function') return client;
  const graph = client || new GraphClient();
  return {
    async getMessage(mailbox, messageId) {
      return graph.get(
        `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`,
        { params: { $select: MESSAGE_SELECT } }
      );
    },
    async listAttachments(mailbox, messageId) {
      return graph.get(
        `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`,
        { params: { $select: 'id,name,contentType,size,isInline' } }
      );
    },
    async getAttachment(mailbox, messageId, attachmentId) {
      return graph.get(
        `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
      );
    },
    async openAttachmentStream(mailbox, messageId, attachmentId, options = {}) {
      return graph.openByteStream(
        `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
        options
      );
    }
  };
}

async function setPipelineStage(email, stage, nextStatus) {
  const current = (email.pipeline && email.pipeline[stage]) || 'pending';
  assertValidPipelineTransition(stage, current, nextStatus);
  email.pipeline[stage] = nextStatus;
  email.pipeline.state = deriveOverallPipelineState(email.pipeline, email.hasAttachments);
  email.pipeline.updatedAt = new Date();
  email.markModified('pipeline');
  await email.save();
  return email;
}

/**
 * Fetches one message body with a read-only Graph GET and stores bounded sanitized content.
 * A second run for an already fetched message does not call Graph again.
 */
async function processEmailBody(email, deps = {}) {
  if (!email) throw codedError('email_missing');
  if (email.pipeline && email.pipeline.fetch === 'fetched' && email.bodyText) {
    return { alreadyFetched: true, enqueue: email.hasAttachments ? STAGES.ATTACHMENTS : STAGES.AI };
  }

  const mailbox = email.metadata && email.metadata.mailbox;
  if (!mailbox) throw codedError('mailbox_missing');
  const gateway = createGraphGateway(deps.graphClient);
  const message = await gateway.getMessage(mailbox, email.graphMessageId);
  if (!message || message['@removed']) throw codedError('message_unavailable');

  const body = message.body || {};
  const sanitized = sanitizeEmailBody({
    content: body.content || message.bodyPreview || '',
    contentType: body.contentType || 'text',
    maxText: deps.config.maxBodyTextLength,
    maxHtml: deps.config.maxBodyHtmlSnippetLength
  });
  if (!sanitized.text && message.bodyPreview) {
    sanitized.text = String(message.bodyPreview).slice(0, deps.config.maxBodyTextLength);
  }

  email.bodyText = sanitized.text;
  email.bodyHtmlSnippet = sanitized.htmlSnippet;
  email.hasAttachments = Boolean(message.hasAttachments);
  email.contentHash = buildContentHash({
    from: email.from,
    subject: email.subject,
    bodyText: sanitized.text
  });
  await setPipelineStage(email, STAGES.FETCH, 'fetched');
  if (!email.hasAttachments) {
    await setPipelineStage(email, STAGES.ATTACHMENTS, 'extracted');
  }
  return {
    alreadyFetched: false,
    enqueue: email.hasAttachments ? STAGES.ATTACHMENTS : STAGES.AI
  };
}

async function loadEmail(emailId) {
  const email = await SupportEmail.findById(emailId);
  if (!email) throw codedError('email_missing');
  return email;
}

module.exports = {
  createGraphGateway,
  setPipelineStage,
  processEmailBody,
  loadEmail,
  codedError
};
