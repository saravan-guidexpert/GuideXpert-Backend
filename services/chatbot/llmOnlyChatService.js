'use strict';

/**
 * LLM-only WhatsApp chatbot pipeline.
 *
 * Every reply comes from the OpenAI API using ONLY the system prompt saved in
 * the admin panel (AppSettings key `flowV3SystemPrompt`; the bundled
 * prompts/system_prompt.v1.md file is the offline fallback when Mongo has no
 * saved prompt). No flows, no knowledge bases, no routing, no translation.
 *
 * The only deterministic behavior kept is WhatsApp STOP/START compliance.
 * Lead facts are extracted each turn and injected as a KNOWN_PROFILE block so
 * the model never re-asks answered questions (Section 4 of the system prompt).
 */

const WhatsAppInboundMessage = require('../../models/WhatsAppInboundMessage');
const WhatsAppOutboundMessage = require('../../models/WhatsAppOutboundMessage');
const { getSystemPromptSetting, readPromptFileSync } = require('../../utils/systemPromptSettings');
const { chatCompletion } = require('../ai/llmClient');
const whatsappOutbound = require('./whatsappOutboundService');
const { getBotState, transitionState } = require('./botStateService');
const {
  extractProfilePatch,
  mergeProfile,
  buildKnownProfileBlock,
  sanitizeProfile,
} = require('./leadProfileMemoryService');
const {
  TYPE_COLLEGE,
  TYPE_RANK,
  emptyPredictorSession,
  detectPredictorIntent,
  buildCollegeSlotsFromProfile,
  buildRankSlotsFromProfile,
  extractPredictorSlotPatch,
  mergeCollegeSlots,
  mergeRankSlots,
  buildPredictorChecklistBlock,
  runCollegePrediction,
  runRankPrediction,
  isSessionActive,
  isSessionReady,
} = require('./predictorToolService');
const { syncLeadIntelligenceSafe } = require('./leadIntelligence/leadIntelligenceSyncService');
const { maskPhoneTail } = require('../../utils/chatbotPhone');

const STOP_RE = /^\s*(stop|unsubscribe|opt\s*out|optout)\s*$/i;
const START_RE = /^\s*(start|resume|subscribe)\s*$/i;

const OPT_OUT_REPLY =
  'You have been unsubscribed and will not receive further messages. Reply START anytime to resume.';
const ERROR_REPLY =
  'Sorry, I could not process that right now. Please try again in a moment.';

/** Default: LLM-only pipeline production cutover (2026-08-01T13:30:00Z). */
const DEFAULT_HISTORY_SINCE = '2026-08-01T13:30:00.000Z';

/**
 * Messages created before this epoch never reach the LLM (old-flow pollution
 * filter). Override with env CHATBOT_HISTORY_SINCE (ISO-8601).
 */
function historyEpoch() {
  const raw = String(process.env.CHATBOT_HISTORY_SINCE || '').trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(DEFAULT_HISTORY_SINCE);
}

function historyLimit() {
  const n = parseInt(process.env.CHATBOT_HISTORY_MESSAGES || '16', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 40) : 16;
}

function llmMaxTokens() {
  const n = parseInt(process.env.CHATBOT_LLM_MAX_TOKENS || '600', 10);
  return Number.isFinite(n) && n > 0 ? n : 600;
}

