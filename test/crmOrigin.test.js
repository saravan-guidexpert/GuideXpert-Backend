'use strict';

process.env.NODE_ENV = 'test';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { crmCorsOrigin, isAllowedCrmOrigin, PRODUCTION_FRONTEND_ORIGINS } = require('../utils/crmOrigin');

function productionEnv(extra = {}) {
  return { NODE_ENV: 'production', FRONTEND_URL: '', ...extra };
}

function developmentEnv(extra = {}) {
  return { NODE_ENV: 'development', FRONTEND_URL: '', ...extra };
}

async function corsHeaders(origin, env) {
  const app = express();
  app.use(cors({
    origin(value, callback) {
      return crmCorsOrigin(value, callback, env);
    },
    credentials: true,
  }));
  app.get('/probe', (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {};
    if (origin !== undefined) headers.Origin = origin;
    const response = await fetch(`${base}/probe`, { headers });
    return {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
      allowCredentials: response.headers.get('access-control-allow-credentials'),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('CRM origin allow-list', () => {
  test('production accepts the configured HTTPS frontends and rejects the wide defaults', () => {
    const env = productionEnv();
    for (const origin of PRODUCTION_FRONTEND_ORIGINS) {
      assert.equal(isAllowedCrmOrigin(origin, env), true);
    }
    assert.equal(isAllowedCrmOrigin('https://preview-guidexpert.vercel.app', env), false);
    assert.equal(isAllowedCrmOrigin('https://evil.example', env), false);
    assert.equal(isAllowedCrmOrigin('http://guidexpert.co.in', env), false);
    assert.equal(isAllowedCrmOrigin('http://localhost:5173', env), false);
    assert.equal(isAllowedCrmOrigin('https://tenant.guidexpert.co.in', env), false);
    assert.equal(isAllowedCrmOrigin(undefined, env), true);
    assert.equal(isAllowedCrmOrigin('', env), true);
  });

  test('production can add an exact HTTPS FRONTEND_URL and still rejects HTTP and previews', () => {
    const env = productionEnv({ FRONTEND_URL: 'https://app.example.com, http://localhost:5173' });
    assert.equal(isAllowedCrmOrigin('https://app.example.com', env), true);
    assert.equal(isAllowedCrmOrigin('http://localhost:5173', env), false);
    assert.equal(isAllowedCrmOrigin('https://app.example.com.evil.test', env), false);
    assert.equal(isAllowedCrmOrigin('https://crm-git-main-guidexpert.vercel.app', env), false);
  });

  test('development allows localhost on any port and does not allow every Vercel host', () => {
    const env = developmentEnv({ FRONTEND_URL: 'http://localhost:5000' });
    assert.equal(isAllowedCrmOrigin('http://localhost:5174', env), true);
    assert.equal(isAllowedCrmOrigin('http://127.0.0.1:4173', env), true);
    assert.equal(isAllowedCrmOrigin('https://www.guidexpert.co.in', env), true);
    assert.equal(isAllowedCrmOrigin('http://localhost:5000', env), true);
    assert.equal(isAllowedCrmOrigin('https://some-preview.vercel.app', env), false);
    assert.equal(isAllowedCrmOrigin('https://evil.example', env), false);
  });

  test('CORS echoes an approved origin and omits the allow-origin header for a rejected one', async () => {
    const env = productionEnv();
    const approved = await corsHeaders('https://www.guidexpert.co.in', env);
    assert.equal(approved.status, 200);
    assert.equal(approved.allowOrigin, 'https://www.guidexpert.co.in');
    assert.equal(approved.allowCredentials, 'true');
    const rejected = await corsHeaders('https://preview-guidexpert.vercel.app', env);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.allowOrigin, null);
    const missing = await corsHeaders(undefined, env);
    assert.equal(missing.status, 200);
    assert.equal(missing.allowOrigin, null);
  });

  test('the API server uses the CRM origin helper for CRM paths only', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(source, /cors\(apiCorsOptions\(\)\)/);
    const apiCors = fs.readFileSync(path.join(__dirname, '../utils/apiCors.js'), 'utf8');
    assert.match(apiCors, /crmCorsOrigin/);
    const login = fs.readFileSync(path.join(__dirname, '../services/crm/crmAuthService.js'), 'utf8');
    assert.match(login, /assertAllowedOrigin/);

    const { apiCorsOptions } = require('../utils/apiCors');
    const app = express();
    app.use(cors(apiCorsOptions(productionEnv())));
    app.use((req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const preflight = async (pathname, origin) => {
        const response = await fetch(`${base}${pathname}`, {
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
        });
        return response.headers.get('access-control-allow-origin');
      };
      const preview = 'https://preview-guidexpert.vercel.app';
      assert.equal(await preflight('/api/crm/activity', preview), null);
      assert.equal(await preflight('/api/crm-auth/login', preview), null);
      assert.equal(await preflight('/api/crm-auth/login', 'https://www.guidexpert.co.in'), 'https://www.guidexpert.co.in');
      assert.equal(await preflight('/api/jee-main-mock-test', preview), preview);
      assert.equal(await preflight('/api/forms', 'https://tenant.guidexpert.co.in'), 'https://tenant.guidexpert.co.in');
      assert.equal(await preflight('/api/crmx', preview), preview);
      assert.equal(await preflight('/api/forms', 'https://evil.example'), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
