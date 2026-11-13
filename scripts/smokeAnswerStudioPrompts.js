'use strict';

/**
 * End-to-end smoke test for the Answer Studio prompts API against a running server.
 *
 *   BASE_URL=http://localhost:5050 node scripts/smokeAnswerStudioPrompts.js
 *
 * Creates one throwaway draft prompt + one version, then deletes both from the DB.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const AnswerStudioPrompt = require('../models/AnswerStudioPrompt');
const connectDB = require('../config/db');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5050';
const KEY = `smoke-test-${Date.now()}`;

let failures = 0;

function check(label, ok, details) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${details ? `  ${details}` : ''}`);
}

async function call(method, path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* ignore */
  }
  return { status: res.status, json, text };
}

async function main() {
  await connectDB();

  const admin = await Admin.findOne({ isSuperAdmin: true }).sort({ _id: 1 }).lean();
  if (!admin) throw new Error('No super admin found in this database.');

  const token = jwt.sign({ adminId: String(admin._id) }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: '5m',
  });
  console.log(`Server: ${BASE_URL}`);
  console.log(`Actor : ${admin.username} (${admin._id})`);

  const list = await call('GET', '/api/admin/answer-studio/prompts?limit=5', token);
  check('GET /prompts -> 200', list.status === 200, `status=${list.status} code=${list.json?.code || '-'}`);

  const created = await call('POST', '/api/admin/answer-studio/prompts', token, {
    key: KEY,
    platform: 'quora',
    body: 'smoke test prompt body',
  });
  check(
    'POST /prompts (create draft) -> 201',
    created.status === 201,
    `status=${created.status} code=${created.json?.code || '-'} message=${created.json?.message || '-'}`
  );
  const promptId = created.json?.data?.id;
  check('create returns id + version 1 + draft', Boolean(promptId) && created.json?.data?.version === 1 && created.json?.data?.lifecycle === 'draft', `id=${promptId}`);

  if (promptId) {
    const detail = await call('GET', `/api/admin/answer-studio/prompts/${promptId}`, token);
    check('GET /prompts/:id -> 200 with body', detail.status === 200 && detail.json?.data?.body === 'smoke test prompt body', `status=${detail.status}`);

    const version = await call('POST', `/api/admin/answer-studio/prompts/${promptId}/versions`, token, {
      body: 'smoke test prompt body v2',
    });
    check('POST /prompts/:id/versions -> 201 v2 draft', version.status === 201 && version.json?.data?.version === 2, `status=${version.status} version=${version.json?.data?.version}`);

    const duplicate = await call('POST', '/api/admin/answer-studio/prompts', token, {
      key: KEY,
      platform: 'quora',
      body: 'duplicate',
    });
    check('POST duplicate key -> 409 DUPLICATE_PROMPT_KEY', duplicate.status === 409 && duplicate.json?.code === 'DUPLICATE_PROMPT_KEY', `status=${duplicate.status} code=${duplicate.json?.code}`);
  }

  const removed = await AnswerStudioPrompt.deleteMany({ key: KEY });
  console.log(`cleanup: removed ${removed.deletedCount} smoke-test prompt row(s)`);

  await mongoose.disconnect();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('smoke test failed:', error);
  try {
    await AnswerStudioPrompt.deleteMany({ key: KEY });
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
