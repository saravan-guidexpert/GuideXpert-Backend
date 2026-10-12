'use strict';

/**
 * WhatsApp college + rank predictors for the LLM-only pipeline.
 *
 * OpenAI asks for missing fields one-by-one (via PREDICTOR_CHECKLIST).
 * Backend only calls college/rank APIs when the checklist is complete.
 */

const { chatCompletion } = require('../ai/llmClient');
const { fetchCollegeDostColleges } = require('../collegePredictorCore');
const { predictRank, listExams } = require('../rankPredictorService');
const {
  EXAM_AP,
  EXAM_TS,
  EXAM_DISPLAY,
  EXAM_OPTIONS,
  AP_OC_MALE_BLOCKED_REPLY,
  formatGenderLabel,
  pickBranchDetails,
} = require('../../constants/whatsappCollegePredictor');
const {
  getMissingSlots,
  isPredictionReady,
  clearDependentSlots,
  categoryOptionsForExam,
  admissionOptionsForExam,
  buildPredictionContext,
} = require('./whatsappCollegePredictor/collegePredictorSlots');
const { extractSlotsFromMessage } = require('./whatsappCollegePredictor/collegePredictorSlotExtractor');
const { isApOcMaleBlocked } = require('./whatsappCollegePredictor/apTs');
const { parseJsonObject } = require('./leadProfileMemoryService');

const TYPE_COLLEGE = 'college';
const TYPE_RANK = 'rank';

const COLLEGE_INTENT_RE =
  /\b(college\s*predict|predict(ion)?\s*(my\s*)?college|which\s+college|can\s+i\s+get|will\s+i\s+get|cutoff|seat\s*(allot|predict)|branch\s+predict|rank\s+\d+|got\s+\d+\s*rank|\d{4,6}\s*rank)\b/i;

const RANK_INTENT_RE =
  /\b(rank\s*predict|predict(ion)?\s*(my\s*)?rank|marks?\s*to\s*rank|score\s*to\s*rank|what\s*(will\s*be|is)\s*my\s*rank|estimate(d)?\s*rank|from\s*(my\s*)?(marks|score|percentile))\b/i;

const SLOT_EXTRACT_SYSTEM = `You extract exam-prediction slot values from one WhatsApp turn.
Return ONLY a flat JSON object with newly stated fields. Allowed keys:
predictor_type ("college" or "rank"),
exam (canonical label like "TS EAMCET", "AP EAMCET", "JEE Main", "KCET", "KEAM", "WBJEE", "MHT CET", "TNEA", "JEE Advanced"),
rank (number), score (number), percentile (number 1-100),
category (string like OC, BC-A, SC, ST, EWS, OBC, General),
gender ("male" or "female"),
region ("AU" or "SVU" for AP EAMCET only),
quota (string for WBJEE),
admission_type (string for KCET/MHT),
difficulty ("Easy", "Moderate", or "Difficult" for MHT CET rank predictor).

Rules:
- Only include facts clearly stated in the student message.
- If nothing new, return {}.
- No markdown, JSON only.`;

const EXAM_LABEL_TO_COLLEGE = Object.fromEntries(
  EXAM_OPTIONS.map((o) => [o.label.toLowerCase(), o.value])
);

const COLLEGE_EXAM_TO_RANK_ID = {
  AP_EAMCET: 'apeamcet',
  TS_EAMCET: 'tseamcet',
  TNEA: 'tnea',
  KCET: 'kcet',
  KEAM: 'keam',
  WBJEE_2024: 'wbjee',
  JEE_MAINS_2024: 'jeemainmarks',
  JEE_ADVANCE_2024: 'jeeadvanced',
  MHTCET: 'mhcet',
};

