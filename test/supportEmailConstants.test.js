'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STAGES,
  PROCESSING_STAGES,
  JOB_STATES,
  ALL_JOB_STATES,
  STAGE_STATES,
  EMAIL_PIPELINE_STATES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  LIMITS
} = require('../constants/supportEmail');

describe('supportEmail constants & limits', () => {
  test('stages enum contains required processing stages', () => {
    assert.equal(STAGES.FETCH, 'fetch');
    assert.equal(STAGES.ATTACHMENTS, 'attachments');
    assert.equal(STAGES.AI, 'ai');
    assert.equal(STAGES.TICKET, 'ticket');
    assert.equal(STAGES.SHEETS, 'sheets');
    assert.deepEqual(PROCESSING_STAGES, ['fetch', 'attachments', 'ai', 'ticket', 'sheets']);
  });

  test('job states enum contains queue lifecycle states', () => {
    assert.equal(JOB_STATES.PENDING, 'pending');
    assert.equal(JOB_STATES.CLAIMED, 'claimed');
    assert.equal(JOB_STATES.PROCESSING, 'processing');
    assert.equal(JOB_STATES.COMPLETED, 'completed');
    assert.equal(JOB_STATES.FAILED, 'failed');
    assert.equal(JOB_STATES.DEAD_LETTER, 'dead_letter');
    assert.equal(JOB_STATES.CANCELLED, 'cancelled');
    assert.ok(ALL_JOB_STATES.includes('dead_letter'));
  });

  test('stage states are defined for each stage', () => {
    assert.deepEqual(STAGE_STATES.fetch, ['pending', 'fetched', 'failed']);
    assert.ok(STAGE_STATES.attachments.includes('extracted'));
    assert.ok(STAGE_STATES.ai.includes('needs_review'));
    assert.ok(STAGE_STATES.ticket.includes('linked'));
    assert.ok(STAGE_STATES.sheets.includes('exhausted'));
  });

  test('operational limits and stage caps are set safely', () => {
    assert.equal(LIMITS.DEFAULT_BATCH_SIZE, 25);
    assert.equal(LIMITS.DEFAULT_TIME_BUDGET_MS, 45000);
    assert.equal(LIMITS.DEFAULT_STALE_LEASE_MS, 120000);
    assert.equal(LIMITS.MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
    assert.equal(LIMITS.MAX_MESSAGE_ATTACHMENT_BYTES, 25 * 1024 * 1024);
    assert.equal(LIMITS.MAX_PDF_PAGES, 30);
    assert.equal(LIMITS.MAX_BODY_TEXT_LENGTH, 100000);
    assert.equal(LIMITS.MAX_BODY_HTML_SNIPPET_LENGTH, 20000);

    // Stage specific max attempt caps
    assert.equal(LIMITS.STAGE_MAX_ATTEMPTS.fetch, 6);
    assert.equal(LIMITS.STAGE_MAX_ATTEMPTS.attachments, 5);
    assert.equal(LIMITS.STAGE_MAX_ATTEMPTS.ai, 4);
    assert.equal(LIMITS.STAGE_MAX_ATTEMPTS.ticket, 5);
    assert.equal(LIMITS.STAGE_MAX_ATTEMPTS.sheets, 5);
  });
});

