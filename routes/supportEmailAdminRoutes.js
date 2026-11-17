'use strict';

const express = require('express');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { recoverManualSubscription } = require('../controllers/supportEmailRecoveryController');

/**
 * Admin recovery for a Graph subscription operation stuck in manual_required.
 * Mounted behind requireAdmin. The POST itself also requires a super admin,
 * matching the WhatsApp manual-recovery start action.
 */
function createSupportEmailAdminRouter({ getSubscriptionService } = {}) {
  const router = express.Router();
  router.post('/subscriptions/recovery', requireSuperAdmin, (req, res) => (
    recoverManualSubscription(req, res, getSubscriptionService)
  ));
  return router;
}

module.exports = createSupportEmailAdminRouter();
module.exports.createSupportEmailAdminRouter = createSupportEmailAdminRouter;
