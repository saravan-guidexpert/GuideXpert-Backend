'use strict';

const { permissionForCrmRequest } = require('../constants/crmUsers');

function crmPortalGate(req, res, next) {
  const permission = permissionForCrmRequest(req.method, req.originalUrl || req.url || '');
  if (!permission) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  const granted = req.crmUser && Array.isArray(req.crmUser.permissions) ? req.crmUser.permissions : [];
  if (!granted.includes(permission)) {
    return res.status(403).json({
      success: false,
      message: 'You do not have permission for this CRM action.',
      code: 'permission_denied',
    });
  }
  return next();
}

module.exports = crmPortalGate;
