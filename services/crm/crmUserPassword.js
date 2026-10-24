'use strict';

const bcrypt = require('bcryptjs');
const { CrmError } = require('../../utils/crmError');

function bcryptRounds() {
  const configured = Number(process.env.CRM_BCRYPT_ROUNDS || 12);
  if (process.env.NODE_ENV === 'test' && Number.isInteger(configured) && configured >= 4 && configured <= 15) {
    return configured;
  }
  if (Number.isInteger(configured) && configured >= 10 && configured <= 15) return configured;
  return 12;
}

function validatePassword(password, identifiers = []) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new CrmError(400, 'Password must be 10–128 characters.', 'weak_password');
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new CrmError(400, 'Password must include a letter and a number.', 'weak_password');
  }
  const lowered = password.toLowerCase();
  const matched = identifiers.some((value) => value && lowered === String(value).toLowerCase());
  if (matched) {
    throw new CrmError(400, 'Password must not match the email or username.', 'weak_password');
  }
  return password;
}

async function hashPassword(password) {
  return bcrypt.hash(password, bcryptRounds());
}

let dummyHash = null;

async function compareUnknownPassword(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash('crm-unknown-account-placeholder', bcryptRounds());
  await bcrypt.compare(String(password || ''), dummyHash);
}

module.exports = {
  bcryptRounds,
  validatePassword,
  hashPassword,
  compareUnknownPassword,
};