function llmTimeoutMs() {
  const n = parseInt(process.env.CHATBOT_LLM_TIMEOUT_MS || '8000', 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

function llmTemperature() {
  const n = Number(process.env.CHATBOT_LLM_TEMPERATURE);
  return Number.isFinite(n) ? n : 0.4;
}

/**
 * Admin-panel prompt (Mongo) with bundled-file fallback.
 */
async function loadSystemPrompt() {
  const fromDb = await getSystemPromptSetting();
  if (fromDb && fromDb.text) return fromDb.text;
  const fromFile = readPromptFileSync();
  if (fromFile && fromFile.text) return fromFile.text;
  return null;
}

function extractInboundText(inbound) {
  const direct = String(inbound?.text || '').trim();
  if (direct) return direct;
  const interactive = inbound?.interactivePayload;
  if (interactive) {
    const title = interactive.title || interactive.reply?.title || interactive.postbackText;
    if (title) return String(title).trim();
  }
  return '';
}

/**
 * Chronological user/assistant history for the conversation, excluding the
 * current inbound message. Only messages on/after the history epoch are
 * included so deleted-flow replies cannot contaminate the LLM context.
 */
async function loadConversationHistory(conversationId, excludeInboundId) {
  const limit = historyLimit();
  const since = historyEpoch();
  const [inbounds, outbounds] = await Promise.all([
    WhatsAppInboundMessage.find({
      conversationId,
      _id: { $ne: excludeInboundId },
      text: { $nin: [null, ''] },
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('text createdAt')
      .lean(),
    WhatsAppOutboundMessage.find({
      conversationId,
      senderType: 'bot',
      textPreview: { $nin: [null, ''] },
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('textPreview createdAt')
      .lean(),
  ]);

  const merged = [
    ...inbounds.map((m) => ({ role: 'user', content: m.text, at: m.createdAt })),
    ...outbounds.map((m) => ({ role: 'assistant', content: m.textPreview, at: m.createdAt })),
  ]
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-limit);

  return merged.map(({ role, content }) => ({ role, content: String(content) }));
}

async function sendReply({ conversation, inbound, text }) {
  return whatsappOutbound.sendBotTextReply({
    conversationId: conversation._id,
    phone10: conversation.phone,
    text,
    inReplyToInboundId: inbound._id,
  });
}

/**
 * Process one claimed inbound message. Same contract as the old orchestrator:
 * resolves to { outboundSuccess } (or { skipped }) for inbound bookkeeping.
 */
async function processInbound({ conversation, inbound }) {
  const userText = extractInboundText(inbound);
  const botState = await getBotState(conversation._id, conversation.phone);
  const optedOut = Boolean(botState?.context?.optedOut);

  if (STOP_RE.test(userText)) {
    await transitionState(conversation._id, conversation.phone, 'idle', { optedOut: true });
    const sent = await sendReply({ conversation, inbound, text: OPT_OUT_REPLY });
    return { outboundSuccess: Boolean(sent?.success), optOut: true };
  }

  if (optedOut) {
    if (!START_RE.test(userText)) {
      // Opted-out users get no bot messages until they reply START.
      return { outboundSuccess: true, suppressed: true };
    }
    await transitionState(conversation._id, conversation.phone, 'idle', { optedOut: false });
  }

  const systemPrompt = await loadSystemPrompt();
  if (!systemPrompt) {
    console.error('[llmOnlyChat] no system prompt configured (admin panel + file both empty)');
    const sent = await sendReply({ conversation, inbound, text: ERROR_REPLY });
    return { outboundSuccess: Boolean(sent?.success), error: 'system_prompt_missing' };
  }

  const storedProfile = sanitizeProfile(botState?.context?.leadProfile);
  let history = [];
  try {
    history = await loadConversationHistory(conversation._id, inbound._id);
  } catch (err) {
    console.error(
      '[llmOnlyChat] history load failed',
      maskPhoneTail(conversation.phone),
      err?.message || err
    );
  }

  const lastBotMessage =
    [...history].reverse().find((m) => m.role === 'assistant')?.content || '';
  let patch = {};
  try {
    patch = await extractProfilePatch({
      knownProfile: storedProfile,
      lastBotMessage,
      userText: userText || '',
    });
  } catch (err) {
    console.error(
      '[llmOnlyChat] leadProfile extract failed',
      maskPhoneTail(conversation.phone),
      err?.message || err
    );
  }
  const leadProfile = mergeProfile(storedProfile, patch);
  try {
    await transitionState(conversation._id, conversation.phone, botState?.state || 'idle', {
      leadProfile,
    });
  } catch (err) {
    console.error(
      '[llmOnlyChat] leadProfile persist failed',
      maskPhoneTail(conversation.phone),
      err?.message || err
    );
  }

  // Lead Intelligence sidecar — never blocks or alters the LLM-only reply path.
  syncLeadIntelligenceSafe({ conversation, leadProfile });

  // --- College / rank predictor session (LLM asks missing slots; API when ready) ---
  let predictor = isSessionActive(botState?.context?.predictor)
    ? { ...botState.context.predictor, slots: { ...(botState.context.predictor.slots || {}) } }
    : null;

  if (!predictor) {
    const intent = detectPredictorIntent(userText || '');
    if (intent === TYPE_RANK) {
      predictor = emptyPredictorSession(TYPE_RANK);
      predictor.slots = buildRankSlotsFromProfile(leadProfile);
    } else if (intent === TYPE_COLLEGE) {
      predictor = emptyPredictorSession(TYPE_COLLEGE);
      predictor.slots = buildCollegeSlotsFromProfile(leadProfile);
    }
  }

  let predictorChecklist = null;
  let groundedPredictorReply = null;

  if (predictor) {
    let llmPatch = {};
    try {
      llmPatch = await extractPredictorSlotPatch({
        knownSlots: predictor.slots,
        lastBotMessage,
        userText: userText || '',
        type: predictor.type,
      });
    } catch (err) {
      console.error(
        '[llmOnlyChat] predictor slot extract failed',
        maskPhoneTail(conversation.phone),
        err?.message || err
      );
    }

    if (predictor.type === TYPE_RANK) {
      predictor.slots = mergeRankSlots({
        slots: predictor.slots,
        userText: userText || '',
        llmPatch,
      });
    } else {
      predictor.slots = mergeCollegeSlots({
        slots: predictor.slots,
        userText: userText || '',
        llmPatch,
      });
    }

    if (isSessionReady(predictor)) {
      const result =
        predictor.type === TYPE_RANK
          ? await runRankPrediction(predictor.slots)
          : await runCollegePrediction(predictor.slots);
      groundedPredictorReply = result?.reply || ERROR_REPLY;
      predictor = { active: false, type: predictor.type, slots: {}, completedAt: new Date().toISOString() };
    } else {
      predictorChecklist = buildPredictorChecklistBlock(predictor);
    }

    try {
      await transitionState(conversation._id, conversation.phone, botState?.state || 'idle', {
        leadProfile,
        predictor,
      });
    } catch (err) {
      console.error(
        '[llmOnlyChat] predictor persist failed',
        maskPhoneTail(conversation.phone),
        err?.message || err
      );
    }
  }

  if (groundedPredictorReply) {
    const sent = await sendReply({
      conversation,
      inbound,
      text: groundedPredictorReply,
    });
    return {
      outboundSuccess: Boolean(sent?.success),
      llmUsed: false,
      predictorUsed: true,
      leadProfile,
    };
  }

  let replyText = null;
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'system', content: buildKnownProfileBlock(leadProfile) },
    ];
    if (predictorChecklist) {
      messages.push({ role: 'system', content: predictorChecklist });
    }
    messages.push({ role: 'user', content: userText || '[non-text message]' });

    const result = await chatCompletion({
      messages,
      temperature: llmTemperature(),
      maxTokens: llmMaxTokens(),
      timeoutMs: llmTimeoutMs(),
      maxRetries: 1,
    });
    replyText = result?.content || null;
  } catch (err) {
    console.error(
      '[llmOnlyChat] llm error',
      maskPhoneTail(conversation.phone),
      err?.message || err
    );
  }

  const sent = await sendReply({
    conversation,
    inbound,
    text: replyText || ERROR_REPLY,
  });
  return {
    outboundSuccess: Boolean(sent?.success),
    llmUsed: Boolean(replyText),
    predictorActive: Boolean(predictorChecklist),
    leadProfile,
  };
}

module.exports = {
  processInbound,
  loadSystemPrompt,
  loadConversationHistory,
  extractInboundText,
  historyEpoch,
  DEFAULT_HISTORY_SINCE,
  OPT_OUT_REPLY,
  ERROR_REPLY,
  buildKnownProfileBlock,
};
