'use strict';

process.env.NODE_ENV = 'test';
process.env.OTP_SECRET = 'jee-result-test-secret';
process.env.JEE_RESULTS_SKIP_IMPORT = '1';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const jeeMainMockTestRoutes = require('../routes/jeeMainMockTestRoutes');
const { setJeeResultOtpSenderForTests } = require('../services/jeeMockTestResults/access');
const JeeMainMockTestLead = require('../models/JeeMainMockTestLead');
const JeeMockTestResult = require('../models/JeeMockTestResult');
const JeeMockTestResultSession = require('../models/JeeMockTestResultSession');
const OtpVerification = require('../models/OtpVerification');

let mongo;
let server;
let baseUrl;
const sent = [];

function storeCookies(response, jar) {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  lines.forEach((line) => {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index === -1) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value || /Max-Age=0/i.test(line)) delete jar[name];
    else jar[name] = decodeURIComponent(value);
  });
  return lines.join('\n');
}

async function request(method, urlPath, { jar, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar && Object.keys(jar).length) {
    headers.Cookie = Object.entries(jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
  }
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  const cache = response.headers.get('cache-control') || '';
  const payload = type.includes('application/pdf') ? Buffer.from(await response.arrayBuffer()) : await response.json();
  const setCookie = jar ? storeCookies(response, jar) : '';
  return { status: response.status, payload, cache, setCookie, type };
}

async function verifyMobile(mobile) {
  const jar = {};
  const requested = await request('POST', '/api/jee-main-mock-test/results/request-otp', {
    jar,
    body: { mobile },
  });
  const code = sent[sent.length - 1];
  const verified = await request('POST', '/api/jee-main-mock-test/results/verify-otp', {
    jar,
    body: { otp: code && code.otp },
  });
  return { jar, requested, verified };
}

describe('JEE mock test result access', { timeout: 180000, concurrency: 1 }, () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'jee_results_test' });
    setJeeResultOtpSenderForTests(async (phone, otp) => {
      sent.push({ phone, otp });
      return { success: true };
    });
    const app = express();
    app.use(express.json());
    app.use('/api/jee-main-mock-test', jeeMainMockTestRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    setJeeResultOtpSenderForTests(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    sent.length = 0;
    await Promise.all([
      JeeMainMockTestLead.deleteMany({}),
      JeeMockTestResult.deleteMany({}),
      JeeMockTestResultSession.deleteMany({}),
      OtpVerification.deleteMany({}),
    ]);
  });

  test('unknown mobiles do not receive an OTP', async () => {
    const response = await request('POST', '/api/jee-main-mock-test/results/request-otp', {
      body: { mobile: '9000000099' },
    });
    assert.equal(response.status, 404);
    assert.equal(response.payload.code, 'NOT_REGISTERED');
    assert.equal(sent.length, 0);
    assert.match(response.cache, /no-store/);
  });

  test('incomplete registration is blocked after OTP and cannot open a result', async () => {
    await JeeMainMockTestLead.create({
      studentName: 'Incomplete Student',
      mobileNumber: '9000000003',
      formCompleted: false,
    });
    await JeeMockTestResult.create({
      name: 'Should Stay Hidden',
      mobile: '9000000003',
      email: 'hidden@example.com',
      invitedOn: new Date('2026-11-08T05:14:00.000Z'),
      attemptStatus: 'ATTEMPTED',
      overallTotalScore: 300,
      overallCandidateScore: 230,
      overallDuration: 180,
      overallCandidateDuration: 20,
      mcqMaxScore: 240,
      mcqUserScore: 230,
      mcqAttemptDuration: 20,
      numericalMaxScore: 60,
      numericalUserScore: 0,
      numericalAttemptDuration: 0,
    });

    const { jar, verified } = await verifyMobile('9000000003');
    assert.equal(verified.status, 200);
    assert.equal(verified.payload.eligible, false);
    assert.equal(verified.payload.eligibility, 'FORM_INCOMPLETE');
    assert.equal(JSON.stringify(verified.payload).includes('230'), false);
    assert.equal(JSON.stringify(verified.payload).includes('Should Stay Hidden'), false);
    assert.equal(jar.gx_jee_result_sid, undefined);

    const me = await request('GET', '/api/jee-main-mock-test/results/me', { jar });
    assert.equal(me.status, 401);
    assert.equal(me.payload.code, 'SESSION_REQUIRED');
  });

  test('attempted students get the saved score and a PDF, including negatives and blanks', async () => {
    await JeeMainMockTestLead.create({
      studentName: 'Attempted Student',
      mobileNumber: '9000000001',
      formCompleted: true,
      currentStep: 2,
    });
    await JeeMockTestResult.create({
      name: 'Attempted Student',
      mobile: '9000000001',
      email: 'secret@example.com',
      invitedOn: new Date('2026-11-08T05:14:00.000Z'),
      attemptStatus: 'ATTEMPTED',
      overallTotalScore: 300,
      overallCandidateScore: -5,
      overallDuration: 180,
      overallCandidateDuration: 34.93,
      mcqMaxScore: 240,
      mcqUserScore: -5,
      mcqAttemptDuration: 24.8,
      numericalMaxScore: 60,
      numericalUserScore: 0,
      numericalAttemptDuration: null,
    });

    const { jar, requested, verified } = await verifyMobile('9000000001');
    assert.equal(requested.payload.maskedMobile, '******0001');
    assert.equal(requested.payload.mobile, undefined);
    assert.equal(verified.payload.eligible, true);
    assert.equal(verified.payload.result, undefined);
    assert.ok(jar.gx_jee_result_sid);
    assert.equal(jar.gx_jee_result_pending, undefined);

    const me = await request('GET', '/api/jee-main-mock-test/results/me', { jar });
    assert.equal(me.status, 200);
    assert.equal(me.payload.result.eligibility, 'REGISTERED_ATTEMPTED');
    assert.equal(me.payload.result.overall.obtained, -5);
    assert.equal(me.payload.result.overall.percentage, -1.67);
    assert.equal(me.payload.result.numerical.obtained, 0);
    assert.equal(me.payload.result.numerical.durationMinutes, null);
    const serialized = JSON.stringify(me.payload);
    assert.equal(serialized.includes('secret@example.com'), false);
    assert.equal(serialized.includes('9000000001'), false);
    assert.equal(serialized.includes('percentile'), false);
    assert.equal(serialized.includes('rank'), false);

    const pdf = await request('GET', '/api/jee-main-mock-test/results/pdf', { jar });
    assert.equal(pdf.status, 200);
    assert.match(pdf.type, /application\/pdf/);
    assert.equal(pdf.payload.subarray(0, 4).toString(), '%PDF');
    assert.match(pdf.cache, /no-store/);

    const loggedOut = await request('POST', '/api/jee-main-mock-test/results/logout', { jar });
    assert.equal(loggedOut.status, 200);
    assert.equal(jar.gx_jee_result_sid, undefined);
    const after = await request('GET', '/api/jee-main-mock-test/results/me', { jar });
    assert.equal(after.status, 401);
    assert.equal(after.payload.code, 'SESSION_REQUIRED');
  });

  test('registered students who did not attempt get confirmation data and no PDF', async () => {
    await JeeMainMockTestLead.create({
      studentName: 'Registered Student',
      mobileNumber: '9000000002',
      formCompleted: true,
    });
    await JeeMockTestResult.create({
      name: 'Registered Student',
      mobile: '9000000002',
      email: 'registered@example.com',
      invitedOn: new Date('2026-11-08T06:47:00.000Z'),
      attemptStatus: 'NOT_ATTEMPTED',
      overallTotalScore: 300,
      overallCandidateScore: null,
      overallDuration: 180,
      overallCandidateDuration: null,
      mcqMaxScore: 240,
      mcqUserScore: null,
      mcqAttemptDuration: null,
      numericalMaxScore: 60,
      numericalUserScore: null,
      numericalAttemptDuration: null,
    });

    const { jar } = await verifyMobile('9000000002');
    const me = await request('GET', '/api/jee-main-mock-test/results/me', { jar });
    assert.equal(me.payload.result.eligibility, 'REGISTERED_NOT_ATTEMPTED');
    assert.equal(me.payload.result.attemptStatus, 'NOT_ATTEMPTED');
    assert.equal(me.payload.result.overall, undefined);
    assert.equal(JSON.stringify(me.payload).includes('registered@example.com'), false);

    const pdf = await request('GET', '/api/jee-main-mock-test/results/pdf', { jar });
    assert.equal(pdf.status, 403);
    assert.equal(pdf.payload.code, 'PDF_UNAVAILABLE');
  });

  test('a completed registration with no exam row is pending, and an expired session is rejected', async () => {
    await JeeMainMockTestLead.create({
      studentName: 'Pending Student',
      mobileNumber: '9000000004',
      formCompleted: true,
    });
    const { jar } = await verifyMobile('9000000004');
    const me = await request('GET', '/api/jee-main-mock-test/results/me', { jar });
    assert.equal(me.payload.result.eligibility, 'RESULT_PENDING');
    assert.equal(me.payload.result.overall, undefined);

    await JeeMockTestResultSession.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request('GET', '/api/jee-main-mock-test/results/me', { jar });
    assert.equal(expired.status, 401);
    assert.equal(expired.payload.code, 'SESSION_EXPIRED');

    const direct = await request('GET', '/api/jee-main-mock-test/results/me');
    assert.equal(direct.payload.code, 'SESSION_REQUIRED');
  });
});
