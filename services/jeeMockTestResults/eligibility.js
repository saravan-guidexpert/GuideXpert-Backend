'use strict';

const ELIGIBILITY = {
  FORM_INCOMPLETE: 'FORM_INCOMPLETE',
  RESULT_PENDING: 'RESULT_PENDING',
  REGISTERED_NOT_ATTEMPTED: 'REGISTERED_NOT_ATTEMPTED',
  REGISTERED_ATTEMPTED: 'REGISTERED_ATTEMPTED',
};

function resolveEligibility(lead, result) {
  if (!lead || lead.formCompleted !== true) return ELIGIBILITY.FORM_INCOMPLETE;
  if (!result) return ELIGIBILITY.RESULT_PENDING;
  if (result.attemptStatus === 'NOT_ATTEMPTED') return ELIGIBILITY.REGISTERED_NOT_ATTEMPTED;
  if (result.attemptStatus === 'ATTEMPTED') return ELIGIBILITY.REGISTERED_ATTEMPTED;
  return ELIGIBILITY.RESULT_PENDING;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentage(obtained, total) {
  if (typeof obtained !== 'number' || typeof total !== 'number') return null;
  if (!Number.isFinite(obtained) || !Number.isFinite(total) || total === 0) return null;
  return Math.round((obtained / total) * 10000) / 100;
}

function toPublicResult(lead, result) {
  const eligibility = resolveEligibility(lead, result);
  const studentName = (result && result.name) || (lead && lead.studentName) || null;
  const invitedOn = result && result.invitedOn ? new Date(result.invitedOn).toISOString() : null;
  const base = {
    eligibility,
    studentName: eligibility === 'FORM_INCOMPLETE' ? null : studentName,
    invitedOn: eligibility === 'REGISTERED_ATTEMPTED' || eligibility === 'REGISTERED_NOT_ATTEMPTED' ? invitedOn : null,
  };

  if (eligibility === ELIGIBILITY.REGISTERED_NOT_ATTEMPTED) {
    return { ...base, attemptStatus: 'NOT_ATTEMPTED' };
  }
  if (eligibility !== ELIGIBILITY.REGISTERED_ATTEMPTED || !result) return base;

  const overallObtained = finiteNumber(result.overallCandidateScore);
  const overallTotal = finiteNumber(result.overallTotalScore);
  const mcqObtained = finiteNumber(result.mcqUserScore);
  const mcqTotal = finiteNumber(result.mcqMaxScore);
  const numericalObtained = finiteNumber(result.numericalUserScore);
  const numericalTotal = finiteNumber(result.numericalMaxScore);

  return {
    ...base,
    attemptStatus: 'ATTEMPTED',
    overall: {
      obtained: overallObtained,
      total: overallTotal,
      percentage: percentage(overallObtained, overallTotal),
      durationMinutes: finiteNumber(result.overallCandidateDuration),
      allottedMinutes: finiteNumber(result.overallDuration),
    },
    mcq: {
      obtained: mcqObtained,
      total: mcqTotal,
      durationMinutes: finiteNumber(result.mcqAttemptDuration),
    },
    numerical: {
      obtained: numericalObtained,
      total: numericalTotal,
      durationMinutes: finiteNumber(result.numericalAttemptDuration),
    },
  };
}

module.exports = {
  ELIGIBILITY,
  resolveEligibility,
  percentage,
  finiteNumber,
  toPublicResult,
};
