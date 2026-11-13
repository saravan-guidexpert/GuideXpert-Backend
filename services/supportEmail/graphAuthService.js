'use strict';

const axios = require('axios');

/**
 * Microsoft Graph OAuth 2.0 Client Credentials Authentication Service
 *
 * Implements application-level token acquisition, caching, and safe refresh.
 *
 * Security & Data Protection:
 * - Credentials are read exclusively from environment configuration.
 * - Tokens and client secrets are never printed in log output.
 * - Thread-safe request coalescing prevents duplicate token acquisition bursts.
 */
class GraphAuthService {
  constructor(config = {}) {
    this.tenantId = config.tenantId || process.env.MS_GRAPH_TENANT_ID || '';
    this.clientId = config.clientId || process.env.MS_GRAPH_CLIENT_ID || '';
    this.clientSecret = config.clientSecret || process.env.MS_GRAPH_CLIENT_SECRET || '';
    this.authUrl = config.authUrl || process.env.MS_GRAPH_AUTH_URL || 'https://login.microsoftonline.com';
    this.scope = config.scope || 'https://graph.microsoft.com/.default';
    this.refreshBufferSeconds = config.refreshBufferSeconds || 300; // 5 minutes buffer
    this.httpRequester = config.httpRequester || axios.post;

    // In-memory token cache
    this.cachedToken = null;
    this.tokenExpiresAt = 0; // Milliseconds timestamp
    this.inFlightTokenPromise = null;
  }

  /**
   * Validates that required environment credentials are present.
   */
  validateConfig() {
    if (!this.tenantId || !this.clientId || !this.clientSecret) {
      const missing = [];
      if (!this.tenantId) missing.push('MS_GRAPH_TENANT_ID');
      if (!this.clientId) missing.push('MS_GRAPH_CLIENT_ID');
      if (!this.clientSecret) missing.push('MS_GRAPH_CLIENT_SECRET');
      throw new Error(`[GraphAuthService] Missing required Azure AD configuration: ${missing.join(', ')}`);
    }
  }

  /**
   * Returns a valid Bearer access token, using cache or acquiring a new one.
   *
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh=false] Bypass cache and acquire fresh token
   * @returns {Promise<string>} Access token string
   */
  async getAccessToken({ forceRefresh = false } = {}) {
    const now = Date.now();
    const bufferMs = this.refreshBufferSeconds * 1000;

    // Return cached token if still valid beyond buffer
    if (!forceRefresh && this.cachedToken && this.tokenExpiresAt - now > bufferMs) {
      return this.cachedToken;
    }

    // Coalesce concurrent in-flight acquisition requests
    if (this.inFlightTokenPromise) {
      return this.inFlightTokenPromise;
    }

    this.inFlightTokenPromise = this._acquireToken()
      .finally(() => {
        this.inFlightTokenPromise = null;
      });

    return this.inFlightTokenPromise;
  }

  /**
   * Internal worker executing OAuth2 client_credentials token grant.
   */
  async _acquireToken() {
    this.validateConfig();

    const tokenUrl = `${this.authUrl.replace(/\/+$/, '')}/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope,
      grant_type: 'client_credentials'
    });

    try {
      const response = await this.httpRequester(tokenUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      });

      const data = response?.data;
      if (!data || !data.access_token) {
        throw new Error('[GraphAuthService] Malformed OAuth response from Azure AD (missing access_token)');
      }

      const expiresInSeconds = Number(data.expires_in) || 3599;
      this.cachedToken = data.access_token;
      this.tokenExpiresAt = Date.now() + expiresInSeconds * 1000;

      return this.cachedToken;
    } catch (err) {
      // Clear cache on failure
      this.cachedToken = null;
      this.tokenExpiresAt = 0;

      // Sanitize error: never leak client_secret or post body in error messages
      const status = err.response?.status;
      const errorDescription = err.response?.data?.error_description || err.response?.data?.error || err.message;
      const sanitizedMsg = `[GraphAuthService] Failed to acquire token (HTTP ${status || 'network'}): ${errorDescription}`;
      const authErr = new Error(sanitizedMsg);
      authErr.statusCode = status;
      authErr.isAuthError = true;
      throw authErr;
    }
  }

  /**
   * Explicitly evicts the cached token (e.g. after receiving HTTP 401 from Graph).
   */
  clearCachedToken() {
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }
}

// Default singleton instance using environment variables
const defaultAuthService = new GraphAuthService();

module.exports = {
  GraphAuthService,
  defaultAuthService
};

