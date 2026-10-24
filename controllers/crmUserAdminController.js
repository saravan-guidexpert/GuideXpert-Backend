'use strict';

const { CrmError } = require('../utils/crmError');
const users = require('../services/crm/crmUserAdminService');

function actorOf(req) {
  if (req.admin) return { kind: 'admin', id: req.admin._id };
  if (req.crmUser) {
    return {
      kind: 'crm-user',
      id: req.crmUser._id,
      role: req.crmUser.role,
      permissions: Array.isArray(req.crmUser.permissions) ? req.crmUser.permissions : [],
    };
  }
  throw new CrmError(401, 'Authentication required', 'authentication_required');
}

function send(res, status, body) {
  return res.status(status).json(body);
}

function fail(res, err, label) {
  if (err instanceof CrmError) {
    return send(res, err.status, { success: false, message: err.message, code: err.code });
  }
  console.error(label, err && err.message ? err.message : 'error');
  return send(res, 500, { success: false, message: 'Something went wrong.' });
}

exports.summary = async (req, res) => {
  try {
    const data = await users.summary();
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] summary');
  }
};

exports.list = async (req, res) => {
  try {
    const data = await users.listUsers(req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] list');
  }
};

exports.getOne = async (req, res) => {
  try {
    const user = await users.getUser(req.params.id);
    return send(res, 200, { success: true, data: { user } });
  } catch (err) {
    return fail(res, err, '[crm-users] get');
  }
};

exports.create = async (req, res) => {
  try {
    const data = await users.createUser(actorOf(req), req.body || {}, req);
    return send(res, 201, { success: true, message: 'CRM account created.', data });
  } catch (err) {
    return fail(res, err, '[crm-users] create');
  }
};

exports.update = async (req, res) => {
  try {
    const data = await users.updateUser(actorOf(req), req.params.id, req.body || {}, req);
    return send(res, 200, { success: true, message: 'CRM account updated.', data });
  } catch (err) {
    return fail(res, err, '[crm-users] update');
  }
};

exports.activate = async (req, res) => {
  try {
    const data = await users.setStatus(actorOf(req), req.params.id, 'active', req, req.body && req.body.reason);
    return send(res, 200, { success: true, message: 'CRM account activated.', data });
  } catch (err) {
    return fail(res, err, '[crm-users] activate');
  }
};

exports.deactivate = async (req, res) => {
  try {
    const data = await users.setStatus(actorOf(req), req.params.id, 'inactive', req, req.body && req.body.reason);
    return send(res, 200, { success: true, message: 'CRM account deactivated.', data });
  } catch (err) {
    return fail(res, err, '[crm-users] deactivate');
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const data = await users.resetPassword(actorOf(req), req.params.id, req.body || {}, req);
    const message = data.delivery === 'admin_display'
      ? 'Reset code created. Email delivery is not configured.'
      : 'Password updated.';
    return send(res, 200, { success: true, message, data });
  } catch (err) {
    return fail(res, err, '[crm-users] reset');
  }
};

exports.audit = async (req, res) => {
  try {
    const data = await users.listUserAudit(req.params.id, req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] audit');
  }
};
