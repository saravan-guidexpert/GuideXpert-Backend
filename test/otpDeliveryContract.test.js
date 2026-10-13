const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

process.env.OTP_SECRET = process.env.OTP_SECRET || 'unit-test-otp-secret';

const { hashOTP, verifyOTP } = require('../utils/otpUtil');
const otpMemoryFallback = require('../utils/otpMemoryFallback');
const otpRepository = require('../utils/otpRepository');
const OtpVerification = require('../models/OtpVerification');

describe('OTP expiry, resend, and verification', () => {
  it('drops an expired in-memory OTP', () => {
    const phone = '9000000011';
    otpMemoryFallback.set(phone, {
      otpHash: hashOTP('111111'),
      expiresAt: Date.now() - 1000,
      attempts: 0,
      createdAt: Date.now() - 60_000,
    });
    assert.equal(otpMemoryFallback.get(phone), null);
  });

  it('keeps only the newest OTP for a phone', () => {
    const phone = '9000000012';
    const future = Date.now() + 60_000;
    otpMemoryFallback.set(phone, {
      otpHash: hashOTP('111111'),
      expiresAt: future,
      attempts: 2,
      createdAt: Date.now() - 30_000,
    });
    otpMemoryFallback.set(phone, {
      otpHash: hashOTP('222222'),
      expiresAt: future,
      attempts: 0,
      createdAt: Date.now(),
    });
    const latest = otpMemoryFallback.get(phone);
    assert.equal(verifyOTP('222222', latest.otpHash), true);
    assert.equal(verifyOTP('111111', latest.otpHash), false);
    otpMemoryFallback.remove(phone);
  });

  it('blocks a resend inside the cooldown window', async () => {
    const phone = '9000000013';
    otpMemoryFallback.set(phone, {
      otpHash: hashOTP('333333'),
      expiresAt: Date.now() + 5 * 60_000,
      attempts: 0,
      createdAt: new Date(),
    });
    const decision = await otpRepository.canSend(phone);
    assert.equal(decision.allowed, false);
    assert.match(decision.message, /wait/i);
    assert.ok(decision.retryAfter > 0);
    otpMemoryFallback.remove(phone);
  });

  it('blocks another send after the rate-limit window is full', async () => {
    const phone = '9000000014';
    otpMemoryFallback.remove(phone);
    mock.method(OtpVerification, 'findOne', () => ({
      sort() { return this; },
      lean() { return this; },
      exec: async () => null,
    }));
    mock.method(OtpVerification, 'countDocuments', async () => 3);
    try {
      const decision = await otpRepository.canSend(phone);
      assert.equal(decision.allowed, false);
      assert.match(decision.message, /too many/i);
    } finally {
      mock.reset();
      otpMemoryFallback.remove(phone);
    }
  });
});
