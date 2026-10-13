const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TEST_AUTH = 'test-auth-key-do-not-log';
const TEST_TEMPLATE = '697c354d7884ab43486cca53';

process.env.MSG91_AUTH_KEY = TEST_AUTH;
process.env.MSG91_TEMPLATE_ID = TEST_TEMPLATE;

const msg91Service = require('../utils/msg91Service');

function mockAuthOk() {
  mock.method(axios, 'get', async () => ({ status: 200, data: '1.25' }));
}

describe('MSG91 transactional OTP', () => {
  it('posts only to the transactional OTP endpoint with auth in the header', async () => {
    let capturedUrl = '';
    let capturedBody = null;
    let capturedHeaders = null;
    mockAuthOk();
    mock.method(axios, 'post', async (url, body, config) => {
      capturedUrl = url;
      capturedBody = body;
      capturedHeaders = config?.headers;
      return { status: 200, data: { type: 'success', request_id: 'req_test_abc123' } };
    });

    try {
      const result = await msg91Service.sendOtp('9347763131', '654321');
      assert.equal(result.success, true);
      assert.equal(result.status, 'accepted');
      assert.equal(result.requestId, 'req_test_abc123');
      assert.equal(result.provider, 'msg91-otp');
      assert.equal(typeof result.correlationId, 'string');
      assert.match(capturedUrl, /^https:\/\/control\.msg91\.com\/api\/v5\/otp\?/);
      assert.doesNotMatch(capturedUrl, /\/api\/v5\/flow/);
      assert.match(capturedUrl, /template_id=697c354d7884ab43486cca53/);
      assert.match(capturedUrl, /mobile=919347763131/);
      assert.match(capturedUrl, /otp=654321/);
      assert.match(capturedUrl, /otp_expiry=/);
      assert.match(capturedUrl, /realTimeResponse=1/);
      assert.doesNotMatch(capturedUrl, /authkey=/);
      assert.equal(capturedHeaders?.authkey, TEST_AUTH);
      assert.equal(capturedHeaders?.['content-type'], 'application/json');
      assert.equal(capturedBody, null);
    } finally {
      mock.reset();
    }
  });

  it('does not call the Flow API for a 24-character template id', async () => {
    let calledFlow = false;
    let calledOtp = false;
    mockAuthOk();
    mock.method(axios, 'post', async (url) => {
      if (String(url).includes('/api/v5/flow')) calledFlow = true;
      if (String(url).includes('/api/v5/otp')) calledOtp = true;
      return { status: 200, data: { type: 'success', request_id: 'req_otp_direct' } };
    });

    try {
      const result = await msg91Service.sendOtp('9876543210', '112233');
      assert.equal(result.success, true);
      assert.equal(calledOtp, true);
      assert.equal(calledFlow, false);
    } finally {
      mock.reset();
    }
  });

  it('normalizes Indian numbers to country code 91', async () => {
    const cases = [
      ['9876543210', 'mobile=919876543210'],
      ['+91 9876543210', 'mobile=919876543210'],
      ['919876543210', 'mobile=919876543210'],
      ['09876543210', 'mobile=919876543210'],
      ['(987) 654-3210', 'mobile=919876543210'],
    ];

    for (const [input, expected] of cases) {
      let capturedUrl = '';
      mockAuthOk();
      mock.method(axios, 'post', async (url) => {
        capturedUrl = url;
        return { status: 200, data: { type: 'success', request_id: 'req_1' } };
      });
      try {
        const res = await msg91Service.sendOtp(input, '123456');
        assert.equal(res.success, true);
        assert.match(capturedUrl, new RegExp(expected));
      } finally {
        mock.reset();
      }
    }
  });

  it('rejects short phone numbers without calling MSG91', async () => {
    let called = false;
    mock.method(axios, 'get', async () => {
      called = true;
      return { status: 200, data: '1' };
    });
    mock.method(axios, 'post', async () => {
      called = true;
      return { status: 200, data: {} };
    });
    try {
      const result = await msg91Service.sendOtp('12345', '123456');
      assert.equal(result.success, false);
      assert.equal(result.status, 'rejected');
      assert.match(result.error, /invalid phone/i);
      assert.equal(called, false);
    } finally {
      mock.reset();
    }
  });

  it('rejects a non-2xx provider response', async () => {
    mockAuthOk();
    mock.method(axios, 'post', async () => ({
      status: 401,
      data: { message: 'Authentication failure' },
    }));
    try {
      const result = await msg91Service.sendOtp('9876543210', '123456');
      assert.equal(result.success, false);
      assert.equal(result.status, 'rejected');
      assert.match(result.error, /Authentication failure/i);
    } finally {
      mock.reset();
    }
  });

  it('rejects an application error returned with HTTP 200', async () => {
    mockAuthOk();
    mock.method(axios, 'post', async () => ({
      status: 200,
      data: { type: 'error', message: 'Template id missing' },
    }));
    try {
      const result = await msg91Service.sendOtp('9876543210', '123456');
      assert.equal(result.success, false);
      assert.equal(result.status, 'rejected');
      assert.match(result.error, /Template id missing/i);
    } finally {
      mock.reset();
    }
  });

  it('rejects malformed provider bodies that are not an accepted OTP request', async () => {
    for (const data of ['ok', null, { message: 'OTP sent successfully' }, { type: 'success' }]) {
      mockAuthOk();
      mock.method(axios, 'post', async () => ({ status: 200, data }));
      try {
        const result = await msg91Service.sendOtp('9876543210', '123456');
        assert.equal(result.success, false, `expected rejection for ${JSON.stringify(data)}`);
        assert.equal(result.status, 'rejected');
      } finally {
        mock.reset();
      }
    }
  });

  it('rejects when MSG91 reports the auth key as invalid and does not submit the OTP', async () => {
    let posted = false;
    mock.method(axios, 'get', async () => ({
      status: 200,
      data: { msg: '201', msgType: 'error' },
    }));
    mock.method(axios, 'post', async () => {
      posted = true;
      return { status: 200, data: { type: 'success', request_id: 'should-not-send' } };
    });
    try {
      const result = await msg91Service.sendOtp('9876543210', '123456');
      assert.equal(result.success, false);
      assert.equal(result.status, 'rejected');
      assert.match(result.error, /auth key/i);
      assert.equal(posted, false);
    } finally {
      mock.reset();
    }
  });

  it('rejects network failures and timeouts', async () => {
    mockAuthOk();
    mock.method(axios, 'post', async () => {
      const err = new Error('timeout of 15000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    });
    try {
      const result = await msg91Service.sendOtp('9876543210', '123456');
      assert.equal(result.success, false);
      assert.equal(result.status, 'rejected');
      assert.match(result.error, /timeout/i);
    } finally {
      mock.reset();
    }
  });

  it('does not log OTP values or the auth key', async () => {
    const logs = [];
    const warns = [];
    mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    mock.method(console, 'warn', (...args) => warns.push(args.join(' ')));
    mockAuthOk();
    mock.method(axios, 'post', async () => ({
      status: 200,
      data: { type: 'success', request_id: 'req_logged_1' },
    }));
    const secretOtp = '874921';
    try {
      await msg91Service.sendOtp('9347763131', secretOtp);
      const allOutput = [...logs, ...warns].join('\n');
      assert.equal(allOutput.includes(secretOtp), false);
      assert.equal(allOutput.includes(TEST_AUTH), false);
      assert.match(allOutput, /ref=/);
      assert.match(allOutput, /requestId: req_logged_1/);
    } finally {
      mock.reset();
    }
  });

  it('requires an auth key and keeps the OTP endpoint explicit in source', () => {
    const source = fs.readFileSync(path.join(__dirname, '../utils/msg91Service.js'), 'utf8');
    assert.equal(source.includes('templateId.length === 24'), false);
    assert.equal(source.includes('DEFAULT_MSG91_AUTH_KEY'), false);
    assert.equal(msg91Service.MSG91_SEND_OTP_URL, 'https://control.msg91.com/api/v5/otp');
    assert.equal(msg91Service.MSG91_FLOW_URL, 'https://control.msg91.com/api/v5/flow');
    const sendFn = msg91Service.sendOtp.toString();
    assert.equal(sendFn.includes('MSG91_FLOW_URL'), false);
    assert.equal(sendFn.includes('/api/v5/flow'), false);
  });
});
