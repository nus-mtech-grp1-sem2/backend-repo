import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { app, checkinInput, parseOrderPaid } from './index.js';

describe('ticket input validation', () => {
  it('accepts one event and one opaque QR token', () => {
    assert.deepEqual(checkinInput({ eventId: '12', qrToken: 'opaque-token' }), {
      eventId: 12,
      ticketId: null,
      qrToken: 'opaque-token',
    });
  });

  it('rejects missing, ambiguous, and oversized identifiers', () => {
    assert.equal(checkinInput({ eventId: 12 }), null);
    assert.equal(checkinInput({ eventId: 12, ticketId: 4, qrToken: 'token' }), null);
    assert.equal(checkinInput({ eventId: 12, qrToken: 'x'.repeat(256) }), null);
  });
});

describe('ticket HTTP boundary', () => {
  let server: ReturnType<typeof app.listen>;

  it('rejects unauthenticated validation requests', async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/tickets/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 12, qrToken: 'opaque-token' }),
    });
    assert.equal(response.status, 401);
  });

  after(() => server?.close());
});

describe('paid order event validation', () => {
  it('accepts the paid order contract published by the order service', () => {
    assert.deepEqual(parseOrderPaid({
      type: 'OrderPaid',
      version: 1,
      orderId: 81,
      eventId: 12,
      customerSub: 'customer-123',
      customerEmail: 'customer@example.com',
      items: [{ order_item_id: 91, seat_id: 31, quantity: 1 }],
    }), {
      type: 'OrderPaid',
      version: 1,
      orderId: 81,
      eventId: 12,
      customerSub: 'customer-123',
      customerEmail: 'customer@example.com',
      items: [{ orderItemId: 91, seatId: 31, quantity: 1 }],
    });
  });

  it('rejects an invalid or repeated seated ticket quantity', () => {
    assert.equal(parseOrderPaid({ type: 'Other', version: 1 }), null);
    assert.equal(parseOrderPaid({
      type: 'OrderPaid', version: 1, orderId: 81, eventId: 12,
      customerSub: 'customer-123', customerEmail: 'customer@example.com',
      items: [{ order_item_id: 91, seat_id: 31, quantity: 2 }],
    }), null);
  });
});
describe('EH-01 scanner sessions', () => {
  it('rejects malformed or expired scanner tokens', () => {
    assert.equal(verifyScannerSession('not-a-jwt'), null);
  });

  it('does not accept a token with the wrong shape', () => {
    assert.equal(verifyScannerSession('header.payload.signature.extra'), null);
  });
});

describe('EH-05 manual lookup query validation', () => {
  it('requires at least three characters and accepts only q', () => {
    assert.equal(parseSearchQuery({ q: 'pr' }), null);
    assert.equal(parseSearchQuery({ q: 'priya' }), 'priya');
    assert.equal(parseSearchQuery({ q: 'priya', eventId: '2' }), null);
  });
});

describe('CU-07 ticket issuance primitives', () => {
  it('creates URL-safe random QR tokens', () => {
    const first = createQrToken();
    const second = createQrToken();
    assert.equal(Buffer.from(first, 'base64url').length, 32);
    assert.equal(Buffer.from(second, 'base64url').length, 32);
    assert.notEqual(first, second);
    assert.match(first, /^[A-Za-z0-9_-]+$/);
  });
});
