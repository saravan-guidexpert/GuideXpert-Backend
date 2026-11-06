'use strict';

const express = require('express');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const {
  getModuleStatus,
  managementNotImplemented,
} = require('../controllers/answerStudioController');

const router = express.Router();

router.get('/status', getModuleStatus);

function superAdminManagement(scope) {
  const gate = express.Router({ mergeParams: true });
  gate.use(requireSuperAdmin);
  gate.use(managementNotImplemented(scope));
  return gate;
}

// Mounted so later phases add handlers behind the same super-admin wall.
// These routes do not read or write Answer Studio collections.
router.use('/knowledge', superAdminManagement('knowledge'));
router.use('/examples', superAdminManagement('examples'));
router.use('/prompts', superAdminManagement('prompts'));

module.exports = router;
