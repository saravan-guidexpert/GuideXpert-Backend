'use strict';

const { SubscriptionService, presentRecoveryResult } = require('../services/supportEmail/subscriptionService');

/**
 * Super-admin retry of a manual_required Graph subscription operation.
 * The service still verifies clientState from GET /subscriptions/{id}.
 * This action does not POST and does not release the reservation on its own.
 */
async function recoverManualSubscription(req, res, getSubscriptionService) {
  const operationId = typeof req.body?.operationId === 'string' ? req.body.operationId.trim() : '';
  if (!operationId) {
    return res.status(400).json({ success: false, message: 'operationId is required' });
  }

  try {
    const service = typeof getSubscriptionService === 'function'
      ? getSubscriptionService()
      : new SubscriptionService();
    const recovery = await service.recoverManualAmbiguousOperation({
      operationId,
      operator: {
        adminId: req.admin._id,
        ip: req.ip || null,
        userAgent: req.get('user-agent') || null
      }
    });

    if (recovery.reason === 'not_found') {
      return res.status(404).json({ success: false, message: 'Operation not found', operationId });
    }
    if (recovery.reason === 'not_manual_required') {
      return res.status(409).json({
        success: false,
        message: 'Operation is not awaiting manual recovery',
        operationId,
        recoveryState: recovery.recoveryState || null
      });
    }
    if (recovery.reason === 'unauthorized') {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    return res.status(200).json({
      success: true,
      ...presentRecoveryResult(recovery)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Manual recovery could not be completed',
      operationId
    });
  }
}

module.exports = {
  recoverManualSubscription
};
