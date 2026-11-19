'use strict';

const express = require('express');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requireAdminSection = require('../middleware/requireAdminSection');
const { QUORA_REDDIT_PROMPT_SECTION_KEY } = require('../services/answerStudio/constants');
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

const requirePromptSection = requireAdminSection(
  QUORA_REDDIT_PROMPT_SECTION_KEY,
  'Quora and Reddit system prompt access is required.'
);

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

router.get('/prompts', requirePromptSection, promptController.list);
router.post('/prompts', requirePromptSection, promptController.create);
router.post('/prompts/:id/versions', requirePromptSection, promptController.createVersion);
router.post('/prompts/:id/activate', requirePromptSection, promptController.activate);
router.post('/prompts/:id/deactivate', requirePromptSection, promptController.deactivate);
router.get('/prompts/:id', requirePromptSection, promptController.getOne);
router.use('/prompts', requirePromptSection, managementNotImplemented('prompts'));

module.exports = router;
