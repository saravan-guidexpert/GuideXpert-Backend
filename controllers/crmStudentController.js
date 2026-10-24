const { CrmError } = require('../utils/crmError');
const { bodyObject } = require('../utils/crmHttp');
const studentService = require('../services/crm/studentService');
const referralService = require('../services/crm/referralService');
const analyticsService = require('../services/crm/analyticsService');

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

exports.listStudents = async (req, res) => {
  try {
    const data = await studentService.listStudents(req.query || {}, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list students');
  }
};

exports.createStudent = async (req, res) => {
  try {
    const created = await studentService.createStudent(actorId(req), bodyObject(req.body), req);
    const data = { student: created.student };
    if (created.referral) data.referral = created.referral;
    const message = created.referral ? 'Student and referral created.' : 'Student created.';
    return send(res, 201, { success: true, message, data });
  } catch (err) {
    return handle(res, err, '[crm] create student');
  }
};

exports.getStudent = async (req, res) => {
  try {
    const student = await studentService.getStudent(req.params.id, actorId(req));
    return send(res, 200, { success: true, data: { student } });
  } catch (err) {
    return handle(res, err, '[crm] get student');
  }
};

exports.updateStudent = async (req, res) => {
  try {
    const student = await studentService.updateStudent(actorId(req), req.params.id, bodyObject(req.body), req);
    return send(res, 200, { success: true, message: 'Student updated.', data: { student } });
  } catch (err) {
    return handle(res, err, '[crm] update student');
  }
};

exports.getStudentReferral = async (req, res) => {
  try {
    const data = await referralService.getStudentReferral(req.params.id, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] get student referral');
  }
};

exports.getAnalytics = async (req, res) => {
  try {
    const data = await analyticsService.getAnalytics(req.query || {}, new Date(), actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] analytics');
  }
};

exports.getCalendar = async (req, res) => {
  try {
    const data = await analyticsService.getCalendar(req.query || {}, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] calendar');
  }
};

exports.listReferrals = async (req, res) => {
  try {
    const data = await referralService.listReferrals(req.query || {}, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list referrals');
  }
};

exports.createReferral = async (req, res) => {
  try {
    const referral = await referralService.createReferral(actorId(req), bodyObject(req.body), req);
    return send(res, 201, { success: true, message: 'Referral recorded.', data: { referral } });
  } catch (err) {
    return handle(res, err, '[crm] create referral');
  }
};

exports.rejectReferralMutation = (req, res) => {
  try {
    referralService.assertNoGenericSourceWrite();
    return send(res, 500, { success: false, message: 'Something went wrong.' });
  } catch (err) {
    return handle(res, err, '[crm] reject referral mutation');
  }
};

exports.correctReferralSource = async (req, res) => {
  try {
    const referral = await referralService.correctReferralSource(actorId(req), req.params.id, bodyObject(req.body), req);
    return send(res, 200, { success: true, message: 'Referral source corrected.', data: { referral } });
  } catch (err) {
    return handle(res, err, '[crm] correct referral source');
  }
};

exports.listAudits = async (req, res) => {
  try {
    const auditService = require('../services/crm/auditService');
    const data = await auditService.listAudits(req.query || {}, actorId(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list audits');
  }
};

function activityActor(req) {
  if (req.crmUser) {
    return {
      _id: req.crmUser._id,
      actorType: 'crm-user',
      permissions: Array.isArray(req.crmUser.permissions) ? req.crmUser.permissions : [],
    };
  }
  return {
    _id: req.admin._id,
    actorType: 'admin',
    isSuperAdmin: req.admin.isSuperAdmin === true,
    sectionAccess: Array.isArray(req.admin.sectionAccess) ? req.admin.sectionAccess : [],
  };
}

exports.listActivity = async (req, res) => {
  try {
    const activityService = require('../services/crm/activityService');
    const data = await activityService.listActivity(req.query || {}, activityActor(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] list activity');
  }
};

exports.getActivity = async (req, res) => {
  try {
    const activityService = require('../services/crm/activityService');
    const event = await activityService.getActivity(req.params.source, req.params.id, activityActor(req));
    return send(res, 200, { success: true, data: { event } });
  } catch (err) {
    return handle(res, err, '[crm] get activity');
  }
};

exports.activitySummary = async (req, res) => {
  try {
    const activityService = require('../services/crm/activityService');
    const data = await activityService.summarizeActivity(req.query || {}, activityActor(req));
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] activity summary');
  }
};

exports.operations = async (req, res) => {
  try {
    const operations = require('../services/crm/crmOperations');
    const data = await operations.getOperations(activityActor(req), req.query || {}, new Date());
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] operations');
  }
};

exports.consultancyOverview = async (req, res) => {
  try {
    const operations = require('../services/crm/crmOperations');
    const data = await operations.listConsultancyOverview(activityActor(req), req.query || {});
    return send(res, 200, { success: true, data });
  } catch (err) {
    return handle(res, err, '[crm] consultancy overview');
  }
};
