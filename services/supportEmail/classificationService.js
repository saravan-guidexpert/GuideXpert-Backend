'use strict';

const crypto = require('crypto');
const { OpenAiCompatibleProvider } = require('../ai/providers/OpenAiCompatibleProvider');
const SupportEmailAiRun = require('../../models/SupportEmailAiRun');
const SupportEmailAttachment = require('../../models/SupportEmailAttachment');
const { inspectUntrustedText } = require('./promptGuard');
const { buildClassificationMessages, PROMPT_KEY, PROMPT_VERSION } = require('./prompts/emailClassification.v1');
const { validateClassification, extractJsonObject, emptyClassification } = require('./classificationSchema');
const { loadEmail, setPipelineStage, codedError } = require('./bodyProcessingService');
const { STAGES } = require('../../constants/supportEmail');

function defaultChatCompletion() {
  const provider = new OpenAiCompatibleProvider({
    apiKeyEnv: 'LLM_API_KEY',
    baseUrlEnv: 'LLM_BASE_URL',
    modelEnv: 'SUPPORT_EMAIL_LLM_MODEL',
    fallbackModelEnv: 'LLM_MODEL'
  });
  return async function chatCompletion({ messages, temperature, maxTokens }) {
    const result = await provider.chatCompletion({
      messages,
      temperature,
      maxTokens,
      responseFormat: { type: 'json_object' }
    });
    return {
      content: String(result.text || '').trim(),
      model: result.model || null,
      usage: result.usage || null
    };
  };
}

function inputHash(email, attachmentText) {
  return crypto
    .createHash('sha256')
    .update(`${email.subject || ''}\n${email.bodyText || ''}\n${attachmentText}`)
    .digest('hex');
}

async function attachmentContext(emailId, config) {
  const rows = await SupportEmailAttachment.find({
    emailId,
    extractStatus: 'extracted',
    extractedText: { $type: 'string' }
  }).select('extractedText').lean();
  return rows
    .map((row) => row.extractedText)
    .filter(Boolean)
    .join('\n')
    .slice(0, config.maxPromptAttachmentChars);
}

function decideOutcome(validation, guard, config) {
  if (!validation.ok || validation.value.unclassified) {
    return { outcome: 'needs_review', value: emptyClassification(), reason: 'invalid_schema' };
  }
  const value = { ...validation.value };
  const lowConfidence = value.confidence < config.confidenceThreshold;
  if (guard.flagged || value.needsHumanReview || lowConfidence) {
    value.needsHumanReview = true;
    return { outcome: 'needs_review', value, reason: guard.flagged ? 'prompt_injection' : (lowConfidence ? 'low_confidence' : 'model_review') };
  }
  return { outcome: 'success', value, reason: null };
}

/**
 * Classifies one email. Invalid, low-confidence, and injection-flagged results
 * stay in manual review and are not treated as a confident classification.
 */
async function classifyEmail(emailId, deps = {}) {
  const email = await loadEmail(emailId);
  if (email.pipeline.ai === 'classified' || email.pipeline.ai === 'needs_review') {
    return {
      enqueue: STAGES.TICKET,
      outcome: email.pipeline.ai === 'classified' ? 'success' : 'needs_review'
    };
  }
  if (email.pipeline.ai === 'pending') await setPipelineStage(email, STAGES.AI, 'processing');
  const attachmentText = await attachmentContext(email._id, deps.config);
  const guard = inspectUntrustedText(`${email.subject || ''}\n${email.bodyText || ''}\n${attachmentText}`);
  const hash = inputHash(email, attachmentText);
  const chat = deps.chatCompletion || defaultChatCompletion();
  const messages = buildClassificationMessages({
    subject: email.subject,
    bodyText: email.bodyText,
    attachmentText,
    config: deps.config
  });

  const started = Date.now();
  let response;
  try {
    response = await chat({ messages, temperature: 0, maxTokens: 700 });
  } catch (err) {
    if (/LLM_API_KEY|LLM_BASE_URL|LLM_MODEL|SUPPORT_EMAIL_LLM_MODEL/.test(err.message || '')) {
      throw codedError('llm_not_configured');
    }
    throw codedError('llm_request_failed');
  }

  let validation = validateClassification(extractJsonObject(response.content));
  if (!validation.ok) {
    try {
      const repair = await chat({
        messages: messages.concat([{ role: 'user', content: 'The previous reply did not match the required JSON object. Return one JSON object only.' }]),
        temperature: 0,
        maxTokens: 700
      });
      validation = validateClassification(extractJsonObject(repair.content));
      response = repair;
    } catch (err) {
      throw codedError('llm_request_failed');
    }
  }

  const decision = decideOutcome(validation, guard, deps.config);
  const run = await SupportEmailAiRun.create({
    emailId: email._id,
    stage: STAGES.AI,
    model: response.model || process.env.SUPPORT_EMAIL_LLM_MODEL || process.env.LLM_MODEL || 'unconfigured',
    promptKey: PROMPT_KEY,
    promptVersion: PROMPT_VERSION,
    inputHash: hash,
    rawResponse: null,
    parsed: decision.value,
    confidence: decision.value.confidence,
    usage: {
      promptTokens: response.usage && response.usage.prompt_tokens || 0,
      completionTokens: response.usage && response.usage.completion_tokens || 0,
      totalTokens: response.usage && response.usage.total_tokens || 0
    },
    latencyMs: Date.now() - started,
    outcome: decision.outcome === 'success' ? 'success' : 'needs_review',
    error: decision.reason,
    metadata: { guardFlags: guard.reasons }
  });

  const fresh = await loadEmail(emailId);
  await setPipelineStage(fresh, STAGES.AI, decision.outcome === 'success' ? 'classified' : 'needs_review');
  return { enqueue: STAGES.TICKET, aiRunId: run._id, outcome: decision.outcome, classification: decision.value };
}

module.exports = {
  classifyEmail,
  defaultChatCompletion
};
