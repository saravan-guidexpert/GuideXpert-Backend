'use strict';

const axios = require('axios');
const { defaultAuthService } = require('./graphAuthService');

class GraphClientError extends Error {
  constructor(message, { statusCode, code, retryAfter, url, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
    this.url = url;
    this.details = details;
  }
}

class GraphForbiddenError extends GraphClientError {}
class GraphNotFoundError extends GraphClientError {}
class GraphDeltaTokenExpiredError extends GraphClientError {}
class GraphThrottledError extends GraphClientError {}

/**
 * Resilient Microsoft Graph HTTP Client
 */
class GraphClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.MS_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0';
    this.authService = config.authService || defaultAuthService;
    this.timeoutMs = config.timeoutMs || 15000;
    this.maxRetries = typeof config.maxRetries === 'number' ? config.maxRetries : 3;
    this.baseBackoffMs = config.baseBackoffMs || 100;
    this.maxBackoffMs = config.maxBackoffMs || 30000;
    this.httpRequester = config.httpRequester || axios.request;
    this.sleepFn = config.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Sanitizes a URL for safe error logging by removing sensitive query parameters.
   */
  _sanitizeUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl, this.baseUrl);
      // Remove any potential tokens in query
      if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[REDACTED]');
      return parsed.pathname + parsed.search;
    } catch {
      return String(rawUrl).split('?')[0];
    }
  }

  /**
   * Calculates backoff with jitter.
   */
  _calculateBackoff(attempt, retryAfterSeconds = null) {
    if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds * 1000, this.maxBackoffMs);
    }
    const exponential = this.baseBackoffMs * Math.pow(2, attempt);
    const jitter = Math.random() * 50;
    return Math.min(exponential + jitter, this.maxBackoffMs);
  }

  /**
   * Executes an HTTP request against Microsoft Graph with resilient retry policies.
   *
   * @param {Object} options
   * @param {string} options.url Absolute URL or path relative to baseUrl
   * @param {string} [options.method='GET']
   * @param {Object} [options.headers]
   * @param {Object} [options.params]
   * @param {any} [options.data]
   * @returns {Promise<any>} Response body
   */
  async request({ url, method = 'GET', headers = {}, params = {}, data = null }) {
    const isAbsolute = /^https?:\/\//i.test(url);
    const fullUrl = isAbsolute ? url : `${this.baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    const sanitizedPath = this._sanitizeUrl(fullUrl);

    let attempt = 0;
    let authRetried = false;

    while (attempt <= this.maxRetries) {
      attempt++;
      let token;
      try {
        token = await this.authService.getAccessToken();
      } catch (authErr) {
        throw new GraphClientError(`Authentication failed: ${authErr.message}`, {
          statusCode: authErr.statusCode || 401,
          code: 'AUTH_FAILED',
          url: sanitizedPath
        });
      }

      const requestConfig = {
        url: fullUrl,
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        params,
        data,
        timeout: this.timeoutMs
      };

      try {
        const response = await this.httpRequester(requestConfig);
        return response?.data;
      } catch (err) {
        const status = err.response?.status;
        const responseHeaders = err.response?.headers || {};
        const graphError = err.response?.data?.error;
        const innerErrorCode = graphError?.innerError?.code || graphError?.innererror?.code;
        const errorCode = graphError?.code || err.code || 'UNKNOWN';
        const errorMsg = graphError?.message || err.message;

        // 1. HTTP 401 Unauthorized: Invalidate cached token and retry once
        if (status === 401 && !authRetried) {
          authRetried = true;
          this.authService.clearCachedToken();
          continue;
        }

        // 2. HTTP 403 Forbidden: Application has insufficient permissions (terminal, non-retryable)
        if (status === 403) {
          throw new GraphForbiddenError(
            `Microsoft Graph access forbidden (HTTP 403): ${errorCode} - ${errorMsg}`,
            { statusCode: 403, code: errorCode, url: sanitizedPath }
          );
        }

        // 3. HTTP 410 Gone / ErrorDeltaTokenExpired / syncStateNotFound / resyncRequired: Delta link expired (needs rebaseline)
        const isDeltaExpired =
          status === 410 ||
          errorCode === 'ErrorDeltaTokenExpired' ||
          errorCode === 'syncStateNotFound' ||
          errorCode === 'resyncRequired' ||
          innerErrorCode === 'ErrorDeltaTokenExpired' ||
          innerErrorCode === 'syncStateNotFound' ||
          innerErrorCode === 'resyncRequired';

        if (isDeltaExpired) {
          throw new GraphDeltaTokenExpiredError(
            `Delta cursor expired or invalid (HTTP 410): ${errorCode}${innerErrorCode ? ' (' + innerErrorCode + ')' : ''} - ${errorMsg}`,
            { statusCode: 410, code: errorCode, innerCode: innerErrorCode, url: sanitizedPath }
          );
        }

        // 4. HTTP 404 Not Found
        if (status === 404) {
          throw new GraphNotFoundError(
            `Resource not found in Microsoft Graph (HTTP 404): ${sanitizedPath}`,
            { statusCode: 404, code: errorCode, url: sanitizedPath }
          );
        }

        // 5. HTTP 429 Too Many Requests (Rate limit throttling)
        if (status === 429) {
          const retryAfterHeader = responseHeaders['retry-after'];
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;

          if (attempt <= this.maxRetries) {
            const delayMs = this._calculateBackoff(attempt, retryAfterSec);
            await this.sleepFn(delayMs);
            continue;
          }

          throw new GraphThrottledError(
            `Microsoft Graph rate limit exceeded (HTTP 429) after ${attempt} attempts`,
            { statusCode: 429, code: 'THROTTLED', retryAfter: retryAfterSec, url: sanitizedPath }
          );
        }

        // 6. Transient 5xx Errors (500, 502, 503, 504) or Network Timeout
        const isTransient5xx = status >= 500 && status <= 504;
        const isNetworkTimeout = ['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err.code);

        if ((isTransient5xx || isNetworkTimeout) && attempt <= this.maxRetries) {
          const delayMs = this._calculateBackoff(attempt);
          await this.sleepFn(delayMs);
          continue;
        }

        // Terminal error
        throw new GraphClientError(
          `Graph API request failed (HTTP ${status || err.code || 'network'}): ${errorMsg}`,
          {
            statusCode: status,
            code: errorCode,
            url: sanitizedPath,
            details: graphError?.innerError
          }
        );
      }
    }

    throw new GraphClientError(`Graph API request exhausted ${this.maxRetries} retries`, {
      code: 'RETRIES_EXHAUSTED',
      url: sanitizedPath
    });
  }

  get(url, options = {}) {
    return this.request({ ...options, url, method: 'GET' });
  }

  post(url, data, options = {}) {
    return this.request({ ...options, url, method: 'POST', data });
  }
}

module.exports = {
  GraphClient,
  GraphClientError,
  GraphForbiddenError,
  GraphNotFoundError,
  GraphDeltaTokenExpiredError,
  GraphThrottledError
};

