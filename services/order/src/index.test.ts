import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { app, parseCreateOrder, positiveInteger } from './index.js';

describe('order input validation', () => {
  it('accepts the documented hold contract', () => {
    assert.deepEqual(parseCreateOrder({ holdId: 41, customerEmail: 'Buyer@example.com' }), {
      holdId: 41, eventId: null, inventoryItemId: null, quantity: null, seatIds: [],
      admissionToken: null, customerEmail: 'buyer@example.com',
    });
  });

  it('accepts the compatible seated checkout contract', () => {
    assert.deepEqual(parseCreateOrder({
      eventId: 7, quantity: 2, seatIds: [10, 11], admissionToken: 'opaque-admission-token',
      customerEmail: 'buyer@example.com',
    }), {
      holdId: null, eventId: 7, inventoryItemId: null, quantity: 2, seatIds: [10, 11],
      admissionToken: 'opaque-admission-token', customerEmail: 'buyer@example.com',
    });
  });

  it('rejects duplicates, mismatched quantities, and malformed identifiers', () => {
    assert.equal(positiveInteger('1 OR 1=1'), null);
    assert.equal(parseCreateOrder({ eventId: 7, quantity: 2, seatIds: [10, 10] }), null);
    assert.equal(parseCreateOrder({ eventId: 7, quantity: 2, seatIds: [10] }), null);
  });
});

describe('order HTTP boundary', () => {
  let server: ReturnType<typeof app.listen>;

  it('rejects unauthenticated order creation before accessing persistence', async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ holdId: 41 }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
  });

  after(() => server?.close());
});
