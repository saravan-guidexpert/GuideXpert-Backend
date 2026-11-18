'use strict';

const { defaultAuthService } = require('./graphAuthService');

function publicAuthError(error) {
  let message = String(error && error.message ? error.message : 'graph_token_failed');
  message = message.replace(/client_secret=[^&\s]+/gi, 'client_secret=[redacted]');
  message = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  message = message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  return message.slice(0, 240);
}

/**
 * Acquires a Graph token and reports only success or failure.
 * The token itself is never returned or logged.
 */
async function checkGraphAuthentication(authService = defaultAuthService) {
  try {
    if (typeof authService.validateConfig === 'function') authService.validateConfig();
    await authService.getAccessToken();
    const expiresInMs = Math.max(0, Number(authService.tokenExpiresAt || 0) - Date.now());
    return {
      ok: true,
      code: 'graph_token_ok',
      expiresInMs,
      baseUrl: process.env.MS_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0'
    };
  } catch (error) {
    return {
      ok: false,
      code: 'graph_token_failed',
      message: publicAuthError(error),
      baseUrl: process.env.MS_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0'
    };
  }
}

module.exports = {
  checkGraphAuthentication,
  publicAuthError
};
