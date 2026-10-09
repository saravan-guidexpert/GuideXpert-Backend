'use strict';

/**
 * Lead profile memory for the LLM-only WhatsApp pipeline.
 *
 * On each turn: extract newly stated facts via a small OpenAI call, merge into
 * the stored profile, and render a KNOWN_PROFILE block that is injected into
 * the main reply call — fulfilling Section 4 of the admin-panel system prompt.
 */

const { chatCompletion } = require('../ai/llmClient');

const PROFILE_KEYS = [
  'name',
  'qualification',
  'stream',
  'entry_type',
  'branchInterest',
  'course_interest',
  'career_goal',
  'topics',
  'interests',
  'state',
  'board',
  'marks',
  'rank',
  'exam',
  'budget',
  'city_pref',
  'relocate',
  'priorities',
  'priority',
  'family_view',
  'concern',
  'shortlist',
  'best_match',
  'is_parent',
  'proxy',
  'conflict',
  'timeline',
  'temperature',
  'stage',
  'booking_status',
  'handoff_status',
  'opted_out',
  'escalate_human',
];

const EXTRACTION_SYSTEM = `You extract student counselling facts from one WhatsApp turn.
Return ONLY a flat JSON object with newly learned facts. Use these keys when present:
name, qualification, stream, entry_type, branchInterest, course_interest, career_goal,
topics (array of strings), interests (array), state, board, marks, rank (number or string),
exam, budget, city_pref, relocate, priorities (array), priority, family_view, concern,
is_parent (boolean), proxy (boolean), conflict, timeline, stage.

Rules:
- Include ONLY facts clearly stated or confirmed in the student's latest message.
- Do not invent or guess. If nothing new was learned, return {}.
- Prefer short canonical values (e.g. qualification "12th - MPC", exam "TS EAMCET", city_pref "Hyderabad").
- Do not include null, empty string, or empty array fields.
- No markdown, no commentary — JSON object only.`;

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === 'string' && !value.trim()) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of PROFILE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (isEmptyValue(value)) continue;
    if (Array.isArray(value)) {
      out[key] = value
        .map((v) => (typeof v === 'string' ? v.trim() : v))
        .filter((v) => !isEmptyValue(v));
      if (out[key].length === 0) delete out[key];
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Shallow-merge patch into existing profile. Ignores null/empty patch values.
 * Arrays are replaced (not concatenated) when the patch provides a non-empty array.
 */
function mergeProfile(existing, patch) {
  const base = sanitizeProfile(existing);
  const next = sanitizeProfile(patch);
  return { ...base, ...next };
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  let candidate = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return sanitizeProfile(parsed);
  } catch {
    return {};
  }
}

/**
 * One small OpenAI call to extract newly learned facts from the latest turn.
 * Failures return {} so the main reply is never blocked.
 */
async function extractProfilePatch({ knownProfile, lastBotMessage, userText }) {
  const text = String(userText || '').trim();
  if (!text || text === '[non-text message]') return {};

  try {
    const result = await chatCompletion({
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            known_profile: sanitizeProfile(knownProfile),
            last_bot_message: String(lastBotMessage || '').slice(0, 800) || null,
            student_message: text.slice(0, 1500),
          }),
        },
      ],
      temperature: 0,
      maxTokens: 200,
      timeoutMs: 4000,
      maxRetries: 0,
    });
    return parseJsonObject(result?.content);
  } catch (err) {
    console.error('[leadProfileMemory] extract failed', err?.message || err);
    return {};
  }
}

/**
 * Render the KNOWN_PROFILE block expected by Section 4 of the system prompt.
 */
function buildKnownProfileBlock(profile) {
  const clean = sanitizeProfile(profile);
  return [
    'KNOWN_PROFILE',
    'The following JSON contains every fact already captured about this student.',
    'NEVER ask a question whose answer already exists here. Move to the next unfilled slot.',
    '```json',
    JSON.stringify(clean, null, 2),
    '```',
  ].join('\n');
}

module.exports = {
  PROFILE_KEYS,
  EXTRACTION_SYSTEM,
  sanitizeProfile,
  mergeProfile,
  parseJsonObject,
  extractProfilePatch,
  buildKnownProfileBlock,
};