const RANK_EXAM_ALIASES = [
  { id: 'jeemainpercentile', patterns: [/\bjee\s*main\s*percentile\b/i] },
  { id: 'jeemainmarks', patterns: [/\bjee\s*main\b/i, /\bjeemain\b/i] },
  { id: 'jeeadvanced', patterns: [/\bjee\s*adv(?:anced)?\b/i] },
  { id: 'apeamcet', patterns: [/\bap\s*eamcet\b/i, /\bapeamcet\b/i] },
  { id: 'tseamcet', patterns: [/\bts\s*eamcet\b/i, /\btseamcet\b/i, /\btelangana\s*eamcet\b/i] },
  { id: 'kcet', patterns: [/\bkcet\b/i] },
  { id: 'keam', patterns: [/\bkeam\b/i] },
  { id: 'mhcet', patterns: [/\bmht\s*cet\b/i, /\bmhcet\b/i] },
  { id: 'tnea', patterns: [/\btnea\b/i] },
  { id: 'wbjee', patterns: [/\bwbjee\b/i] },
];

function emptyPredictorSession(type) {
  return {
    active: true,
    type: type === TYPE_RANK ? TYPE_RANK : TYPE_COLLEGE,
    slots: {},
    startedAt: new Date().toISOString(),
  };
}

function detectPredictorIntent(userText) {
  const text = String(userText || '').trim();
  if (!text) return null;
  if (RANK_INTENT_RE.test(text)) return TYPE_RANK;
  if (COLLEGE_INTENT_RE.test(text)) return TYPE_COLLEGE;
  // Rank + eligibility phrasing without "marks" still routes to college predictor
  if (/\b(my\s+rank\s+is|rank\s+is\s+\d+|got\s+\d{3,6})\b/i.test(text)) return TYPE_COLLEGE;
  return null;
}

function normalizeExamLabelToCollegeEnum(label) {
  if (!label) return null;
  const raw = String(label).trim();
  if (EXAM_DISPLAY[raw]) return raw;
  const lower = raw.toLowerCase();
  if (EXAM_LABEL_TO_COLLEGE[lower]) return EXAM_LABEL_TO_COLLEGE[lower];
  for (const opt of EXAM_OPTIONS) {
    if (lower.includes(opt.label.toLowerCase()) || lower.includes(opt.value.toLowerCase())) {
      return opt.value;
    }
  }
  return null;
}

function detectRankExamId(text) {
  const raw = String(text || '').trim();
  for (const row of RANK_EXAM_ALIASES) {
    if (row.patterns.some((p) => p.test(raw))) return row.id;
  }
  const exams = listExams();
  const lower = raw.toLowerCase();
  return exams.find((e) => lower.includes(e.name.toLowerCase()))?.id || '';
}

