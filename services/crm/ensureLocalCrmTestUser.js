'use strict';

const CrmUser = require('../../models/CrmUser');
const { CRM_MANAGER_PERMISSIONS, CRM_PERMISSIONS } = require('../../constants/crmUsers');
const { hashPassword } = require('./crmUserPassword');

/**
 * Sign-in accounts requested for the CRM portal. The passwords are shorter than
 * the account-creation form allows, so they are stored here and accepted by login.
 * Tests skip this so fixtures stay under the test's control.
 */
let seeded = false;
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
  return process.env.NODE_ENV !== 'test';
}

async function ensureLocalCrmTestUser() {
  if (!localDevLoginEnabled() || seeded) return;
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
        console.warn(`[crm] Sign-in for username "${account.username}" was left unchanged because that email or username belongs to another account.`);
        continue;
      }
      throw err;
    }
    console.log(`[crm] Sign-in ready for username "${account.username}" (${account.role})`);
  }
  seeded = true;
}

module.exports = {
  LOCAL_ACCOUNTS,
  ensureLocalCrmTestUser,
  localDevLoginEnabled,
};
