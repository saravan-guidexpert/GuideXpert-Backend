'use strict';

const express = require('express');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { recoverManualSubscription } = require('../controllers/supportEmailRecoveryController');
const dashboard = require('../services/supportEmail/adminDashboardService');
const singleEmailTest = require('../services/supportEmail/singleEmailTestService');
const { checkGraphAuthentication } = require('../services/supportEmail/graphHealthService');
const ingestionPolicy = require('../services/supportEmail/ingestionPolicyService');

function requireSupportEmailAccess(req, res, next) {
  const admin = req.admin;
  const access = admin && Array.isArray(admin.sectionAccess) ? admin.sectionAccess : [];
  if (admin && (admin.isSuperAdmin || access.includes('support-email'))) return next();
  return res.status(403).json({ success: false, message: 'Forbidden' });
}

function sendError(res, error) {
  const status = error && error.status ? error.status : 500;
  return res.status(status).json({ success: false, message: error && error.code ? error.code : 'request_failed' });
}

/**
 * Admin recovery and the support-email dashboard.
 * Mounted behind requireAdmin. Recovery still requires a super admin.
 * Dashboard routes require the support-email section or super-admin access.
 */
function createSupportEmailAdminRouter({ getSubscriptionService } = {}) {
  const router = express.Router();
  router.post('/subscriptions/recovery', requireSuperAdmin, (req, res) => (
    recoverManualSubscription(req, res, getSubscriptionService)
  ));

  router.get('/overview', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, overview: await dashboard.overview(req.query) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/tickets', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, ...(await dashboard.listTickets(req.query)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/tickets/:id', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, ticket: await dashboard.ticketDetail(req.params.id) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch('/tickets/:id/review', requireSupportEmailAccess, async (req, res) => {
    try {
      const ticket = await dashboard.reviewTicket(req.params.id, req.admin, req.body || {});
      return res.json({ success: true, ticket });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/jobs', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, ...(await dashboard.listJobs(req.query)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/jobs/:id/retry', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, job: await dashboard.retryJob(req.params.id, req.admin) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/health', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, health: await dashboard.health() });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/graph-authentication', requireSuperAdmin, async (req, res) => {
    const graph = await checkGraphAuthentication();
    try {
      await dashboard.recordGraphDiagnostic(req.admin, graph);
    } catch (error) {
      // Recording the result is best effort; the diagnostic itself still succeeded or failed.
    }
    return res.json({ success: true, graph });
  });

  router.get('/ingestion-policy', requireSupportEmailAccess, async (req, res) => {
    try {
      return res.json({ success: true, policy: await ingestionPolicy.getPolicy() });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/ingestion-policy', requireSuperAdmin, async (req, res) => {
    try {
      const policy = await ingestionPolicy.createPolicy(req.admin, req.body || {});
      return res.status(201).json({ success: true, policy });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch('/ingestion-policy', requireSuperAdmin, async (req, res) => {
    try {
      const policy = await ingestionPolicy.updatePolicy(req.admin, req.body || {});
      return res.json({ success: true, policy });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/single-email-test/readiness', requireSuperAdmin, async (req, res) => {
    try {
      return res.json({ success: true, readiness: await singleEmailTest.readiness() });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/single-email-test', requireSuperAdmin, async (req, res) => {
    try {
      const result = await singleEmailTest.runSingleEmailTest({
        graphMessageId: req.body && req.body.graphMessageId,
        admin: req.admin
      });
      return res.json({ success: true, result });
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      return res.status(status).json({
        success: false,
        message: error && error.code ? error.code : 'request_failed',
        readiness: error && error.readiness ? error.readiness : undefined,
        ticketId: error && error.ticketId ? error.ticketId : undefined
      });
    }
  });

  router.get('/attachments/:id', requireSupportEmailAccess, async (req, res) => {
    try {
      const file = await dashboard.openAttachment(req.params.id);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${String(file.name).replace(/"/g, '')}"`);
      file.stream.on('error', () => {
        if (!res.headersSent) res.status(404).json({ success: false, message: 'attachment_not_found' });
        else res.destroy();
      });
      file.stream.pipe(res);
      return undefined;
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = createSupportEmailAdminRouter();
module.exports.createSupportEmailAdminRouter = createSupportEmailAdminRouter;
