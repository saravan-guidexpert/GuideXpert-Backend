'use strict';

const MANAGEMENT_SCOPES = new Set(['knowledge', 'examples', 'prompts']);

function getModuleStatus(req, res) {
  const isSuperAdmin = req.admin?.isSuperAdmin === true;
  return res.json({
    success: true,
    module: 'answer-studio',
    phase: 1,
    permissions: {
      module: true,
      knowledge: isSuperAdmin,
      examples: isSuperAdmin,
      exampleApproval: isSuperAdmin,
      prompts: isSuperAdmin,
      generations: true,
    },
  });
}

function managementNotImplemented(scope) {
  if (!MANAGEMENT_SCOPES.has(scope)) {
    throw new Error(`Unknown Answer Studio management scope: ${scope}`);
  }
  return function answerStudioManagementGate(_req, res) {
    return res.status(501).json({
      success: false,
      implemented: false,
      scope,
      message: 'Answer Studio management is not available in this phase.',
    });
  };
}

module.exports = {
  getModuleStatus,
  managementNotImplemented,
};
