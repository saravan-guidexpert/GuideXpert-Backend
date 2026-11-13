'use strict';

const {
  createExample,
  listExamples,
  getExample,
  updateExample,
  approveExample,
  revokeExampleApproval,
  archiveExample,
  reactivateExample,
  sendExampleError,
} = require('../services/answerStudio/exampleService');

async function create(req, res) {
  try {
    const data = await createExample(req.body, req.admin);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function list(req, res) {
  try {
    const result = await listExamples(req.query);
    return res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function getOne(req, res) {
  try {
    const data = await getExample(req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function update(req, res) {
  try {
    const data = await updateExample(req.params.id, req.body, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function approve(req, res) {
  try {
    const data = await approveExample(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function revokeApproval(req, res) {
  try {
    const data = await revokeExampleApproval(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function archive(req, res) {
  try {
    const data = await archiveExample(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

async function reactivate(req, res) {
  try {
    const data = await reactivateExample(req.params.id, req.admin);
    return res.json({ success: true, data });
  } catch (error) {
    return sendExampleError(res, error);
  }
}

module.exports = {
  create,
  list,
  getOne,
  update,
  approve,
  revokeApproval,
  archive,
  reactivate,
};
