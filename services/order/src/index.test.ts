import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseOrderInput, parsePositiveId, shouldIssueTickets } from './index.js';

describe('order input', () => {
  it('accepts a bounded general-admission order', () => {
    assert.deepEqual(parseOrderInput({ eventId: 1, quantity: 2 }), { eventId: 1, quantity: 2 });
  });

  it('rejects invalid quantities and malformed seat ids', () => {
    assert.equal(parseOrderInput({ eventId: 1, quantity: 0 }), null);
    assert.equal(parseOrderInput({ eventId: 1, quantity: 11 }), null);
    assert.equal(parseOrderInput({ eventId: 1, quantity: 1, seatIds: ['1'] }), null);
  });

  it('allows paid orders to retry ticket issuance after a transient failure', () => {
    assert.equal(shouldIssueTickets('PAID'), true);
    assert.equal(shouldIssueTickets('CANCELLED'), false);
  });

  it('accepts only positive integer resource ids', () => {
    assert.equal(parsePositiveId('12'), 12);
    assert.equal(parsePositiveId(0), null);
    assert.equal(parsePositiveId('not-an-id'), null);
  });
});