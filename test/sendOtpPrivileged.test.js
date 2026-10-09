const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPrivilegedPhone,
  getPrivilegedOtp,
  shouldSkipSmsForPrivileged,
} = require('../utils/privilegedAccess');
const msg91Service = require('../utils/msg91Service');

describe('sendOtp and Privileged SMS Handling', () => {
  it('identifies 6304153659, 8143266699, and 8919926373 as privileged', () => {
    assert.equal(isPrivilegedPhone('6304153659'), true);
    assert.equal(isPrivilegedPhone('8143266699'), true);
    assert.equal(isPrivilegedPhone('8919926373'), true);
    assert.equal(isPrivilegedPhone('9347763131'), false);
    assert.equal(isPrivilegedPhone('9123456780'), false);
  });

  it('privileged phones return fixed OTP 123456', () => {
    assert.equal(getPrivilegedOtp(), '123456');
  });

  it('privileged phones do NOT skip SMS by default (ensures user receives SMS on phone)', () => {
    delete process.env.OTP_BYPASS_SKIP_SMS;
    assert.equal(shouldSkipSmsForPrivileged('6304153659'), false);
    assert.equal(shouldSkipSmsForPrivileged('8143266699'), false);
  });

  it('privileged phones only skip SMS when OTP_BYPASS_SKIP_SMS=true is set', () => {
    process.env.OTP_BYPASS_SKIP_SMS = 'true';
    assert.equal(shouldSkipSmsForPrivileged('6304153659'), true);
    assert.equal(shouldSkipSmsForPrivileged('8143266699'), true);
    assert.equal(shouldSkipSmsForPrivileged('9123456780'), false);
    delete process.env.OTP_BYPASS_SKIP_SMS;
  });

  it('msg91Service.sendOtp returns error when not configured', async () => {
    const origAuth = process.env.MSG91_AUTH_KEY;
    const origTemplate = process.env.MSG91_TEMPLATE_ID;
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;

    const result = await msg91Service.sendOtp('6304153659', '123456');
    assert.equal(result.success, false);
    assert.match(result.error, /MSG91 not configured/i);

    if (origAuth) process.env.MSG91_AUTH_KEY = origAuth;
    if (origTemplate) process.env.MSG91_TEMPLATE_ID = origTemplate;
  });
});
