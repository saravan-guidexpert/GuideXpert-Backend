'use strict';

const CrmUser = require('../../models/CrmUser');
const { CRM_MANAGER_PERMISSIONS, CRM_PERMISSIONS } = require('../../constants/crmUsers');
const { hashPassword } = require('./crmUserPassword');

/**
 * Local CRM sign-in only. These passwords are shorter than the account-creation
 * policy and are never written when NODE_ENV is production or the database is remote.
 */
const LOCAL_ACCOUNTS = Object.freeze([
  {
    email: 'admin@guidexpert.local',
    username: 'admin',
    password: 'admin123',
    fullName: 'CRM Administrator',
    role: 'crm_administrator',
    permissions: CRM_PERMISSIONS,
  },
  {
    email: 'test@guidexpert.local',
    username: 'test',
    password: 'test123',
    fullName: 'Test User',
    role: 'crm_manager',
    permissions: CRM_MANAGER_PERMISSIONS,
  },
]);

function localDevLoginEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  const uri = String(process.env.MONGODB_URI || '');
  if (!uri || /mongodb\.net|mongodb\+srv/i.test(uri)) return false;
  return /^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(uri);
}

async function ensureLocalCrmTestUser() {
  if (!localDevLoginEnabled()) return;
  for (const account of LOCAL_ACCOUNTS) {
    const passwordHash = await hashPassword(account.password);
    try {
      await CrmUser.updateOne(
        { username: account.username },
        {
          $set: {
            email: account.email,
            username: account.username,
            fullName: account.fullName,
            passwordHash,
            status: 'active',
            role: account.role,
            permissions: [...account.permissions],
            deletedAt: null,
            failedLoginCount: 0,
            failedLoginWindowStart: null,
            lockedUntil: null,
          },
          $setOnInsert: { sessionVersion: 1 },
        },
        { upsert: true }
      );
    } catch (err) {
      if (err && err.code === 11000) {
        console.warn(`[crm] Local sign-in for username "${account.username}" was left unchanged because that email or username belongs to another account.`);
        continue;
      }
      throw err;
    }
    console.log(`[crm] Local sign-in ready for username "${account.username}" (${account.role})`);
  }
}

module.exports = {
  LOCAL_ACCOUNTS,
  ensureLocalCrmTestUser,
  localDevLoginEnabled,
};
