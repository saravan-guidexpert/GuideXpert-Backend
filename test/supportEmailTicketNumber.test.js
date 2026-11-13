'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');
const { generateTicketNumber, formatDateKey } = require('../services/supportEmail/ticketNumberService');

describe('supportEmail ticketNumberService', () => {
  before(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  test('generateTicketNumber generates padded sequential ticket numbers', async () => {
    const fixedDate = new Date('2026-11-13T10:00:00.000Z');
    const dateKey = formatDateKey(fixedDate);
    assert.equal(dateKey, '20261113');

    const t1 = await generateTicketNumber({ date: fixedDate });
    const t2 = await generateTicketNumber({ date: fixedDate });
    const t3 = await generateTicketNumber({ date: fixedDate });

    assert.equal(t1, 'GX-20261113-0001');
    assert.equal(t2, 'GX-20261113-0002');
    assert.equal(t3, 'GX-20261113-0003');
  });

  test('concurrency: 50 parallel requests produce 50 unique sequential ticket numbers without collisions', async () => {
    const fixedDate = new Date('2026-11-13T12:00:00.000Z');
    const total = 50;

    const promises = [];
    for (let i = 0; i < total; i++) {
      promises.push(generateTicketNumber({ date: fixedDate }));
    }

    const generated = await Promise.all(promises);
    assert.equal(generated.length, total);

    // Verify all 50 are distinct
    const uniqueNumbers = new Set(generated);
    assert.equal(uniqueNumbers.size, total, 'Collisions detected in concurrent ticket number generation!');

    // Verify format and range
    for (let i = 1; i <= total; i++) {
      const expectedPadded = String(i).padStart(4, '0');
      const expectedTicket = `GX-20261113-${expectedPadded}`;
      assert.ok(uniqueNumbers.has(expectedTicket), `Missing expected ticket number ${expectedTicket}`);
    }
  });

  test('date partitioning: separate days maintain independent sequences', async () => {
    const day1 = new Date('2026-11-13T10:00:00.000Z');
    const day2 = new Date('2026-11-14T10:00:00.000Z');

    const t1Day1 = await generateTicketNumber({ date: day1 });
    const t2Day1 = await generateTicketNumber({ date: day1 });
    const t1Day2 = await generateTicketNumber({ date: day2 });

    assert.equal(t1Day1, 'GX-20261113-0001');
    assert.equal(t2Day1, 'GX-20261113-0002');
    assert.equal(t1Day2, 'GX-20261114-0001', 'Sequence should reset to 0001 on new date');
  });
});

