'use strict';

const {
  createPrompt,
  listPrompts,
  getPrompt,
  createPromptVersion,
  activatePromptVersion,
  deactivatePromptVersion,
  sendPromptError,
} = require('../services/answerStudio/promptService');

async function create(req, res) {
  try {
    const data = await createPrompt(req.body, req.admin);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendPromptError(res, error);
  }
}

async function list(req, res) {
  try {
    const result = await listPrompts(req.query);
    return res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    return sendPromptError(res, error);
  }
}

async function getOne(req, res) {
  try {
    const data = await getPrompt(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    return sendPromptError(res, error);
  }
}

async function createVersion(req, res) {
  try {
    const data = await createPromptVersion(req.params.id, req.body, req.admin);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendPromptError(res, error);
  }
}

async function activate(req, res) {
  try {
    const data = await activatePromptVersion(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendPromptError(res, error);
  }
}

async function deactivate(req, res) {
  try {
    const data = await deactivatePromptVersion(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendPromptError(res, error);
  }
}

module.exports = {
  create,
  list,
  getOne,
  createVersion,
  activate,
  deactivate,
};
