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
 * Transport failures that may occur after Microsoft Graph has already accepted a
 * non-idempotent POST /subscriptions. These must not be retried automatically.
 */
const AMBIGUOUS_SUBSCRIPTION_POST_NETWORK_CODES = Object.freeze([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
]);

/**
 * Graph 401 error codes that prove the token was rejected before the resource
 * operation ran. A single token-refresh retry is safe only for these codes.
 * A bare 401 with no such code is ambiguous for POST /subscriptions.
 */
const AUTH_REJECTION_BEFORE_PROCESSING_CODES = new Set([
  'InvalidAuthenticationToken',
  'AuthenticationTokenExpired',
  'ExpiredAuthenticationToken',
  'InvalidAuthenticationTokenTenant'
]);

function requestPathname(rawUrl) {
  const withoutQuery = String(rawUrl || '').split('?')[0];
  try {
    return new URL(withoutQuery, 'https://graph.microsoft.com').pathname.replace(/\/+$/, '');
  } catch {
    return withoutQuery.replace(/\/+$/, '');
  }
}

/**
 * POST /subscriptions creates a remote resource and is not idempotent.
 * POST /subscriptions/{id}/... and other methods are not creation calls.
 */
function isGraphSubscriptionCreate(method, rawUrl) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  return /\/subscriptions$/i.test(requestPathname(rawUrl));
}

function graphErrorCode(graphError) {
  if (!graphError || typeof graphError !== 'object') return '';
  return String(
    graphError.code ||
    graphError.innerError?.code ||
    graphError.innererror?.code ||
    ''
  );
}

function isAuthRejectedBeforeProcessing(graphError) {
  return AUTH_REJECTION_BEFORE_PROCESSING_CODES.has(graphErrorCode(graphError));
}

function ambiguousGraphError(message, fields) {
  const error = new GraphClientError(message, fields);
  error.ambiguousOutcome = true;
  return error;
}

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
   * @param {boolean} [options.noRetryOnAmbiguous=false] When true, 5xx, HTTP 408,
   *   HTTP 429 and ambiguous transport errors are thrown immediately (with
   *   `ambiguousOutcome: true`) instead of being retried. POST /subscriptions
   *   always uses this policy, even when the flag is omitted. A 401 is retried
   *   once only when Graph's error code proves the token was rejected before
   *   the resource operation ran. Safe requests still honor Retry-After.
   * @returns {Promise<any>} Response body
   */
  async request({ url, method = 'GET', headers = {}, params = {}, data = null, noRetryOnAmbiguous = false }) {
    const isAbsolute = /^https?:\/\//i.test(url);
    const fullUrl = isAbsolute ? url : `${this.baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    const sanitizedPath = this._sanitizeUrl(fullUrl);
    // POST /subscriptions is non-idempotent even when the caller forgets the flag.
    // Safe methods (GET/PATCH/DELETE and unrelated POSTs) keep their retry policy.
    const suppressAmbiguousRetry = noRetryOnAmbiguous || isGraphSubscriptionCreate(method, fullUrl);

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

        // 1. HTTP 401 Unauthorized.
        // A Graph authentication error code proves the token was rejected before the
        // resource operation. One refresh retry is then safe, including for POST /subscriptions.
        // A 401 without that proof may have been produced by a proxy after the body was
        // accepted, so subscription creation does not retry it.
        if (status === 401 && !authRetried) {
          const rejectedBeforeProcessing = isAuthRejectedBeforeProcessing(graphError);
          if (suppressAmbiguousRetry && !rejectedBeforeProcessing) {
            throw ambiguousGraphError(
              `Graph API request failed with ambiguous outcome (HTTP 401): ${errorMsg}`,
              { statusCode: 401, code: errorCode, url: sanitizedPath, details: graphError?.innerError }
            );
          }
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

        // 5. HTTP 429 Too Many Requests (Rate limit throttling).
        // Retry-After is honored for safe requests. POST /subscriptions is not retried:
        // Graph may have created the subscription before returning 429.
        if (status === 429) {
          const retryAfterHeader = responseHeaders['retry-after'];
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;

          if (suppressAmbiguousRetry) {
            throw ambiguousGraphError(
              `Graph API request failed with ambiguous outcome (HTTP 429): ${errorMsg}`,
              {
                statusCode: 429,
                code: errorCode || 'THROTTLED',
                retryAfter: retryAfterSec,
                url: sanitizedPath,
                details: graphError?.innerError
              }
            );
          }

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

        // 6. Transient server / transport failures.
        // Timeouts, connection resets and 5xx responses are ambiguous for POST /subscriptions
        // and are thrown once. GET/PATCH/DELETE keep exponential backoff. DNS failures
        // (ENOTFOUND) are still retried for every method because the TCP connection was
        // not established.
        const isTransient5xx = status >= 500 && status <= 504;
        const isNetworkTimeout = ['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err.code);
        const isAmbiguousSubscriptionTransport = AMBIGUOUS_SUBSCRIPTION_POST_NETWORK_CODES.includes(err.code);
        const isAmbiguousSubscriptionStatus = status === 408 || (status >= 500 && status <= 599);

        if (suppressAmbiguousRetry && (isAmbiguousSubscriptionTransport || isAmbiguousSubscriptionStatus)) {
          throw ambiguousGraphError(
            `Graph API request failed with ambiguous outcome (HTTP ${status || err.code || 'network'}): ${errorMsg}`,
            {
              statusCode: status,
              code: errorCode,
              url: sanitizedPath,
              details: graphError?.innerError
            }
          );
        }

        if (isTransient5xx || isNetworkTimeout) {
          if (attempt <= this.maxRetries) {
            const delayMs = this._calculateBackoff(attempt);
            await this.sleepFn(delayMs);
            continue;
          }
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
  GraphThrottledError,
  isGraphSubscriptionCreate,
  isAuthRejectedBeforeProcessing
};