function parseScoreFromText(text) {
  const m = String(text || '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseDifficulty(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.includes('easy')) return 'Easy';
  if (t.includes('moderate') || t.includes('medium')) return 'Moderate';
  if (t.includes('difficult') || t.includes('hard')) return 'Difficult';
  return '';
}

/**
 * Seed college slots from leadProfile so we do not re-ask known facts.
 */
function buildCollegeSlotsFromProfile(leadProfile) {
  const p = leadProfile && typeof leadProfile === 'object' ? leadProfile : {};
  const slots = {};
  const exam =
    normalizeExamLabelToCollegeEnum(p.exam) ||
    (p.exam ? extractSlotsFromMessage(String(p.exam), {}).exam : null);
  if (exam) slots.exam = exam;

  const rankRaw = p.rank != null ? p.rank : null;
  if (rankRaw != null && rankRaw !== '') {
    const n = Number(String(rankRaw).replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1) slots.rank = Math.round(n);
  }

  if (p.gender) {
    const g = String(p.gender).toLowerCase();
    if (g.startsWith('m')) slots.gender = 'male';
    else if (g.startsWith('f')) slots.gender = 'female';
  }

  if (p.category || p.reservation) {
    const extracted = extractSlotsFromMessage(String(p.category || p.reservation), {
      exam: slots.exam,
    });
    if (extracted.categoryLabel) {
      slots.categoryLabel = extracted.categoryLabel;
      slots.categoryN = extracted.categoryN;
      slots.baseCategory = extracted.baseCategory;
    }
  }

  return slots;
}

function buildRankSlotsFromProfile(leadProfile) {
  const p = leadProfile && typeof leadProfile === 'object' ? leadProfile : {};
  const slots = {};
  if (p.exam) {
    const collegeEnum = normalizeExamLabelToCollegeEnum(p.exam);
    if (collegeEnum && COLLEGE_EXAM_TO_RANK_ID[collegeEnum]) {
      slots.examId = COLLEGE_EXAM_TO_RANK_ID[collegeEnum];
    } else {
      const id = detectRankExamId(String(p.exam));
      if (id) slots.examId = id;
    }
  }
  const scoreRaw = p.marks != null ? p.marks : p.score;
  if (scoreRaw != null && scoreRaw !== '') {
    const n = Number(scoreRaw);
    if (Number.isFinite(n)) slots.score = n;
  }
  return slots;
}

function applyCollegeExtracted(ctx, extracted) {
  if (!extracted || !Object.keys(extracted).length) return { ...ctx };
  let next = { ...ctx };
  if (extracted.exam) {
    if (next.exam && extracted.exam !== next.exam) {
      next = { ...clearDependentSlots(next, false), exam: extracted.exam };
    } else {
      next.exam = extracted.exam;
    }
  }
  if (extracted.rank != null) next.rank = extracted.rank;
  if (extracted.percentile != null) next.percentile = extracted.percentile;
  if (extracted.admissionType) {
    next.admissionType = extracted.admissionType;
    next.admission_category_name_enum = extracted.admission_category_name_enum;
  }
  if (extracted.categoryLabel) {
    next.categoryLabel = extracted.categoryLabel;
    next.categoryN = extracted.categoryN;
    next.baseCategory = extracted.baseCategory;
  }
  if (extracted.gender) next.gender = extracted.gender;
  if (extracted.quota) next.quota = extracted.quota;
  if (extracted.admission_category_name_enum && next.exam === EXAM_AP) {
    next.admission_category_name_enum = extracted.admission_category_name_enum;
  }
  if (next.exam && next.exam !== 'MHTCET') delete next.percentile;
  if (next.exam === 'MHTCET') delete next.rank;
  return next;
}

function applyLlmCollegePatch(slots, patch) {
  if (!patch || typeof patch !== 'object') return slots;
  let next = { ...slots };
  if (patch.exam) {
    const exam = normalizeExamLabelToCollegeEnum(patch.exam);
    if (exam) {
      if (next.exam && exam !== next.exam) next = { ...clearDependentSlots(next, false), exam };
      else next.exam = exam;
    }
  }
  if (patch.rank != null) {
    const n = Number(patch.rank);
    if (Number.isFinite(n) && n >= 1) next.rank = Math.round(n);
  }
  if (patch.percentile != null) {
    const n = Number(patch.percentile);
    if (Number.isFinite(n) && n >= 1 && n <= 100) next.percentile = n;
  }
  if (patch.gender) {
    const g = String(patch.gender).toLowerCase();
    if (g.startsWith('m')) next.gender = 'male';
    else if (g.startsWith('f')) next.gender = 'female';
  }
  if (patch.region) {
    const r = String(patch.region).toUpperCase();
    if (r === 'AU' || r === 'SVU') next.admission_category_name_enum = r;
  }
  if (patch.quota) next.quota = String(patch.quota);
  if (patch.admission_type) {
    next.admissionType = String(patch.admission_type);
    next.admission_category_name_enum = String(patch.admission_type);
  }
  if (patch.category) {
    const extracted = extractSlotsFromMessage(String(patch.category), { exam: next.exam });
    if (extracted.categoryLabel) {
      next.categoryLabel = extracted.categoryLabel;
      next.categoryN = extracted.categoryN;
      next.baseCategory = extracted.baseCategory;
    }
  }
  return next;
}

function applyRankPatch(slots, patch, userText) {
  const next = { ...slots };
  if (patch?.examId) next.examId = patch.examId;
  if (patch?.exam) {
    const collegeEnum = normalizeExamLabelToCollegeEnum(patch.exam);
    if (collegeEnum && COLLEGE_EXAM_TO_RANK_ID[collegeEnum]) {
      next.examId = COLLEGE_EXAM_TO_RANK_ID[collegeEnum];
    } else {
      const id = detectRankExamId(String(patch.exam));
      if (id) next.examId = id;
    }
  }
  if (!next.examId && userText) {
    const id = detectRankExamId(userText);
    if (id) next.examId = id;
  }
  if (patch?.score != null) {
    const n = Number(patch.score);
    if (Number.isFinite(n)) next.score = n;
  }
  if (next.score == null && userText) {
    const n = parseScoreFromText(userText);
    // Prefer explicit "score/marks" context; still accept bare number when exam already known
    if (n != null && (/\b(score|marks|scored|got)\b/i.test(userText) || next.examId)) {
      next.score = n;
    }
  }
  if (patch?.difficulty) {
    const d = parseDifficulty(String(patch.difficulty));
    if (d) next.difficulty = d;
  }
  if (!next.difficulty && userText) {
    const d = parseDifficulty(userText);
    if (d) next.difficulty = d;
  }
  return next;
}

async function extractPredictorSlotPatch({ knownSlots, lastBotMessage, userText, type }) {
  const text = String(userText || '').trim();
  if (!text || text === '[non-text message]') return {};
  try {
    const result = await chatCompletion({
      messages: [
        { role: 'system', content: SLOT_EXTRACT_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            predictor_type: type,
            known_slots: knownSlots || {},
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
    console.error('[predictorTool] slot extract failed', err?.message || err);
    return {};
  }
}

function mergeCollegeSlots({ slots, userText, llmPatch }) {
  let next = { ...(slots || {}) };
  const deterministic = extractSlotsFromMessage(userText || '', next);
  next = applyCollegeExtracted(next, deterministic);
  next = applyLlmCollegePatch(next, llmPatch);
  return next;
}

function mergeRankSlots({ slots, userText, llmPatch }) {
  return applyRankPatch({ ...(slots || {}) }, llmPatch || {}, userText || '');
}

function getRankMissingSlots(slots) {
  const missing = [];
  if (!slots.examId) missing.push('exam');
  if (slots.score == null) missing.push('score');
  const exam = listExams().find((e) => e.id === slots.examId);
  if (exam?.requiresOption && !slots.difficulty) missing.push('difficulty');
  return missing;
}

function isRankReady(slots) {
  return getRankMissingSlots(slots).length === 0;
}

function optionsHintForCollegeSlot(slots, slot) {
  if (slot === 'exam') {
    return EXAM_OPTIONS.map((o) => o.label).join(', ');
  }
  if (slot === 'category') {
    return categoryOptionsForExam(slots)
      .map((o) => o.label || o.value)
      .slice(0, 12)
      .join(', ');
  }
  if (slot === 'admission_type') {
    return admissionOptionsForExam(slots.exam)
      .map((o) => o.label || o.value)
      .join(', ');
  }
  if (slot === 'gender') return 'Male, Female';
  if (slot === 'region') return 'AU, SVU';
  if (slot === 'quota') return 'Home State (HS), All India (AI)';
  if (slot === 'rank') return 'e.g. 15000';
  if (slot === 'percentile') return 'e.g. 92.5';
  return null;
}

function optionsHintForRankSlot(slots, slot) {
  if (slot === 'exam') {
    return listExams()
      .map((e) => e.name)
      .join(', ');
  }
  if (slot === 'score') {
    const exam = listExams().find((e) => e.id === slots.examId);
    return exam ? `${exam.minScore} to ${exam.maxScore}` : null;
  }
  if (slot === 'difficulty') return 'Easy, Moderate, Difficult';
  return null;
}

function filledSummaryCollege(slots) {
  const filled = {};
  if (slots.exam) filled.exam = EXAM_DISPLAY[slots.exam] || slots.exam;
  if (slots.rank != null) filled.rank = slots.rank;
  if (slots.percentile != null) filled.percentile = slots.percentile;
  if (slots.categoryLabel) filled.category = slots.categoryLabel;
  if (slots.gender) filled.gender = formatGenderLabel(slots.gender);
  if (slots.admission_category_name_enum && slots.exam === EXAM_AP) {
    filled.region = slots.admission_category_name_enum;
  }
  if (slots.quota) filled.quota = slots.quota;
  if (slots.admissionType) filled.admission_type = slots.admissionType;
  return filled;
}

function filledSummaryRank(slots) {
  const filled = {};
  if (slots.examId) {
    const exam = listExams().find((e) => e.id === slots.examId);
    filled.exam = exam?.name || slots.examId;
  }
  if (slots.score != null) filled.score = slots.score;
  if (slots.difficulty) filled.difficulty = slots.difficulty;
  return filled;
}

function nextMissingPromptMeta(session) {
  const type = session?.type === TYPE_RANK ? TYPE_RANK : TYPE_COLLEGE;
  const slots = session?.slots || {};
  if (type === TYPE_RANK) {
    const missing = getRankMissingSlots(slots);
    const nextSlot = missing[0] || null;
    return {
      type,
      filled: filledSummaryRank(slots),
      missing,
      nextSlot,
      optionsHint: nextSlot ? optionsHintForRankSlot(slots, nextSlot) : null,
      ready: missing.length === 0,
    };
  }
  const missing = getMissingSlots(slots);
  const nextSlot = missing[0] || null;
  return {
    type,
    filled: filledSummaryCollege(slots),
    missing,
    nextSlot,
    optionsHint: nextSlot ? optionsHintForCollegeSlot(slots, nextSlot) : null,
    ready: missing.length === 0,
  };
}

function buildPredictorChecklistBlock(session) {
  const meta = nextMissingPromptMeta(session);
  const lines = [
    'PREDICTOR_CHECKLIST',
    `type: ${meta.type}`,
    `filled: ${JSON.stringify(meta.filled)}`,
    `missing: ${JSON.stringify(meta.missing)}`,
    `next_to_ask: ${meta.nextSlot || 'none'}`,
  ];
  if (meta.optionsHint) lines.push(`options_hint: ${meta.optionsHint}`);
  lines.push(
    'Ask ONLY for next_to_ask in one short WhatsApp message. Never invent ranks, cutoffs, or college lists. Never pretend to call a tool or say "[Calling…]". The backend will inject real prediction results when ready.'
  );
  return lines.join('\n');
}

function formatCollegePredictionForWhatsApp(ctx, colleges) {
  const lines = [
    'Here are your predicted colleges:',
    '',
    `Exam: ${EXAM_DISPLAY[ctx.exam] || ctx.exam}`,
    `Rank/Percentile: ${ctx.percentile != null ? ctx.percentile : ctx.rank}`,
    `Category: ${ctx.categoryLabel || 'NA'}`,
  ];
  if (ctx.gender) lines.push(`Gender: ${formatGenderLabel(ctx.gender)}`);
  lines.push('', 'Top Matches:', '');

  const list = Array.isArray(colleges) ? colleges.slice(0, 5) : [];
  if (!list.length) {
    lines.push('No colleges found for this profile. Try again with different inputs.');
  } else {
    list.forEach((c, i) => {
      const details = pickBranchDetails(c);
      lines.push(`${i + 1}. ${c.college_name || 'College'}`);
      lines.push(`   Branch: ${details.branch}`);
      if (details.cutoff != null) lines.push(`   Cutoff: ${details.cutoff}`);
      if (details.category) lines.push(`   Category: ${details.category}`);
      lines.push('');
    });
  }
  lines.push('Based on previous-year cutoffs. Want a free 1:1 session for a precise plan?');
  return lines.join('\n');
}

function formatRankPredictionForWhatsApp(result) {
  const range =
    result.range && typeof result.range === 'object'
      ? `${result.range.low}–${result.range.high}`
      : String(result.range || result.predictedValue || '—');
  return [
    `Rank prediction for ${result.examName}:`,
    `${result.metricLabel}: ${range}`,
    result.message || 'Based on previous year trends.',
    '',
    'Want me to predict colleges for this rank next?',
  ].join('\n');
}

function buildCounsellorStyleRequestBody(ctx) {
  const body = { exam: ctx.exam };
  if (ctx.rank != null) body.rank = ctx.rank;
  if (ctx.cutoff_from != null) body.cutoff_from = ctx.cutoff_from;
  if (ctx.cutoff_to != null) body.cutoff_to = ctx.cutoff_to;
  if (Array.isArray(ctx.reservation_category_codes)) {
    body.reservation_category_codes = ctx.reservation_category_codes;
  }
  if (ctx.admission_category_name_enum) {
    body.admission_category_name_enum = ctx.admission_category_name_enum;
  }
  if (ctx.quota) body.quota = ctx.quota;
  return body;
}

async function runCollegePrediction(slots) {
  if (
    slots.exam === EXAM_AP &&
    slots.categoryN != null &&
    isApOcMaleBlocked(slots.categoryN, slots.gender)
  ) {
    return { ok: false, blocked: true, reply: AP_OC_MALE_BLOCKED_REPLY };
  }

  const built = buildPredictionContext(slots);
  if (built.blocked) {
    return { ok: false, blocked: true, reply: AP_OC_MALE_BLOCKED_REPLY };
  }
  if (built.error) {
    return { ok: false, error: built.error, reply: built.error };
  }

  const ctx = built.ctx;
  try {
    const data = await fetchCollegeDostColleges(ctx.exam, 0, 5, buildCounsellorStyleRequestBody(ctx));
    const colleges = data?.colleges || [];
    return {
      ok: true,
      reply: formatCollegePredictionForWhatsApp(ctx, colleges),
      collegeCount: colleges.length,
    };
  } catch (err) {
    console.error('[predictorTool] college predict failed', err?.message || err);
    return {
      ok: false,
      error: err?.message || 'predict_failed',
      reply:
        'We could not fetch college predictions right now. Please try again in a moment — your details are saved.',
    };
  }
}

async function runRankPrediction(slots) {
  try {
    const result = predictRank({
      examId: slots.examId,
      score: Number(slots.score),
      options: slots.difficulty ? { difficulty: slots.difficulty } : {},
    });
    return { ok: true, reply: formatRankPredictionForWhatsApp(result), data: result };
  } catch (err) {
    console.error('[predictorTool] rank predict failed', err?.message || err);
    return {
      ok: false,
      error: err?.message || 'predict_failed',
      reply: err?.message || 'Could not predict rank for that input. Please check the score and try again.',
    };
  }
}

function isSessionActive(predictor) {
  return Boolean(predictor && predictor.active && (predictor.type === TYPE_COLLEGE || predictor.type === TYPE_RANK));
}

function isSessionReady(session) {
  if (!session || !session.active) return false;
  if (session.type === TYPE_RANK) return isRankReady(session.slots || {});
  return isPredictionReady(session.slots || {});
}

module.exports = {
  TYPE_COLLEGE,
  TYPE_RANK,
  emptyPredictorSession,
  detectPredictorIntent,
  buildCollegeSlotsFromProfile,
  buildRankSlotsFromProfile,
  extractPredictorSlotPatch,
  mergeCollegeSlots,
  mergeRankSlots,
  nextMissingPromptMeta,
  buildPredictorChecklistBlock,
  runCollegePrediction,
  runRankPrediction,
  isSessionActive,
  isSessionReady,
  formatCollegePredictionForWhatsApp,
  formatRankPredictionForWhatsApp,
  getRankMissingSlots,
  isRankReady,
};
