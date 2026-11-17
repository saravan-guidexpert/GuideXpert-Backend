'use strict';

const access = require('../services/jeeMockTestResults/access');
const { recordJeeResultActivity, listJeeResultActivity } = require('../services/jeeMockTestResults/activity');
const { buildResultPdf } = require('../services/jeeMockTestResults/pdf');
const {
  pendingMobileFromRequest,
  sessionTokenFromRequest,
  setPendingCookie,
  clearPendingCookie,
  setSessionCookie,
  clearSessionCookie,
} = require('../services/jeeMockTestResults/cookies');

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Vary', 'Cookie');
}

async function requestOtp(req, res) {
  noStore(res);
  const result = await access.requestOtp(req.body && req.body.mobile);
  if (result.pendingToken) setPendingCookie(res, result.pendingToken);
  return res.status(result.status).json(result.body);
}

async function pending(req, res) {
  noStore(res);
  const result = await access.pendingStatus(pendingMobileFromRequest(req));
  return res.status(result.status).json(result.body);
}

async function resendOtp(req, res) {
  noStore(res);
  const mobile = pendingMobileFromRequest(req);
  if (!mobile) {
    return res.status(401).json({
      success: false,
      code: 'PENDING_REQUIRED',
      message: 'Enter your mobile number to continue.',
    });
  }
  const result = await access.requestOtp(mobile);
  if (result.pendingToken) setPendingCookie(res, result.pendingToken);
  return res.status(result.status).json(result.body);
}

async function cancel(req, res) {
  noStore(res);
  clearPendingCookie(res);
  return res.status(200).json({ success: true });
}

async function verifyOtp(req, res) {
  noStore(res);
  const result = await access.verifyOtp(pendingMobileFromRequest(req), req.body && req.body.otp);
  if (result.clearPending) clearPendingCookie(res);
  if (result.sessionToken) setSessionCookie(res, result.sessionToken);
  return res.status(result.status).json(result.body);
}

async function remember(result, kind) {
  const pub = result && result.body && result.body.result;
  if (!result || !result.ok || !pub || !result.mobile) return;
  try {
    await recordJeeResultActivity({
      mobile: result.mobile,
      studentName: pub.studentName,
      eligibility: pub.eligibility,
      attemptStatus: pub.attemptStatus,
      overall: pub.overall,
      kind,
    });
  } catch (error) {
    console.error('[jee-results] activity', error && error.message ? error.message : error);
  }
}

async function me(req, res) {
  noStore(res);
  const result = await access.currentResult(sessionTokenFromRequest(req));
  await remember(result, 'view');
  return res.status(result.status).json(result.body);
}

async function pdf(req, res) {
  noStore(res);
  const result = await access.resultPdf(sessionTokenFromRequest(req));
  if (!result.ok) return res.status(result.status).json(result.body);
  await remember(result, 'pdf');
  const file = buildResultPdf(result.result);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="JEE-Main-Mock-Test-Result.pdf"');
  return res.status(200).send(file);
}

async function activity(req, res) {
  const data = await listJeeResultActivity({
    q: req.query.q,
    status: req.query.status,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.status(200).json({ success: true, ...data });
}

async function logout(req, res) {
  noStore(res);
  const result = await access.logout(sessionTokenFromRequest(req));
  clearSessionCookie(res);
  return res.status(result.status).json(result.body);
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error('[jee-results]', error && error.message ? error.message : error);
      if (res.headersSent) return;
      noStore(res);
      res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
  };
}

module.exports = {
  requestOtp: wrap(requestOtp),
  pending: wrap(pending),
  resendOtp: wrap(resendOtp),
  cancel: wrap(cancel),
  verifyOtp: wrap(verifyOtp),
  me: wrap(me),
  pdf: wrap(pdf),
  logout: wrap(logout),
  activity: wrap(activity),
};
