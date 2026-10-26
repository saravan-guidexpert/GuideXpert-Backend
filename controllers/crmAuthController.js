'use strict';

const auth = require('../services/crm/crmAuthService');
const { CrmError } = require('../utils/crmError');

function send(res, result) {
  return res.status(result.status).json(result.body);
}

function fail(res, err) {
  if (err instanceof CrmError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  console.error('[crm-auth]', err && err.message ? err.message : 'error');
  return res.status(500).json({ success: false, message: 'Something went wrong.' });
}

exports.login = async (req, res) => {
  try {
    return send(res, await auth.login(req.body || {}, req, res));
  } catch (err) {
    return fail(res, err);
  }
};

exports.logout = async (req, res) => {
  try {
    return send(res, await auth.logout(req, res));
  } catch (err) {
    return fail(res, err);
  }
};

exports.me = (req, res) => {
  try {
    return send(res, auth.currentUser(req, res));
  } catch (err) {
    return fail(res, err);
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    return send(res, await auth.forgotPassword(req.body || {}, req));
  } catch (err) {
    return fail(res, err);
  }
};

exports.resetPassword = async (req, res) => {
  try {
    return send(res, await auth.resetPassword(req.body || {}, req));
  } catch (err) {
    return fail(res, err);
  }
};

exports.heartbeat = async (req, res) => {
  try {
    const presence = require('../services/crm/crmPresence');
    return send(res, await presence.heartbeat(req));
  } catch (err) {
    return fail(res, err);
  }
};

exports.presence = async (req, res) => {
  try {
    const presence = require('../services/crm/crmPresence');
    const data = await presence.ownPresence(req, req.query || {});
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return fail(res, err);
  }
};
