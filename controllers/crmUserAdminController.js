'use strict';

const { CrmError } = require('../utils/crmError');
const users = require('../services/crm/crmUserAdminService');
const assignments = require('../services/crm/crmAssignmentService');
const presence = require('../services/crm/crmPresence');
const directory = require('../services/crm/crmDirectory');

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

exports.listAssignments = async (req, res) => {
  try {
    const data = await assignments.listForUser(actorOf(req), req.params.id, req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] list assignments');
  }
};

exports.listConsultancyAssignees = async (req, res) => {
  try {
    const data = await assignments.listForConsultancy(actorOf(req), req.params.consultancyId, req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] list assignees');
  }
};

exports.assignConsultancy = async (req, res) => {
  try {
    const assignment = await assignments.assign(actorOf(req), req.params.id, req.body || {}, req);
    return send(res, 201, { success: true, message: 'Consultancy assigned.', data: { assignment } });
  } catch (err) {
    return fail(res, err, '[crm-users] assign consultancy');
  }
};

exports.revokeAssignment = async (req, res) => {
  try {
    const assignment = await assignments.revoke(actorOf(req), req.params.id, req.params.consultancyId, req);
    return send(res, 200, { success: true, message: 'Consultancy assignment revoked.', data: { assignment } });
  } catch (err) {
    return fail(res, err, '[crm-users] revoke assignment');
  }
};

exports.listPresence = async (req, res) => {
  try {
    const data = await presence.listPresence(actorOf(req), req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] presence');
  }
};

exports.directory = async (req, res) => {
  try {
    const data = await directory.listDirectory(actorOf(req), req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] directory');
  }
};

exports.listSessions = async (req, res) => {
  try {
    const data = await presence.listSessions(actorOf(req), req.params.id, req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return fail(res, err, '[crm-users] sessions');
  }
};

exports.revokeSession = async (req, res) => {
  try {
    const session = await presence.revokeOne(actorOf(req), req.params.id, req.params.sessionId, req);
    return send(res, 200, { success: true, message: 'Session revoked.', data: { session } });
  } catch (err) {
    return fail(res, err, '[crm-users] revoke session');
  }
};

exports.revokeAllSessions = async (req, res) => {
  try {
    const data = await presence.revokeAll(actorOf(req), req.params.id, req);
    return send(res, 200, { success: true, message: 'Sessions revoked.', data });
  } catch (err) {
    return fail(res, err, '[crm-users] revoke sessions');
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
