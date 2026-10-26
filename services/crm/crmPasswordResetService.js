'use strict';

const crypto = require('crypto');
const CrmPasswordReset = require('../../models/CrmPasswordReset');
const { CrmError } = require('../../utils/crmError');
const { tokenHash, newSecret } = require('./crmCookies');

const RESET_MS = 30 * 60 * 1000;

function requireTokenSession(session) {
  if (!session) {
    throw new CrmError(
      503,
      'This change requires a MongoDB transaction, and this database does not support transactions. Nothing was changed.',
      'transaction_required'
    );
  }
}

async function issuePasswordToken(user, actor, purpose, session) {
  requireTokenSession(session);
  const token = newSecret();
  const expiresAt = new Date(Date.now() + RESET_MS);
  await CrmPasswordReset.create([{
    userId: user._id,
    tokenHash: tokenHash(token),
    purpose,
    expiresAt,
    createdByAdminId: actor && actor.kind === 'admin' ? actor.id : null,
    createdByCrmUserId: actor && actor.kind === 'crm-user' ? actor.id : null,
  }], { session });
  return { token, expiresAt: expiresAt.toISOString() };
}

async function consumePasswordToken(rawToken, session) {
  if (typeof rawToken !== 'string' || rawToken.trim().length < 20) return null;
  requireTokenSession(session);
  const now = new Date();
  return CrmPasswordReset.findOneAndUpdate(
    { tokenHash: tokenHash(rawToken.trim()), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true, session }
  );
}

async function invalidateOutstandingResetTokens(userId, session, exceptId) {
  requireTokenSession(session);
  const filter = { userId, usedAt: null };
  if (exceptId) filter._id = { $ne: exceptId };
  await CrmPasswordReset.updateMany(filter, { $set: { usedAt: new Date() } }, { session });
}

function hashTokenForTests(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  RESET_MS,
  issuePasswordToken,
  consumePasswordToken,
  invalidateOutstandingResetTokens,
  hashTokenForTests,
};
