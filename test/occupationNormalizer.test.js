const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSyntheticOccupation,
  normalizeOccupation,
} = require('../utils/occupationNormalizer');

describe('occupationNormalizer', () => {
  it('maps same-word typos to canonical categories', () => {
    assert.equal(normalizeOccupation('techer').occupationCategory, 'Teacher');
    assert.equal(normalizeOccupation('enginer').occupationCategory, 'Engineer');
    assert.equal(normalizeOccupation('houswife').occupationCategory, 'Housewife');
  });

  it('keeps acronyms as their own categories', () => {
    assert.equal(normalizeOccupation('SE').occupationCategory, 'SE');
    assert.equal(normalizeOccupation('se').occupationCategory, 'SE');
    assert.equal(normalizeOccupation('HR').occupationCategory, 'HR');
    assert.equal(normalizeOccupation('B.Tech').occupationCategory, 'B.Tech');
    assert.notEqual(normalizeOccupation('SE').occupationCategory, 'Software Engineer');
  });

  it('maps full software engineer text only', () => {
    assert.equal(normalizeOccupation('Software Engineer').occupationCategory, 'Software Engineer');
  });

  it('uses cleaned title-case for unknown values and keeps raw text', () => {
    const result = normalizeOccupation('  agri contractor  ');
    assert.equal(result.occupationCategory, 'Agri Contractor');
    assert.equal(result.occupationRaw, '  agri contractor  ');
  });

  it('treats empty occupation as Not specified', () => {
    assert.equal(normalizeOccupation('').occupationCategory, 'Not specified');
    assert.equal(normalizeOccupation('n/a').occupationCategory, 'Not specified');
  });

  it('detects synthetic OTP occupations', () => {
    assert.equal(isSyntheticOccupation('Student — Rank predictor'), true);
    assert.equal(isSyntheticOccupation('Student — GuideXpert tools'), true);
    assert.equal(isSyntheticOccupation('Resource Download'), true);
    assert.equal(isSyntheticOccupation('IIT First Form'), true);
    assert.equal(isSyntheticOccupation('Teacher'), false);
    assert.equal(isSyntheticOccupation('Student'), false);
  });
});
