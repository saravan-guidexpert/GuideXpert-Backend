const { CrmError } = require('../utils/crmError');
const { bodyObject, requestMeta } = require('../utils/crmHttp');
const consultancyService = require('../services/crm/consultancyService');
const workspace = require('../services/crm/consultancyWorkspace');
const { CRM_ACCESS_SECTION } = require('../constants/crmUsers');

function send(res, status, body) {
  return res.status(status).json(body);
}

function handle(res, err, label) {
  if (err instanceof CrmError) {
    return send(res, err.status, {
      success: false,
      message: err.message,
      code: err.code,
      data: err.data ?? null,
    });
  }
  console.error(label, err && err.message ? err.message : 'error');
  return send(res, 500, { success: false, message: 'Something went wrong.' });
}

function actorId(req) {
  if (req.crmUser) return { _id: req.crmUser._id, actorType: 'crm-user' };
  return req.admin._id;
}

function workspaceActor(req) {
  if (req.crmUser) {
    return {
      _id: req.crmUser._id,
      actorType: 'crm-user',
      name: req.crmUser.fullName || 'CRM user',
    };
  }
  return {
    _id: req.admin._id,
    actorType: 'admin',
    name: req.admin.name || 'Platform admin',
  };
}

function reassignActor(req) {
  if (req.crmUser) {
    const permissions = Array.isArray(req.crmUser.permissions) ? req.crmUser.permissions : [];
    return {
      kind: 'crm-user',
      id: req.crmUser._id,
      actorType: 'crm-user',
      name: req.crmUser.fullName || 'CRM user',
      canManageAccess: permissions.includes('crm.roles.manage'),
    };
  }
  const sections = Array.isArray(req.admin.sectionAccess) ? req.admin.sectionAccess : [];
  return {
    kind: 'admin',
    id: req.admin._id,
    actorType: 'admin',
    name: req.admin.name || 'Platform admin',
    canManageAccess: Boolean(req.admin.isSuperAdmin) || sections.includes(CRM_ACCESS_SECTION),
  };
}

exports.listConsultancies = async (req, res) => {
  try {
    const data = await consultancyService.listConsultancies(req.query || {}, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list consultancies');
  }
};

exports.createConsultancy = async (req, res) => {
  try {
    const consultancy = await consultancyService.createConsultancy(actorId(req), bodyObject(req.body), req);
    return send(res, 201, { success: true, message: 'Consultancy created.', data: { consultancy } });
  } catch (err) {
    return handle(res, err, '[crm] create consultancy');
  }
};

exports.getConsultancy = async (req, res) => {
  try {
    const consultancy = await consultancyService.getConsultancy(req.params.id, actorId(req));
    return send(res, 200, { success: true, data: { consultancy } });
  } catch (err) {
    return handle(res, err, '[crm] get consultancy');
  }
};

exports.updateConsultancy = async (req, res) => {
  try {
    const consultancy = await consultancyService.updateConsultancy(actorId(req), req.params.id, bodyObject(req.body), req);
    return send(res, 200, { success: true, message: 'Consultancy updated.', data: { consultancy } });
  } catch (err) {
    return handle(res, err, '[crm] update consultancy');
  }
};

exports.listContacts = async (req, res) => {
  try {
    const data = await consultancyService.listContacts(req.params.id, req.query || {}, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list contacts');
  }
};

exports.createContact = async (req, res) => {
  try {
    const contact = await consultancyService.createContact(actorId(req), req.params.id, bodyObject(req.body), req);
    return send(res, 201, { success: true, message: 'Contact created.', data: { contact } });
  } catch (err) {
    return handle(res, err, '[crm] create contact');
  }
};

exports.updateContact = async (req, res) => {
  try {
    const contact = await consultancyService.updateContact(
      actorId(req),
      req.params.id,
      req.params.contactId,
      bodyObject(req.body),
      req
    );
    return send(res, 200, { success: true, message: 'Contact updated.', data: { contact } });
  } catch (err) {
    return handle(res, err, '[crm] update contact');
  }
};

exports.listRemarks = async (req, res) => {
  try {
    const data = await workspace.listRemarks(req.params.id, req.query || {}, workspaceActor(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list remarks');
  }
};

exports.addRemark = async (req, res) => {
  try {
    const data = await workspace.addRemark(workspaceActor(req), req.params.id, bodyObject(req.body), requestMeta(req));
    return send(res, 201, { success: true, message: 'Remark saved.', data });
  } catch (err) {
    return handle(res, err, '[crm] add remark');
  }
};

exports.editRemark = async (req, res) => {
  try {
    const data = await workspace.editRemark(workspaceActor(req), req.params.id, req.params.remarkId, bodyObject(req.body), requestMeta(req));
    return send(res, 200, { success: true, message: 'Remark updated.', data });
  } catch (err) {
    return handle(res, err, '[crm] edit remark');
  }
};

exports.listFollowUps = async (req, res) => {
  try {
    const data = await workspace.listFollowUps(req.params.id, req.query || {}, workspaceActor(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list follow-ups');
  }
};

exports.recordFollowUp = async (req, res) => {
  try {
    const data = await workspace.recordFollowUp(workspaceActor(req), req.params.id, bodyObject(req.body), requestMeta(req));
    const message = data.followUp ? 'Consultancy status saved.' : 'Calling status saved.';
    return send(res, 200, { success: true, message, data });
  } catch (err) {
    return handle(res, err, '[crm] record follow-up');
  }
};

exports.updateFollowUp = async (req, res) => {
  try {
    const data = await workspace.updateFollowUp(workspaceActor(req), req.params.id, req.params.followUpId, bodyObject(req.body), requestMeta(req));
    return send(res, 200, { success: true, message: 'Follow-up updated.', data });
  } catch (err) {
    return handle(res, err, '[crm] update follow-up');
  }
};

exports.completeFollowUp = async (req, res) => {
  try {
    const data = await workspace.completeFollowUp(workspaceActor(req), req.params.id, req.params.followUpId, requestMeta(req));
    return send(res, 200, { success: true, message: 'Follow-up completed.', data });
  } catch (err) {
    return handle(res, err, '[crm] complete follow-up');
  }
};

exports.cancelFollowUp = async (req, res) => {
  try {
    const data = await workspace.cancelFollowUp(workspaceActor(req), req.params.id, req.params.followUpId, requestMeta(req));
    return send(res, 200, { success: true, message: data.followUp.cancelledAt ? 'Follow-up cancelled.' : 'Follow-up updated.', data });
  } catch (err) {
    return handle(res, err, '[crm] cancel follow-up');
  }
};

exports.reassignOwner = async (req, res) => {
  try {
    const data = await workspace.reassignOwner(reassignActor(req), req.params.id, bodyObject(req.body), req);
    const message = data.unchanged
      ? 'This consultancy already has that owner.'
      : 'Owner updated. The creator is unchanged.';
    return send(res, 200, { success: true, message, data: { consultancy: data.consultancy } });
  } catch (err) {
    return handle(res, err, '[crm] reassign owner');
  }
};

exports.retainConsultancy = (req, res) => {
  return send(res, 405, {
    success: false,
    message: 'Consultancies are not deleted. Set status to inactive. Referral history is retained.',
    code: 'method_not_allowed',
  });
};

exports.deactivateContact = async (req, res) => {
  try {
    const contact = await consultancyService.deactivateContact(actorId(req), req.params.id, req.params.contactId, req);
    return send(res, 200, { success: true, message: 'Contact deactivated.', data: { contact } });
  } catch (err) {
    return handle(res, err, '[crm] deactivate contact');
  }
};
