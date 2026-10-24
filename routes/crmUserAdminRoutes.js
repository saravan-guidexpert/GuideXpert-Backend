'use strict';

const express = require('express');
const users = require('../controllers/crmUserAdminController');
const { requireCrmPermission } = require('../middleware/requireCrmSession');

function createCrmUserAdminRouter(mode) {
  const router = express.Router();
  const gate = (permission) => (
    mode === 'crm'
      ? requireCrmPermission(permission)
      : (req, res, next) => next()
  );

  router.get('/summary', gate('crm.users.read'), users.summary);
  router.get('/', gate('crm.users.read'), users.list);
  router.post('/', gate('crm.users.create'), users.create);
  router.get('/:id/audit', gate('crm.users.read'), users.audit);
  router.post('/:id/deactivate', gate('crm.users.deactivate'), users.deactivate);
  router.post('/:id/activate', gate('crm.users.update'), users.activate);
  router.post('/:id/reset-password', gate('crm.users.update'), users.resetPassword);
  router.get('/:id', gate('crm.users.read'), users.getOne);
  router.patch('/:id', gate('crm.users.update'), users.update);
  return router;
}

module.exports = {
  adminCrmUserRoutes: createCrmUserAdminRouter('admin'),
  portalCrmUserRoutes: createCrmUserAdminRouter('crm'),
};
