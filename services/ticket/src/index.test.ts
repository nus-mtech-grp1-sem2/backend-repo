import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { app, checkinInput } from './index.js';

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