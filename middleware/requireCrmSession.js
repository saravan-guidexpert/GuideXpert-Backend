'use strict';

const CrmSession = require('../models/CrmSession');
const CrmUser = require('../models/CrmUser');
const { readCookies, SESSION_COOKIE, tokenHash } = require('../services/crm/crmCookies');

function fail(res, status, message, code) {
  return res.status(status).json({ success: false, message, code });
}

async function requireCrmSession(req, res, next) {
  try {
    const token = readCookies(req)[SESSION_COOKIE];
    if (!token) return fail(res, 401, 'Authentication required', 'authentication_required');
    const session = await CrmSession.findOne({ tokenHash: tokenHash(token) });
    if (!session) return fail(res, 401, 'Authentication required', 'invalid_token');
    if (session.revokedAt) return fail(res, 401, 'Session expired', 'session_revoked');
    if (session.expiresAt.getTime() <= Date.now()) return fail(res, 401, 'Session expired', 'session_expired');
    const user = await CrmUser.findById(session.userId);
    if (!user || user.deletedAt) return fail(res, 401, 'Authentication required', 'invalid_token');
    if (session.sessionVersion !== user.sessionVersion) return fail(res, 401, 'Session expired', 'session_revoked');
    if (user.status !== 'active') return fail(res, 401, 'This account is inactive.', 'account_inactive');
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const header = req.get('x-crm-csrf') || '';
      if (!header || header !== session.csrfToken) return fail(res, 403, 'CSRF check failed.', 'csrf_failed');
    }
    req.crmSession = session;
    req.crmUser = user;
    return next();
  } catch (err) {
    console.error('[crm-session]', err && err.message ? err.message : 'error');
    return fail(res, 500, 'Something went wrong.', 'server_error');
  }
}

function requireCrmPermission(permission) {
  return function crmPermission(req, res, next) {
    if (!req.crmUser) return fail(res, 401, 'Authentication required', 'authentication_required');
    const granted = Array.isArray(req.crmUser.permissions) ? req.crmUser.permissions : [];
    if (!granted.includes(permission)) {
      return fail(res, 403, 'You do not have permission for this CRM action.', 'permission_denied');
    }
    return next();
  };
}

module.exports = {
  requireCrmSession,
  requireCrmPermission,
};
