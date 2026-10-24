'use strict';

const crypto = require('crypto');
const CrmPasswordReset = require('../../models/CrmPasswordReset');
const { tokenHash, newSecret } = require('./crmCookies');

const RESET_MS = 30 * 60 * 1000;

async function issuePasswordToken(user, actor, purpose) {
  const token = newSecret();
  const expiresAt = new Date(Date.now() + RESET_MS);
  await CrmPasswordReset.create({
    userId: user._id,
    tokenHash: tokenHash(token),
    purpose,
    expiresAt,
    createdByAdminId: actor && actor.kind === 'admin' ? actor.id : null,
    createdByCrmUserId: actor && actor.kind === 'crm-user' ? actor.id : null,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

async function consumePasswordToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.trim().length < 20) return null;
  const now = new Date();
  return CrmPasswordReset.findOneAndUpdate(
    { tokenHash: tokenHash(rawToken.trim()), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true }
  );
}

function hashTokenForTests(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  RESET_MS,
  issuePasswordToken,
  consumePasswordToken,
  hashTokenForTests,
};
