'use strict';

const fs = require('fs');
const path = require('path');
const JeeMockTestResult = require('../../models/JeeMockTestResult');
const JeeMainMockTestLead = require('../../models/JeeMainMockTestLead');
const { assertUniqueMobiles } = require('./parseSheet');

const DATA_PATH = path.join(__dirname, '../../data/jeeMockTestResults.json');
const SAMPLE_MOBILE = '9347763131';

function loadRows() {
  if (!fs.existsSync(DATA_PATH)) return [];
  const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('JEE mock test result file is empty');
  assertUniqueMobiles(rows);
  rows.forEach((row, index) => {
    if (!row || !/^[6-9]\d{9}$/.test(row.mobile)) {
      throw new Error(`Invalid result mobile at index ${index}`);
    }
    if (row.attemptStatus !== 'ATTEMPTED' && row.attemptStatus !== 'NOT_ATTEMPTED') {
      throw new Error(`Invalid attempt status at index ${index}`);
    }
  });
  return rows.map((row) => ({
    name: row.name,
    mobile: row.mobile,
    email: row.email || '',
    invitedOn: new Date(row.invitedOn),
    attemptStatus: row.attemptStatus,
    overallTotalScore: row.overallTotalScore,
    overallCandidateScore: row.overallCandidateScore,
    overallDuration: row.overallDuration,
    overallCandidateDuration: row.overallCandidateDuration,
    mcqMaxScore: row.mcqMaxScore,
    mcqUserScore: row.mcqUserScore,
    mcqAttemptDuration: row.mcqAttemptDuration,
    numericalMaxScore: row.numericalMaxScore,
    numericalUserScore: row.numericalUserScore,
    numericalAttemptDuration: row.numericalAttemptDuration,
  }));
}

async function ensureSampleRegistration(rows) {
  const sample = rows.find((row) => row.mobile === SAMPLE_MOBILE);
  if (!sample) return;
  await JeeMainMockTestLead.updateOne(
    { mobileNumber: SAMPLE_MOBILE },
    {
      $set: {
        formCompleted: true,
        currentStep: 2,
        otpVerified: true,
      },
      $setOnInsert: {
        studentName: sample.name,
        mobileNumber: SAMPLE_MOBILE,
        submittedAt: sample.invitedOn,
      },
    },
    { upsert: true }
  );
  const lead = await JeeMainMockTestLead.findOne({ mobileNumber: SAMPLE_MOBILE }).select('studentName').lean();
  const name = lead && lead.studentName ? lead.studentName : sample.name;
  await JeeMockTestResult.updateOne(
    { mobile: SAMPLE_MOBILE },
    { $set: { ...sample, name } },
    { upsert: true }
  );
}

async function ensureJeeMockTestResultsImported({ refresh = false } = {}) {
  if (process.env.JEE_RESULTS_SKIP_IMPORT === '1' && !refresh) {
    return { skipped: true };
  }
  let rows = [];
  try {
    rows = loadRows();
  } catch (error) {
    console.error('[jee-results] import file', error && error.message ? error.message : error);
    return { skipped: true };
  }
  if (!rows.length) return { skipped: true };
  if (refresh) await JeeMockTestResult.deleteMany({});
  const existing = await JeeMockTestResult.estimatedDocumentCount();
  let imported = false;
  if (existing === 0) {
    try {
      await JeeMockTestResult.insertMany(rows, { ordered: false });
      imported = true;
    } catch (error) {
      const duplicate = error && (error.code === 11000 || (error.writeErrors || []).every((item) => item.code === 11000));
      if (!duplicate) throw error;
    }
  }
  try {
    await ensureSampleRegistration(rows);
  } catch (error) {
    console.error('[jee-results] sample registration', error && error.message ? error.message : error);
  }
  return { imported, count: rows.length };
}

module.exports = {
  DATA_PATH,
  loadRows,
  ensureJeeMockTestResultsImported,
};
