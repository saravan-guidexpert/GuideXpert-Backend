'use strict';

const express = require('express');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const {
  getModuleStatus,
  managementNotImplemented,
} = require('../controllers/answerStudioController');
const knowledgeController = require('../controllers/answerStudioKnowledgeController');

const router = express.Router();

router.get('/status', getModuleStatus);

function superAdminManagement(scope) {
  const gate = express.Router({ mergeParams: true });
  gate.use(requireSuperAdmin);
  gate.use(managementNotImplemented(scope));
  return gate;
}

router.post('/knowledge', requireSuperAdmin, knowledgeController.create);
router.get('/knowledge', requireSuperAdmin, knowledgeController.list);
router.get('/knowledge/:id', requireSuperAdmin, knowledgeController.getOne);
router.patch('/knowledge/:id', requireSuperAdmin, knowledgeController.update);
router.delete('/knowledge/:id', requireSuperAdmin, knowledgeController.deactivate);

router.use('/examples', superAdminManagement('examples'));
router.use('/prompts', superAdminManagement('prompts'));

module.exports = router;
