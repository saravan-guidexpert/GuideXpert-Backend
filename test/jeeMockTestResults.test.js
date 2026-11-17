'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseResultsTsv, duplicateMobiles } = require('../services/jeeMockTestResults/parseSheet');
const { resolveEligibility, toPublicResult, percentage, ELIGIBILITY } = require('../services/jeeMockTestResults/eligibility');
const { formatDuration, formatScorePair, formatPercentage } = require('../services/jeeMockTestResults/format');

const rows = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/jeeMockTestResults.json'), 'utf8')
);

describe('JEE mock test result sheet', () => {
  test('keeps every mobile unique and preserves empty, zero, and negative scores', () => {
    assert.equal(duplicateMobiles(rows).length, 0);
    assert.ok(rows.length > 400);

    const negative = rows.find((row) => row.mobile === '9059725252');
    assert.equal(negative.attemptStatus, 'ATTEMPTED');
    assert.equal(negative.overallCandidateScore, -5);
    assert.equal(negative.mcqUserScore, -5);
    assert.equal(negative.numericalUserScore, 0);

    const zero = rows.find((row) => row.mobile === '8074418693');
    assert.equal(zero.overallCandidateScore, 0);
    assert.equal(zero.numericalUserScore, null);

    const missingNumerical = rows.find((row) => row.mobile === '9705165937');
    assert.equal(missingNumerical.mcqUserScore, 145);
    assert.equal(missingNumerical.numericalUserScore, null);
    assert.equal(missingNumerical.numericalAttemptDuration, null);

    const notAttempted = rows.find((row) => row.mobile === '8185862969');
    assert.equal(notAttempted.attemptStatus, 'NOT_ATTEMPTED');
    assert.equal(notAttempted.overallCandidateScore, null);
    assert.equal(notAttempted.overallCandidateDuration, null);

    const sample = rows.find((row) => row.mobile === '9347763131');
    assert.equal(sample.name, 'Sample Student');
    assert.equal(sample.attemptStatus, 'ATTEMPTED');
    assert.equal(sample.overallCandidateScore, 185);
    assert.ok(sample.overallCandidateScore >= 150);
  });

  test('parses a blank numerical cell as null and a zero as zero', () => {
    const parsed = parseResultsTsv([
      'name\tmobile\temail\tinvited_on\tattempt_status\toverall_total_score\toverall_candidate_score\toverall_duration\toverall_candidate_duration\tMCQs max score\tMCQs user score\tMCQs attempt duration\tNumerical Questions max score\tNumerical Questions user score\tNumerical Questions attempt duration',
      'A Student\t9000000011\ta@example.com\tNov 08, 2026 at 10:44AM\tATTEMPTED\t300\t0\t180\t0\t240\t0\t0\t60\t\t',
    ].join('\n'));
    assert.equal(parsed[0].overallCandidateScore, 0);
    assert.equal(parsed[0].overallCandidateDuration, 0);
    assert.equal(parsed[0].numericalUserScore, null);
    assert.equal(parsed[0].numericalAttemptDuration, null);
    assert.equal(parsed[0].invitedOn, '2026-11-08T05:14:00.000Z');
  });
});

describe('JEE mock test eligibility', () => {
  const attemptedResult = {
    name: 'Sheet Name',
    invitedOn: '2026-11-08T05:14:00.000Z',
    attemptStatus: 'ATTEMPTED',
    overallTotalScore: 300,
    overallCandidateScore: -5,
    overallDuration: 180,
    overallCandidateDuration: 34.93,
    mcqMaxScore: 240,
    mcqUserScore: -5,
    mcqAttemptDuration: 24.8,
    numericalMaxScore: 60,
    numericalUserScore: null,
    numericalAttemptDuration: null,
  };

  test('an incomplete registration never becomes a result, even when the exam sheet has a score', () => {
    const lead = { studentName: 'Form Name', formCompleted: false };
    assert.equal(resolveEligibility(lead, attemptedResult), ELIGIBILITY.FORM_INCOMPLETE);
    assert.equal(resolveEligibility(null, attemptedResult), ELIGIBILITY.FORM_INCOMPLETE);
    const pub = toPublicResult(lead, attemptedResult);
    assert.equal(pub.eligibility, 'FORM_INCOMPLETE');
    assert.equal(pub.studentName, null);
    assert.equal(pub.overall, undefined);
    assert.equal(JSON.stringify(pub).includes('-5'), false);
    assert.equal(JSON.stringify(pub).includes('Sheet Name'), false);
  });

  test('a completed registration with NOT_ATTEMPTED does not include scores', () => {
    const lead = { studentName: 'Registered', formCompleted: true };
    const result = { ...attemptedResult, attemptStatus: 'NOT_ATTEMPTED', overallCandidateScore: null };
    const pub = toPublicResult(lead, result);
    assert.equal(pub.eligibility, 'REGISTERED_NOT_ATTEMPTED');
    assert.equal(pub.attemptStatus, 'NOT_ATTEMPTED');
    assert.equal(pub.studentName, 'Sheet Name');
    assert.equal(pub.overall, undefined);
  });

  test('a completed registration with no sheet row stays pending', () => {
    const pub = toPublicResult({ studentName: 'Waiting', formCompleted: true }, null);
    assert.equal(pub.eligibility, 'RESULT_PENDING');
    assert.equal(pub.studentName, 'Waiting');
    assert.equal(pub.invitedOn, null);
    assert.equal(pub.overall, undefined);
  });

  test('attempted scores keep negatives, zeros, nulls, and a real percentage', () => {
    const pub = toPublicResult({ studentName: 'Form Name', formCompleted: true }, attemptedResult);
    assert.equal(pub.eligibility, 'REGISTERED_ATTEMPTED');
    assert.equal(pub.overall.obtained, -5);
    assert.equal(pub.overall.percentage, -1.67);
    assert.equal(pub.numerical.obtained, null);
    assert.equal(pub.numerical.durationMinutes, null);
    assert.equal(percentage(0, 300), 0);
    assert.equal(formatScorePair(-5, 300), '-5 / 300');
    assert.equal(formatScorePair(null, 300), 'Not available / 300');
    assert.equal(formatPercentage(0), '0%');
    assert.equal(formatPercentage(-1.67), '-1.67%');
    assert.equal(formatDuration(null), 'Not available');
    assert.equal(formatDuration(0), '0 min');
    assert.equal(formatDuration(48.22), '48 min 13 sec');
    assert.equal(JSON.stringify(pub).includes('email'), false);
  });
});
