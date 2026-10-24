'use strict';

const CrmUser = require('../../models/CrmUser');
const CrmSession = require('../../models/CrmSession');
const { CrmError } = require('../../utils/crmError');
const { requestMeta } = require('../../utils/crmHttp');
const { assertAllowedOrigin } = require('../../utils/crmOrigin');
const { assertLoginAllowed } = require('./crmLoginLimiter');
const { compareUnknownPassword, hashPassword, validatePassword } = require('./crmUserPassword');
const { accountSnapshot, writeAuthAudit } = require('./crmAuthAudit');
const { consumePasswordToken } = require('./crmPasswordResetService');
const { toDTO, normalizeEmail } = require('./crmUserAdminService');
const {
  SESSION_COOKIE,
  clearSessionCookies,
  newSecret,
  readCookies,
  sessionLifetime,
  setCsrfCookie,
  setSessionCookies,
  tokenHash,
} = require('./crmCookies');

const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60 * 1000;
const GENERIC_LOGIN = 'Invalid email or password';

function clientIp(req) {
  return String((req && req.ip) || 'unknown').slice(0, 80);
}

function normalizeIdentifier(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function originOrThrow(req) {
  if (!assertAllowedOrigin(req)) {
    throw new CrmError(403, 'This origin is not allowed.', 'origin_forbidden');
  }
}

async function registerFailure(user) {
  const now = new Date();
  if (!user.failedLoginWindowStart || now.getTime() - user.failedLoginWindowStart.getTime() > LOCK_MS) {
    user.failedLoginWindowStart = now;
    user.failedLoginCount = 1;
  } else {
    user.failedLoginCount += 1;
  }
  if (user.failedLoginCount >= LOCK_AFTER) {
    user.lockedUntil = new Date(now.getTime() + LOCK_MS);
  }
  await user.save();
}

async function login(body, req, res) {
  originOrThrow(req);
  const identifier = normalizeIdentifier(body && (body.identifier || body.email || body.username));
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!identifier || identifier.length > 200 || !password) {
    throw new CrmError(400, 'Email and password are required.', 'invalid_body');
  }
  if (!assertLoginAllowed(clientIp(req), identifier)) {
    throw new CrmError(429, 'Too many attempts. Try again later.', 'rate_limited');
  }
  const user = await CrmUser.findOne({
    deletedAt: null,
    $or: [{ email: identifier }, { username: identifier }],
  }).select('+passwordHash');
  if (!user) {
    await compareUnknownPassword(password);
    return { status: 401, body: { success: false, message: GENERIC_LOGIN, code: 'invalid_credentials' } };
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await compareUnknownPassword(password);
    return { status: 401, body: { success: false, message: GENERIC_LOGIN, code: 'invalid_credentials' } };
  }
  const matches = await user.comparePassword(password);
  if (!matches) {
    await registerFailure(user);
    await writeAuthAudit({
      targetUserId: user._id,
      action: 'crm_user.login_failed',
      after: { status: user.status },
    }, req);
    return { status: 401, body: { success: false, message: GENERIC_LOGIN, code: 'invalid_credentials' } };
  }
  if (user.status !== 'active') {
    await writeAuthAudit({
      targetUserId: user._id,
      action: 'crm_user.login_inactive',
      after: accountSnapshot(user),
    }, req);
    return { status: 403, body: { success: false, message: 'This account is inactive.', code: 'account_inactive' } };
  }
  user.failedLoginCount = 0;
  user.failedLoginWindowStart = null;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();
  const remember = body.remember === true;
  const sessionToken = newSecret();
  const csrfToken = newSecret();
  const meta = requestMeta(req);
  await CrmSession.create({
    userId: user._id,
    tokenHash: tokenHash(sessionToken),
    csrfToken,
    sessionVersion: user.sessionVersion || 1,
    remember,
    expiresAt: new Date(Date.now() + sessionLifetime(remember)),
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  setSessionCookies(res, sessionToken, csrfToken, remember);
  await writeAuthAudit({
    actorCrmUserId: user._id,
    targetUserId: user._id,
    action: 'crm_user.login_succeeded',
    after: { remember },
  }, req);
  return {
    status: 200,
    body: { success: true, data: { user: toDTO(user), csrfToken } },
  };
}

async function logout(req, res) {
  const cookies = readCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (raw) {
    const session = await CrmSession.findOne({ tokenHash: tokenHash(raw) });
    if (session && !session.revokedAt) {
      const header = req.get('x-crm-csrf') || '';
      if (!header || header !== session.csrfToken) {
        throw new CrmError(403, 'CSRF check failed.', 'csrf_failed');
      }
      session.revokedAt = new Date();
      await session.save();
      await writeAuthAudit({
        actorCrmUserId: session.userId,
        targetUserId: session.userId,
        action: 'crm_user.logout',
      }, req);
    }
  }
  clearSessionCookies(res);
  return { status: 200, body: { success: true } };
}

function currentUser(req, res) {
  setCsrfCookie(res, req.crmSession.csrfToken, req.crmSession.remember === true);
  return {
    status: 200,
    body: {
      success: true,
      data: { user: toDTO(req.crmUser), csrfToken: req.crmSession.csrfToken },
    },
  };
}

async function forgotPassword(body, req) {
  originOrThrow(req);
  const identifier = normalizeIdentifier(body && (body.identifier || body.email));
  if (identifier && assertLoginAllowed(clientIp(req), `forgot:${identifier}`)) {
    const user = await CrmUser.findOne({
      deletedAt: null,
      status: { $in: ['active', 'inactive', 'invited'] },
      $or: [{ email: normalizeEmail(identifier) }, { username: identifier }],
    });
    if (user) {
      await writeAuthAudit({
        targetUserId: user._id,
        action: 'crm_user.reset_requested',
        after: { delivery: 'not_configured' },
      }, req);
    }
  }
  return {
    status: 200,
    body: {
      success: true,
      message: 'If an administrator can verify the account, they can issue a reset code. Email delivery is not configured.',
      delivery: 'not_configured',
    },
  };
}

async function resetPassword(body, req) {
  originOrThrow(req);
  const password = body && typeof body.password === 'string' ? body.password : '';
  const token = body && typeof body.token === 'string' ? body.token : '';
  if (!assertLoginAllowed(clientIp(req), 'reset')) {
    throw new CrmError(429, 'Too many attempts. Try again later.', 'rate_limited');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new CrmError(400, 'Password must be 10–128 characters and include a letter and a number.', 'weak_password');
  }
  const CrmPasswordReset = require('../../models/CrmPasswordReset');
  const { tokenHash: hashToken } = require('./crmCookies');
  const pending = token.trim().length >= 20
    ? await CrmPasswordReset.findOne({ tokenHash: hashToken(token.trim()), usedAt: null, expiresAt: { $gt: new Date() } })
    : null;
  if (!pending) throw new CrmError(400, 'Reset code is invalid or expired.', 'reset_invalid');
  const user = await CrmUser.findOne({ _id: pending.userId, deletedAt: null }).select('+passwordHash');
  if (!user) throw new CrmError(400, 'Reset code is invalid or expired.', 'reset_invalid');
  validatePassword(password, [user.email, user.username]);
  const consumed = await consumePasswordToken(token);
  if (!consumed) throw new CrmError(400, 'Reset code is invalid or expired.', 'reset_invalid');
  const before = accountSnapshot(user);
  user.passwordHash = await hashPassword(password);
  user.passwordChangedAt = new Date();
  if (user.status === 'invited') user.status = 'active';
  user.sessionVersion = (user.sessionVersion || 1) + 1;
  await CrmSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await user.save();
  await writeAuthAudit({
    targetUserId: user._id,
    action: 'crm_user.reset_completed',
    before,
    after: accountSnapshot(user),
  }, req);
  return { status: 200, body: { success: true, message: 'Password updated.' } };
}

module.exports = {
  login,
  logout,
  currentUser,
  forgotPassword,
  resetPassword,
};
