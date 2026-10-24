const { CrmError } = require('../utils/crmError');
const { bodyObject } = require('../utils/crmHttp');
const consultancyService = require('../services/crm/consultancyService');

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

exports.listConsultancies = async (req, res) => {
  try {
    const data = await consultancyService.listConsultancies(req.query || {});
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
    const consultancy = await consultancyService.getConsultancy(req.params.id);
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
    const data = await consultancyService.listContacts(req.params.id, req.query || {});
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
