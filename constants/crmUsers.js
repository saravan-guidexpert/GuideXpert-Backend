'use strict';

/**
 * CRM-user authorization is separate from Admin.sectionAccess.
 * Platform admins reach account management through `crm-access-management`.
 * CRM users reach data and account APIs only with the permissions stored on their account.
 */
const CRM_ACCESS_SECTION = 'crm-access-management';

const CRM_PERMISSIONS = Object.freeze([
  'crm.dashboard.read',
  'crm.students.read',
  'crm.students.create',
  'crm.students.update',
  'crm.consultancies.read',
  'crm.consultancies.create',
  'crm.consultancies.update',
  'crm.referrals.read',
  'crm.referrals.create',
  'crm.referrals.correct_source',
  'crm.analytics.read',
  'crm.calendar.read',
  'crm.audit.read',
  'crm.users.read',
  'crm.users.create',
  'crm.users.update',
  'crm.users.deactivate',
  'crm.roles.manage',
]);

const CRM_READ_PERMISSIONS = Object.freeze(CRM_PERMISSIONS.filter((key) => key.endsWith('.read')));

const CRM_MANAGER_PERMISSIONS = Object.freeze([
  'crm.dashboard.read',
  'crm.students.read',
  'crm.students.create',
  'crm.students.update',
  'crm.consultancies.read',
  'crm.consultancies.create',
  'crm.consultancies.update',
  'crm.referrals.read',
  'crm.referrals.create',
  'crm.referrals.correct_source',
  'crm.analytics.read',
  'crm.calendar.read',
  'crm.audit.read',
]);

const CRM_ROLES = Object.freeze({
  crm_administrator: Object.freeze({
    label: 'CRM Administrator',
    rank: 3,
    permissions: CRM_PERMISSIONS,
  }),
  crm_manager: Object.freeze({
    label: 'CRM Manager',
    rank: 2,
    permissions: CRM_MANAGER_PERMISSIONS,
  }),
  crm_viewer: Object.freeze({
    label: 'CRM Viewer',
    rank: 1,
    permissions: CRM_READ_PERMISSIONS,
  }),
});

const CRM_ROLE_KEYS = Object.freeze(Object.keys(CRM_ROLES));

/** An active account that can still change other CRM accounts and their roles. */
const CRM_PRIVILEGED_PERMISSIONS = Object.freeze([
  'crm.users.update',
  'crm.users.deactivate',
  'crm.roles.manage',
]);

const CRM_ACCOUNT_STATUSES = Object.freeze(['active', 'inactive', 'invited']);

const PERMISSION_LABELS = Object.freeze({
  'crm.dashboard.read': 'Dashboard',
  'crm.students.read': 'View students',
  'crm.students.create': 'Create students',
  'crm.students.update': 'Update students',
  'crm.consultancies.read': 'View consultancies',
  'crm.consultancies.create': 'Create consultancies',
  'crm.consultancies.update': 'Update consultancies',
  'crm.referrals.read': 'View referrals',
  'crm.referrals.create': 'Create referrals',
  'crm.referrals.correct_source': 'Correct referral source',
  'crm.analytics.read': 'Analytics',
  'crm.calendar.read': 'Calendar',
  'crm.audit.read': 'Activity',
  'crm.users.read': 'View CRM users',
  'crm.users.create': 'Create CRM users',
  'crm.users.update': 'Update CRM users',
  'crm.users.deactivate': 'Deactivate CRM users',
  'crm.roles.manage': 'Manage roles',
});

function permissionForCrmRequest(method, originalUrl) {
  const verb = String(method || '').toUpperCase();
  const path = String(originalUrl || '').split('?')[0].replace(/\/+$/, '');
  const relative = path.startsWith('/api/crm') ? (path.slice('/api/crm'.length) || '/') : path;
  const rules = [
    ['POST', /^\/referrals\/[a-f\d]{24}\/source-correction$/i, 'crm.referrals.correct_source'],
    ['PATCH', /^\/referrals\/[a-f\d]{24}$/i, 'crm.referrals.create'],
    ['GET', /^\/referrals$/i, 'crm.referrals.read'],
    ['POST', /^\/referrals$/i, 'crm.referrals.create'],
    ['GET', /^\/students\/[a-f\d]{24}\/referral$/i, 'crm.referrals.read'],
    ['PATCH', /^\/students\/[a-f\d]{24}$/i, 'crm.students.update'],
    ['GET', /^\/students\/[a-f\d]{24}$/i, 'crm.students.read'],
    ['POST', /^\/students$/i, 'crm.students.create'],
    ['GET', /^\/students$/i, 'crm.students.read'],
    ['POST', /^\/consultancies\/[a-f\d]{24}\/contacts$/i, 'crm.consultancies.create'],
    ['PATCH', /^\/consultancies\/[a-f\d]{24}\/contacts\/[a-f\d]{24}$/i, 'crm.consultancies.update'],
    ['DELETE', /^\/consultancies\/[a-f\d]{24}\/contacts\/[a-f\d]{24}$/i, 'crm.consultancies.update'],
    ['GET', /^\/consultancies\/[a-f\d]{24}\/contacts$/i, 'crm.consultancies.read'],
    ['PATCH', /^\/consultancies\/[a-f\d]{24}$/i, 'crm.consultancies.update'],
    ['DELETE', /^\/consultancies\/[a-f\d]{24}$/i, 'crm.consultancies.update'],
    ['GET', /^\/consultancies\/[a-f\d]{24}$/i, 'crm.consultancies.read'],
    ['POST', /^\/consultancies$/i, 'crm.consultancies.create'],
    ['GET', /^\/consultancies$/i, 'crm.consultancies.read'],
    ['GET', /^\/analytics$/i, 'crm.analytics.read'],
    ['GET', /^\/calendar$/i, 'crm.calendar.read'],
    ['GET', /^\/audits$/i, 'crm.audit.read'],
  ];
  const found = rules.find((rule) => rule[0] === verb && rule[1].test(relative));
  return found ? found[2] : null;
}

function permissionSummary(permissions) {
  const granted = Array.isArray(permissions) ? permissions : [];
  const groups = [];
  if (granted.some((key) => key.startsWith('crm.students.'))) groups.push('Students');
  if (granted.some((key) => key.startsWith('crm.consultancies.'))) groups.push('Consultancies');
  if (granted.some((key) => key.startsWith('crm.referrals.'))) groups.push('Referrals');
  if (granted.includes('crm.analytics.read')) groups.push('Analytics');
  if (granted.includes('crm.calendar.read')) groups.push('Calendar');
  if (granted.includes('crm.audit.read')) groups.push('Activity');
  if (granted.some((key) => key.startsWith('crm.users.') || key === 'crm.roles.manage')) groups.push('Access');
  if (groups.length === 0) return 'No permissions';
  return groups.join(', ');
}

module.exports = {
  CRM_ACCESS_SECTION,
  CRM_PERMISSIONS,
  CRM_READ_PERMISSIONS,
  CRM_MANAGER_PERMISSIONS,
  CRM_ROLES,
  CRM_ROLE_KEYS,
  CRM_PRIVILEGED_PERMISSIONS,
  CRM_ACCOUNT_STATUSES,
  PERMISSION_LABELS,
  permissionForCrmRequest,
  permissionSummary,
};
