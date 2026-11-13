'use strict';

const {
  createKnowledge,
  listKnowledge,
  getKnowledge,
  updateKnowledge,
  deactivateKnowledge,
  sendKnowledgeError,
} = require('../services/answerStudio/knowledgeService');

async function create(req, res) {
  try {
    const data = await createKnowledge(req.body, req.admin);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendKnowledgeError(res, error);
  }
}

async function list(req, res) {
  try {
    const result = await listKnowledge(req.query);
    return res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    return sendKnowledgeError(res, error);
  }
}

async function getOne(req, res) {
  try {
    const data = await getKnowledge(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    return sendKnowledgeError(res, error);
  }
}

async function update(req, res) {
  try {
    const data = await updateKnowledge(req.params.id, req.body, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendKnowledgeError(res, error);
  }
}

async function deactivate(req, res) {
  try {
    const data = await deactivateKnowledge(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendKnowledgeError(res, error);
  }
}

module.exports = {
  create,
  list,
  getOne,
  update,
  deactivate,
};
