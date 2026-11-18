'use strict';

const APPROVED_MAILBOX = 'support@niatindia.com';

/**
 * Exchange Online application RBAC is not visible to this process.
 * Message retrieval stays blocked until an administrator records that the
 * app role is scoped only to the approved mailbox. This flag is not set here.
 */
function mailboxScopeStatus(env = process.env) {
  const verified = String(env.SUPPORT_EMAIL_EXCHANGE_SCOPE_VERIFIED || '').trim() === '1';
  const mailbox = String(env.SUPPORT_EMAIL_EXCHANGE_SCOPE_MAILBOX || '').trim().toLowerCase();
  if (verified && mailbox === APPROVED_MAILBOX) {
    return { status: 'VERIFIED', approvedMailbox: APPROVED_MAILBOX };
  }
  return {
    status: 'MAILBOX_SCOPE_UNVERIFIED',
    approvedMailbox: APPROVED_MAILBOX,
    reason: 'Exchange Online application RBAC for support@niatindia.com is not recorded. This restricts which mailbox the application can read. It does not change Outlook delivery, forwarding, or user permissions.'
  };
}

module.exports = {
  APPROVED_MAILBOX,
  mailboxScopeStatus
};
