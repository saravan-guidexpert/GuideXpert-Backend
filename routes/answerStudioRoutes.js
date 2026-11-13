'use strict';

const express = require('express');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const {
  getModuleStatus,
  managementNotImplemented,
} = require('../controllers/answerStudioController');
const knowledgeController = require('../controllers/answerStudioKnowledgeController');
const exampleController = require('../controllers/answerStudioExampleController');
const generationController = require('../controllers/answerStudioGenerationController');
const promptController = require('../controllers/answerStudioPromptController');

const router = express.Router();

router.get('/status', getModuleStatus);
router.post('/generate', generationController.generate);

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

router.post('/examples', requireSuperAdmin, exampleController.create);
router.get('/examples', requireSuperAdmin, exampleController.list);
router.get('/examples/:id', requireSuperAdmin, exampleController.getOne);
router.patch('/examples/:id', requireSuperAdmin, exampleController.update);
router.post('/examples/:id/approve', requireSuperAdmin, exampleController.approve);
router.post('/examples/:id/revoke-approval', requireSuperAdmin, exampleController.revokeApproval);
router.post('/examples/:id/archive', requireSuperAdmin, exampleController.archive);
router.post('/examples/:id/reactivate', requireSuperAdmin, exampleController.reactivate);

router.get('/prompts', requireSuperAdmin, promptController.list);
router.post('/prompts', requireSuperAdmin, promptController.create);
router.post('/prompts/:id/versions', requireSuperAdmin, promptController.createVersion);
router.post('/prompts/:id/activate', requireSuperAdmin, promptController.activate);
router.post('/prompts/:id/deactivate', requireSuperAdmin, promptController.deactivate);
router.get('/prompts/:id', requireSuperAdmin, promptController.getOne);
router.use('/prompts', superAdminManagement('prompts'));

module.exports = router;
