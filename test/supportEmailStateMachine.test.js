'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidJobTransition,
  assertValidJobTransition,
  isValidPipelineTransition,
  assertValidPipelineTransition,
  deriveOverallPipelineState
} = require('../services/supportEmail/stateMachine');
const { JOB_STATES, STAGES } = require('../constants/supportEmail');

describe('supportEmail stateMachine', () => {
  test('valid job state transitions are permitted', () => {
    assert.equal(isValidJobTransition(JOB_STATES.PENDING, JOB_STATES.CLAIMED), true);
    assert.equal(isValidJobTransition(JOB_STATES.CLAIMED, JOB_STATES.PROCESSING), true);
    assert.equal(isValidJobTransition(JOB_STATES.PROCESSING, JOB_STATES.COMPLETED), true);
    assert.equal(isValidJobTransition(JOB_STATES.PROCESSING, JOB_STATES.PENDING), true);
    assert.equal(isValidJobTransition(JOB_STATES.PROCESSING, JOB_STATES.DEAD_LETTER), true);
    assert.equal(isValidJobTransition(JOB_STATES.DEAD_LETTER, JOB_STATES.PENDING), true); // manual replay
    assert.equal(isValidJobTransition(JOB_STATES.PENDING, JOB_STATES.PENDING), true); // self idempotent
  });

  test('invalid job state transitions are rejected and assert throws', () => {
    assert.equal(isValidJobTransition(JOB_STATES.COMPLETED, JOB_STATES.PENDING), false);
    assert.equal(isValidJobTransition(JOB_STATES.CANCELLED, JOB_STATES.CLAIMED), false);
    assert.equal(isValidJobTransition(JOB_STATES.PENDING, JOB_STATES.COMPLETED), false);

    assert.throws(
      () => {
        assertValidJobTransition(JOB_STATES.COMPLETED, JOB_STATES.CLAIMED);
      },
      (err) => {
        assert.equal(err.code, 'INVALID_STATE_TRANSITION');
        assert.equal(err.fromState, JOB_STATES.COMPLETED);
        assert.equal(err.toState, JOB_STATES.CLAIMED);
        return true;
      }
    );
  });

  test('valid pipeline stage transitions are permitted', () => {
    assert.equal(isValidPipelineTransition(STAGES.FETCH, 'pending', 'fetched'), true);
    assert.equal(isValidPipelineTransition(STAGES.ATTACHMENTS, 'pending', 'extracted'), true);
    assert.equal(isValidPipelineTransition(STAGES.AI, 'processing', 'needs_review'), true);
    assert.equal(isValidPipelineTransition(STAGES.TICKET, 'pending', 'created'), true);
    assert.equal(isValidPipelineTransition(STAGES.SHEETS, 'pending', 'synced'), true);

    // Retry transitions from failed to success
    assert.equal(isValidPipelineTransition(STAGES.SHEETS, 'failed', 'synced'), true);
    assert.equal(isValidPipelineTransition(STAGES.FETCH, 'failed', 'fetched'), true);
    assert.equal(isValidPipelineTransition(STAGES.ATTACHMENTS, 'failed', 'extracted'), true);
    assert.equal(isValidPipelineTransition(STAGES.AI, 'failed', 'classified'), true);
    assert.equal(isValidPipelineTransition(STAGES.TICKET, 'failed', 'created'), true);
  });

  test('invalid pipeline stage transitions are rejected and assert throws', () => {
    assert.equal(isValidPipelineTransition(STAGES.FETCH, 'fetched', 'pending'), false);
    assert.equal(isValidPipelineTransition(STAGES.SHEETS, 'synced', 'pending'), false);

    assert.throws(
      () => {
        assertValidPipelineTransition(STAGES.FETCH, 'fetched', 'failed');
      },
      (err) => {
        assert.equal(err.code, 'INVALID_PIPELINE_TRANSITION');
        assert.equal(err.stage, STAGES.FETCH);
        return true;
      }
    );
  });

  test('deriveOverallPipelineState computes overall email status accurately', () => {
    // 1. Initial state
    assert.equal(
      deriveOverallPipelineState({ fetch: 'pending', attachments: 'pending', ai: 'pending', ticket: 'pending', sheets: 'pending' }, false),
      'received'
    );

    // 2. Fetch completed, downstream pending -> processing
    assert.equal(
      deriveOverallPipelineState({ fetch: 'fetched', attachments: 'pending', ai: 'pending', ticket: 'pending', sheets: 'pending' }, false),
      'processing'
    );

    // 3. Any active processing stage -> processing
    assert.equal(
      deriveOverallPipelineState({ fetch: 'fetched', attachments: 'processing', ai: 'pending', ticket: 'pending', sheets: 'pending' }, true),
      'processing'
    );

    // 4. AI needs_review -> needs_review
    assert.equal(
      deriveOverallPipelineState({ fetch: 'fetched', attachments: 'extracted', ai: 'needs_review', ticket: 'pending', sheets: 'pending' }, true),
      'needs_review'
    );

    // 5. Attachment failures flag for human review rather than fatal drop
    assert.equal(
      deriveOverallPipelineState({ fetch: 'fetched', attachments: 'failed', ai: 'classified', ticket: 'created', sheets: 'synced' }, true),
      'needs_review'
    );

    // 6. Fatal stage failures -> failed
    assert.equal(
      deriveOverallPipelineState({ fetch: 'failed', attachments: 'pending', ai: 'pending', ticket: 'pending', sheets: 'pending' }, false),
      'failed'
    );
    assert.equal(
      deriveOverallPipelineState({ fetch: 'fetched', attachments: 'extracted', ai: 'classified', ticket: 'failed', sheets: 'pending' }, true),
      'failed'
    );
    assert.equal(
      deriveOverallPipelineState({ fetch: 'fetched', attachments: 'extracted', ai: 'classified', ticket: 'created', sheets: 'exhausted' }, true),
      'failed'
    );

    // 7. Complete happy path -> completed
    assert.equal(
      deriveOverallPipelineState({
        fetch: 'fetched',
        attachments: 'extracted',
        ai: 'classified',
        ticket: 'created',
        sheets: 'synced'
      }, true),
      'completed'
    );

    // 7. Complete happy path with no attachments -> completed
    assert.equal(
      deriveOverallPipelineState({
        fetch: 'fetched',
        attachments: 'pending',
        ai: 'classified',
        ticket: 'created',
        sheets: 'synced'
      }, false),
      'completed'
    );
  });
});

