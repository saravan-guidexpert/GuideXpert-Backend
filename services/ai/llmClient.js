'use strict';

const { OpenAiCompatibleProvider } = require('./providers/OpenAiCompatibleProvider');

const defaultProvider = new OpenAiCompatibleProvider();

/** College comparison uses its own OpenAI key — never LLM_API_KEY. */
const collegeComparisonProvider = new OpenAiCompatibleProvider({
  apiKeyEnv: 'COLLEGE_COMPARISON_API_KEY',
  baseUrlEnv: 'COLLEGE_COMPARISON_BASE_URL',
  modelEnv: 'COLLEGE_COMPARISON_MODEL',
  fallbackBaseUrlEnv: 'LLM_BASE_URL',
  fallbackModelEnv: 'LLM_MODEL',
});

function buildChatCompletion(provider) {
  /**
   * Thin helper used by college comparison (and similar tools).
   * Returns { content, model, usage } for a system+user turn, or a full messages array.
   */
  return async function chatCompletion({
    systemPrompt,
    userPrompt,
    messages,
    temperature = 0.2,
    maxTokens = 400,
    timeoutMs,
    maxRetries,
  }) {
    const resolvedMessages = Array.isArray(messages) && messages.length
      ? messages.map((m) => ({
          role: String(m.role || 'user'),
          content: String(m.content || ''),
        }))
      : [
          { role: 'system', content: String(systemPrompt || '') },
          { role: 'user', content: String(userPrompt || '') },
        ];

    const result = await provider.chatCompletion({
      messages: resolvedMessages,
      temperature,
      maxTokens,
      timeoutMs,
      maxRetries,
    });

    return {
      content: String(result.text || '').trim(),
      model: result.model || null,
      usage: result.usage || null,
    };
  };
}

const chatCompletion = buildChatCompletion(defaultProvider);
const collegeComparisonChatCompletion = buildChatCompletion(collegeComparisonProvider);

module.exports = { chatCompletion, collegeComparisonChatCompletion };
