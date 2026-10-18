'use strict';

const { CRM_SECTION, CRM_MANAGER_SECTION } = require('../../constants/crm');
const { writeAudit } = require('./auditService');
const { requestMeta } = require('../../utils/crmHttp');

function permissionFlags(admin) {
  const access = Array.isArray(admin && admin.sectionAccess) ? admin.sectionAccess : [];
  const isSuperAdmin = admin && admin.isSuperAdmin === true;
  return {
    isSuperAdmin,
    consultancyCrm: isSuperAdmin || access.includes(CRM_SECTION),
    consultancyCrmManager: isSuperAdmin || access.includes(CRM_MANAGER_SECTION),
  };
}

function sameFlags(left, right) {
  return left.isSuperAdmin === right.isSuperAdmin
    && left.consultancyCrm === right.consultancyCrm
    && left.consultancyCrmManager === right.consultancyCrmManager;
}

function crmAccessChanged(beforeAdmin, afterAdmin) {
  return !sameFlags(permissionFlags(beforeAdmin), permissionFlags(afterAdmin));
}

async function auditCrmPermissionChange({
  actorAdminId,
  targetAdminId,
  beforeAdmin,
  afterAdmin,
  req,
  session,
  action = 'crm_permission.updated',
}) {
  const before = permissionFlags(beforeAdmin);
  const after = permissionFlags(afterAdmin);
  if (sameFlags(before, after)) return null;
  const meta = requestMeta(req);
  return writeAudit({
    actorAdminId,
    action,
    entityType: 'admin',
    entityId: targetAdminId,
    before,
    after,
    ip: meta.ip,
    userAgent: meta.userAgent,
  }, session);
}

module.exports = { auditCrmPermissionChange, permissionFlags, crmAccessChanged };
