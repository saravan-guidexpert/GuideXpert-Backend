'use strict';

const { APPROVED_MAILBOX, mailboxScopeStatus } = require('./mailboxScopeService');

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Fail-closed gate for mailbox synchronization.
 * Every blocker stops Microsoft Graph access. Scope verification is an
 * administrator record; this process cannot see Exchange RBAC.
 */
function assessIngestionSafety({ mailbox, policy, cursor, env = process.env } = {}) {
  const blockers = [];
  const scope = mailboxScopeStatus(env);
  const normMailbox = String(mailbox || '').trim().toLowerCase();
  if (scope.status !== 'VERIFIED') blockers.push('MAILBOX_SCOPE_UNVERIFIED');
  if (normMailbox !== APPROVED_MAILBOX) blockers.push('wrong_mailbox');
  if (!policy) blockers.push('policy_missing');
  else if (policy.enabled !== true) blockers.push('policy_disabled');
  else if (String(policy.mailbox || '').trim().toLowerCase() !== APPROVED_MAILBOX) blockers.push('wrong_mailbox');
  const activationAt = validDate(policy && policy.activationAt);
  if (!activationAt) blockers.push('activation_missing');
  if (cursor && cursor.baselineStrategy === 'unfiltered') blockers.push('unsafe_unfiltered_baseline');
  return {
    ok: blockers.length === 0,
    blockers,
    approvedMailbox: APPROVED_MAILBOX,
    mailboxScope: scope.status,
    activationAt
  };
}

function safetyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  assessIngestionSafety,
  safetyError,
  validDate
};
