'use strict';

const CrmUser = require('../../models/CrmUser');
const { CRM_PERMISSIONS } = require('../../constants/crmUsers');
const { hashPassword } = require('./crmUserPassword');

const DEV_EMAIL = 'test@guidexpert.local';
const DEV_USERNAME = 'test';
const DEV_PASSWORD = 'test123';

function localDevLoginEnabled() {
  if (process.env.CRM_DEV_LOGIN !== '1') return false;
  if (process.env.NODE_ENV === 'production') return false;
  const uri = String(process.env.MONGODB_URI || '');
  if (!uri || /mongodb\.net|mongodb\+srv/i.test(uri)) return false;
  return /^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(uri);
}

async function ensureLocalCrmTestUser() {
  if (!localDevLoginEnabled()) return;
  const passwordHash = await hashPassword(DEV_PASSWORD);
  await CrmUser.updateOne(
    { username: DEV_USERNAME },
    {
      $set: {
        email: DEV_EMAIL,
        username: DEV_USERNAME,
        fullName: 'Test User',
        passwordHash,
        status: 'active',
        role: 'crm_administrator',
        permissions: [...CRM_PERMISSIONS],
        deletedAt: null,
        failedLoginCount: 0,
        failedLoginWindowStart: null,
        lockedUntil: null,
      },
      $setOnInsert: { sessionVersion: 1 },
    },
    { upsert: true }
  );
  console.log('[crm] Local sign-in ready for username "test"');
}

module.exports = {
  ensureLocalCrmTestUser,
  localDevLoginEnabled,
};
