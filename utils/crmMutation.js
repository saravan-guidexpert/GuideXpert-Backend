'use strict';

const mongoose = require('mongoose');
const { CrmError } = require('./crmError');

let transactionsEnabled = true;

function errorText(err) {
  const seen = new Set();
  const parts = [];
  function visit(value, depth) {
    if (!value || depth > 4 || seen.has(value)) return;
    if (typeof value !== 'object') {
      parts.push(String(value));
      return;
    }
    seen.add(value);
    if (value.message) parts.push(String(value.message));
    visit(value.cause, depth + 1);
    visit(value.errorResponse, depth + 1);
  }
  visit(err, 0);
  return parts.join(' ');
}

function isTransactionUnsupported(err) {
  const msg = errorText(err);
  return (
    msg.includes('Transaction numbers are only allowed') ||
    msg.includes('replica set member') ||
    msg.includes('transactions are not supported')
  );
}

function setTransactionsEnabledForTests(enabled) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRM transaction test controls are refused in production.');
  }
  transactionsEnabled = enabled !== false;
}

function transactionRequiredError() {
  return new CrmError(
    503,
    'This change requires a MongoDB transaction, and this database does not support transactions. Nothing was changed.',
    'transaction_required'
  );
}

/**
 * Runs mutate, then audit, in one MongoDB transaction.
 * CRM entity writes and CRM permission changes pass requireTransaction so a standalone
 * server fails before any non-transactional write. The sequential fallback remains only
 * when a caller explicitly sets requireTransaction to false. That fallback is not atomic.
 */
async function commitWithAudit({ mutate, audit, compensate, requireTransaction = true }) {
  const session = await mongoose.startSession();
  try {
    let payload;
    try {
      if (!transactionsEnabled) {
        const err = new Error('Transaction numbers are only allowed on a replica set member or mongos');
        err.code = 20;
        throw err;
      }
      await session.withTransaction(async () => {
        payload = await mutate(session);
        await audit(session, payload);
      });
      return { payload, consistency: 'transaction' };
    } catch (err) {
      if (!isTransactionUnsupported(err)) throw err;
      if (requireTransaction) throw transactionRequiredError();
    }
  } finally {
    await session.endSession();
  }

  const payload = await mutate(null);
  try {
    await audit(null, payload);
  } catch (auditError) {
    auditError.crmConsistency = 'sequential-with-compensation';
    if (typeof compensate === 'function') {
      try {
        await compensate(payload);
        auditError.crmCompensated = true;
      } catch (compensateError) {
        auditError.crmCompensated = false;
        auditError.compensateError = compensateError;
      }
    }
    throw auditError;
  }
  return { payload, consistency: 'sequential-with-compensation' };
}

module.exports = {
  commitWithAudit,
  isTransactionUnsupported,
  setTransactionsEnabledForTests,
};
