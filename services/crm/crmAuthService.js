'use strict';

const CrmUser = require('../../models/CrmUser');
const CrmSession = require('../../models/CrmSession');
const { CrmError } = require('../../utils/crmError');
const { requestMeta } = require('../../utils/crmHttp');
const { assertAllowedOrigin } = require('../../utils/crmOrigin');
const { assertLoginAllowed } = require('./crmLoginLimiter');
const { compareUnknownPassword, hashPassword, validatePassword } = require('./crmUserPassword');
const { accountSnapshot, writeAuthAudit } = require('./crmAuthAudit');
const { consumePasswordToken, invalidateOutstandingResetTokens } = require('./crmPasswordResetService');
const { normalizeEmail, revokeSessions, toDTO } = require('./crmUserAdminService');
const { commitWithAudit } = require('../../utils/crmMutation');
const { ensureLocalCrmTestUser } = require('./ensureLocalCrmTestUser');
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

async function registerFailure(userId, session) {
  const now = new Date();
  const user = await CrmUser.findOne({ _id: userId, deletedAt: null }).session(session).select('+passwordHash');
  if (!user) return null;
  if (!user.failedLoginWindowStart || now.getTime() - user.failedLoginWindowStart.getTime() > LOCK_MS) {
    user.failedLoginWindowStart = now;
    user.failedLoginCount = 1;
  } else {
    user.failedLoginCount += 1;
  }
  if (user.failedLoginCount >= LOCK_AFTER) {
    user.lockedUntil = new Date(now.getTime() + LOCK_MS);
  }
  await user.save({ session });
  return user;
}

async function login(body, req, res) {
  originOrThrow(req);
  const identifier = normalizeIdentifier(body && (body.identifier || body.email || body.username));
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!identifier || identifier.length > 200 || !password) {
    throw new CrmError(400, 'Email and password are required.', 'invalid_body');
  }
  await ensureLocalCrmTestUser();
  if (!(await assertLoginAllowed(clientIp(req), identifier))) {
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
    await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const saved = await registerFailure(user._id, session);
        if (!saved) throw new CrmError(401, GENERIC_LOGIN, 'invalid_credentials');
        return saved;
      },
      audit: (session, saved) => writeAuthAudit({
        targetUserId: saved._id,
        action: 'crm_user.login_failed',
        after: { status: saved.status },
      }, req, session),
    });
    return { status: 401, body: { success: false, message: GENERIC_LOGIN, code: 'invalid_credentials' } };
  }
  if (user.status !== 'active') {
    await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const current = await CrmUser.findOne({ _id: user._id, deletedAt: null }).session(session);
        if (!current) throw new CrmError(401, GENERIC_LOGIN, 'invalid_credentials');
        return current;
      },
      audit: (session, current) => writeAuthAudit({
        targetUserId: current._id,
        action: 'crm_user.login_inactive',
        after: accountSnapshot(current),
      }, req, session),
    });
    return { status: 403, body: { success: false, message: 'This account is inactive.', code: 'account_inactive' } };
  }
  const remember = body.remember === true;
  const meta = requestMeta(req);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const current = await CrmUser.findOne({ _id: user._id, deletedAt: null }).session(session).select('+passwordHash');
      if (!current) throw new CrmError(401, GENERIC_LOGIN, 'invalid_credentials');
      if (current.status !== 'active') return { inactive: true, user: current };
      const lastLoginAt = new Date();
      await CrmUser.updateOne(
        { _id: current._id },
        {
          $set: {
            failedLoginCount: 0,
            failedLoginWindowStart: null,
            lockedUntil: null,
            lastLoginAt,
          },
        },
        { session }
      );
      current.failedLoginCount = 0;
      current.failedLoginWindowStart = null;
      current.lockedUntil = null;
      current.lastLoginAt = lastLoginAt;
      const sessionToken = newSecret();
      const csrfToken = newSecret();
      await CrmSession.create([{
        userId: current._id,
        tokenHash: tokenHash(sessionToken),
        csrfToken,
        sessionVersion: current.sessionVersion || 1,
        remember,
        expiresAt: new Date(Date.now() + sessionLifetime(remember)),
        ip: meta.ip,
        userAgent: meta.userAgent,
      }], { session });
      return { inactive: false, user: current, sessionToken, csrfToken, remember };
    },
    audit: (session, created) => writeAuthAudit({
      actorCrmUserId: created.inactive ? null : created.user._id,
      targetUserId: created.user._id,
      action: created.inactive ? 'crm_user.login_inactive' : 'crm_user.login_succeeded',
      after: created.inactive ? accountSnapshot(created.user) : { remember: created.remember },
    }, req, session),
  });
  if (payload.inactive) {
    return { status: 403, body: { success: false, message: 'This account is inactive.', code: 'account_inactive' } };
  }
  setSessionCookies(res, payload.sessionToken, payload.csrfToken, payload.remember);
  return {
    status: 200,
    body: { success: true, data: { user: toDTO(payload.user), csrfToken: payload.csrfToken } },
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
      await commitWithAudit({
        requireTransaction: true,
        mutate: async (dbSession) => {
          const current = await CrmSession.findOne({ _id: session._id }).session(dbSession);
          if (!current || current.revokedAt) return { already: true };
          current.revokedAt = new Date();
          await current.save({ session: dbSession });
          return { already: false, userId: current.userId };
        },
        audit: (dbSession, saved) => {
          if (saved.already) return null;
          return writeAuthAudit({
            actorCrmUserId: saved.userId,
            targetUserId: saved.userId,
            action: 'crm_user.logout',
          }, req, dbSession);
        },
      });
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
  if (identifier && await assertLoginAllowed(clientIp(req), `forgot:${identifier}`)) {
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
  if (!(await assertLoginAllowed(clientIp(req), 'reset'))) {
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
  const passwordHash = await hashPassword(password);
  await commitWithAudit({
    requireTransaction: true,
    mutate: async (session) => {
      const consumed = await consumePasswordToken(token, session);
      if (!consumed) throw new CrmError(400, 'Reset code is invalid or expired.', 'reset_invalid');
      await invalidateOutstandingResetTokens(consumed.userId, session, consumed._id);
      const current = await CrmUser.findOne({ _id: user._id, deletedAt: null }).session(session).select('+passwordHash');
      if (!current) throw new CrmError(400, 'Reset code is invalid or expired.', 'reset_invalid');
      const before = accountSnapshot(current);
      current.passwordHash = passwordHash;
      current.passwordChangedAt = new Date();
      if (current.status === 'invited') current.status = 'active';
      await revokeSessions(current, session);
      await current.save({ session });
      return { before, user: current };
    },
    audit: (session, saved) => writeAuthAudit({
      targetUserId: saved.user._id,
      action: 'crm_user.reset_completed',
      before: saved.before,
      after: accountSnapshot(saved.user),
    }, req, session),
  });
  return { status: 200, body: { success: true, message: 'Password updated.' } };
}

module.exports = {
  login,
  logout,
  currentUser,
  forgotPassword,
  resetPassword,
};
