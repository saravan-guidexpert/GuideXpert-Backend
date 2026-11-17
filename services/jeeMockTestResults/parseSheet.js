'use strict';

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const HEADERS = [
  'name',
  'mobile',
  'email',
  'invited_on',
  'attempt_status',
  'overall_total_score',
  'overall_candidate_score',
  'overall_duration',
  'overall_candidate_duration',
  'MCQs max score',
  'MCQs user score',
  'MCQs attempt duration',
  'Numerical Questions max score',
  'Numerical Questions user score',
  'Numerical Questions attempt duration',
];

function parseNumber(raw, label) {
  const text = raw == null ? '' : String(raw).trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return value;
}

function parseInvitedOn(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  const match = text.match(/^([A-Za-z]{3}) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) throw new Error(`Invalid invited_on: ${raw}`);
  const month = MONTHS[match[1].toLowerCase()];
  if (month == null) throw new Error(`Invalid invited_on month: ${raw}`);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = match[6].toUpperCase();
  if (meridiem === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  const day = String(match[2]).padStart(2, '0');
  const monthNumber = String(month + 1).padStart(2, '0');
  const iso = `${match[3]}-${monthNumber}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid invited_on: ${raw}`);
  return date;
}

function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const mobile = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^[6-9]\d{9}$/.test(mobile)) return null;
  if (digits.length !== 10 && digits !== `91${mobile}`) return null;
  return mobile;
}

function rowFromCells(cells, lineNumber) {
  const padded = cells.slice();
  while (padded.length < HEADERS.length) padded.push('');
  const mobile = normalizeMobile(padded[1]);
  if (!mobile) throw new Error(`Invalid mobile on line ${lineNumber}`);
  const attemptStatus = String(padded[4] || '').trim();
  if (attemptStatus !== 'ATTEMPTED' && attemptStatus !== 'NOT_ATTEMPTED') {
    throw new Error(`Invalid attempt_status on line ${lineNumber}`);
  }
  const name = String(padded[0] || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error(`Invalid name on line ${lineNumber}`);
  return {
    name,
    mobile,
    email: String(padded[2] || '').trim().toLowerCase(),
    invitedOn: parseInvitedOn(padded[3]).toISOString(),
    attemptStatus,
    overallTotalScore: parseNumber(padded[5], 'overall_total_score'),
    overallCandidateScore: parseNumber(padded[6], 'overall_candidate_score'),
    overallDuration: parseNumber(padded[7], 'overall_duration'),
    overallCandidateDuration: parseNumber(padded[8], 'overall_candidate_duration'),
    mcqMaxScore: parseNumber(padded[9], 'MCQs max score'),
    mcqUserScore: parseNumber(padded[10], 'MCQs user score'),
    mcqAttemptDuration: parseNumber(padded[11], 'MCQs attempt duration'),
    numericalMaxScore: parseNumber(padded[12], 'Numerical Questions max score'),
    numericalUserScore: parseNumber(padded[13], 'Numerical Questions user score'),
    numericalAttemptDuration: parseNumber(padded[14], 'Numerical Questions attempt duration'),
  };
}

function parseResultsTsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) throw new Error('Result sheet is empty');
  const header = lines[0].split('\t').map((cell) => cell.trim());
  const missing = HEADERS.filter((name, index) => header[index] !== name);
  if (missing.length) {
    throw new Error(`Unexpected result sheet header: ${header.join(' | ')}`);
  }
  return lines.slice(1).map((line, index) => rowFromCells(line.split('\t'), index + 2));
}

function duplicateMobiles(rows) {
  const seen = new Set();
  const duplicates = new Set();
  rows.forEach((row) => {
    if (seen.has(row.mobile)) duplicates.add(row.mobile);
    seen.add(row.mobile);
  });
  return [...duplicates];
}

function assertUniqueMobiles(rows) {
  const duplicates = duplicateMobiles(rows);
  if (duplicates.length) {
    throw new Error(`Duplicate result mobiles: ${duplicates.join(', ')}`);
  }
  return rows;
}

module.exports = {
  HEADERS,
  normalizeMobile,
  parseInvitedOn,
  parseNumber,
  parseResultsTsv,
  duplicateMobiles,
  assertUniqueMobiles,
};
