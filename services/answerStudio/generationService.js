'use strict';

const llmClient = require('../ai/llmClient');
const AnswerStudioGeneration = require('../../models/AnswerStudioGeneration');
const { resolveStudioPrompt } = require('./promptResolver');
const {
  ANSWER_LIMIT,
  GenerationError,
  parseGenerateInput,
  readUsage,
} = require('./generationValidation');

// Same defaults as services/ai/llmClient.js chatCompletion.
const GENERATION_TEMPERATURE = 0.2;
const GENERATION_MAX_TOKENS = 400;
const GENERATION_TIMEOUT_MS = 20000;

// OpenAiCompatibleProvider reads these at call time. When any are missing the
// provider throws a plain Error, which used to surface as a misleading 502.
const PROVIDER_ENV_KEYS = Object.freeze(['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']);

function missingProviderEnv() {
  return PROVIDER_ENV_KEYS.filter((key) => !String(process.env[key] || '').trim());
}

function adminId(admin) {
  const id = admin && (admin._id || admin.id);
  if (!id) {
    throw new GenerationError('Authentication required', 401);
  }
  return id;
}

function isTimeout(error) {
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    name.toLowerCase().includes('timeout')
    || code === 'ETIMEDOUT'
    || /timeout/i.test(message)
  );
}

function mapProviderError(error) {
  if (isTimeout(error)) {
    return new GenerationError('The answer service timed out. Try again.', 504, 'PROVIDER_TIMEOUT');
  }
  return new GenerationError('The answer service is unavailable.', 502, 'PROVIDER_ERROR');
}

function toPublicGeneration(doc, answer) {
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const payload = {
    id: String(row._id),
    platform: row.platform,
    question: row.question,
    answer,
    promptKey: row.promptKey || '',
    promptVersion: row.promptVersion,
    promptSource: row.promptSource,
    model: row.model || '',
    status: row.status,
    createdAt: row.createdAt,
  };
  if (row.usage && (row.usage.promptTokens != null || row.usage.completionTokens != null || row.usage.totalTokens != null)) {
    payload.usage = {
      promptTokens: row.usage.promptTokens ?? null,
      completionTokens: row.usage.completionTokens ?? null,
      totalTokens: row.usage.totalTokens ?? null,
    };
  }
  return payload;
}

async function generateAnswer(body, admin) {
  const input = parseGenerateInput(body || {});
  const actorId = adminId(admin);
  const missingEnv = missingProviderEnv();
  if (missingEnv.length) {
    console.error(
      '[answer-studio] generation is not configured; missing env:',
      missingEnv.join(', ')
    );
    throw new GenerationError(
      'Answer Studio is not configured yet. Set LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL.',
      503,
      'PROVIDER_NOT_CONFIGURED'
    );
  }
  const prompt = await resolveStudioPrompt(input.platform);

  let result;
  try {
    result = await llmClient.chatCompletion({
      systemPrompt: prompt.body,
      userPrompt: input.question,
      temperature: GENERATION_TEMPERATURE,
      maxTokens: GENERATION_MAX_TOKENS,
      timeoutMs: GENERATION_TIMEOUT_MS,
      maxRetries: 1,
    });
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw mapProviderError(error);
  }

  const answer = typeof result?.content === 'string' ? result.content.trim() : '';
  if (!answer) {
    throw new GenerationError('The model returned an empty answer.', 502, 'EMPTY_MODEL_RESPONSE');
  }
  if (answer.length > ANSWER_LIMIT) {
    throw new GenerationError('The model answer exceeded the storage limit.', 502, 'ANSWER_TOO_LONG');
  }

  const usage = readUsage(result.usage);
  let doc;
  try {
    doc = await AnswerStudioGeneration.create({
      platform: input.platform,
      question: input.question,
      rawAnswer: answer,
      status: 'generated',
      model: typeof result.model === 'string' ? result.model.slice(0, 128) : '',
      promptKey: String(prompt.key || '').slice(0, 128),
      promptVersion: prompt.version,
      promptSource: prompt.source,
      usage: usage || undefined,
      knowledgeReferences: [],
      exampleReferences: [],
      generationVersion: 1,
      createdBy: actorId,
      updatedBy: actorId,
    });
  } catch (error) {
    console.error(
      '[answer-studio] generation save error:',
      error?.name || 'Error',
      error?.code || ''
    );
    throw new GenerationError('The answer could not be saved.', 500, 'GENERATION_NOT_SAVED');
  }

  return toPublicGeneration(doc, answer);
}

module.exports = {
  GENERATION_TEMPERATURE,
  GENERATION_MAX_TOKENS,
  generateAnswer,
};
