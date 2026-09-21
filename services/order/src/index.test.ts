import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  app,
  isEventTeamPurchase,
  parseCreateOrder,
  positiveInteger,
  requestQueueRefill,
  requestTicketIssuance,
  saleBlockReason,
} from './index.js';

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

describe('event-team purchase restriction', () => {
  it('blocks the event owner and accepted event-team members', () => {
    assert.equal(isEventTeamPurchase('owner-sub', 0, 'owner-sub'), true);
    assert.equal(isEventTeamPurchase('owner-sub', 1, 'helper-sub'), true);
  });

  it('allows a customer who is not on the event team', () => {
    assert.equal(isEventTeamPurchase('owner-sub', 0, 'customer-sub'), false);
  });
});

describe('sale window', () => {
  it('is on sale only while the event is published and has not started', () => {
    assert.equal(saleBlockReason({ status: 'PUBLISHED', has_started: 0 }), null);
    assert.equal(saleBlockReason({ status: 'PUBLISHED', has_started: 1 }), 'event_completed');
  });

  it('treats an event that is not published as not on sale, even after it has started', () => {
    assert.equal(saleBlockReason({ status: 'DRAFT', has_started: 0 }), 'event_not_on_sale');
    assert.equal(saleBlockReason({ status: 'CANCELLED', has_started: 1 }), 'event_not_on_sale');
  });

  it('does not treat a missing start flag as completed', () => {
    assert.equal(saleBlockReason({ status: 'PUBLISHED', has_started: null }), null);
    assert.equal(saleBlockReason({ status: 'PUBLISHED', has_started: undefined }), null);
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

describe('local ticket issuance fallback', () => {
  it('calls the secured internal ticket endpoint when local fallback is configured', async () => {
    let requestedUrl = '';
    let requestedSecret = '';
    const issued = await requestTicketIssuance(
      17,
      'http://ticket:3005/',
      'shared-secret',
      async (input, init) => {
        requestedUrl = String(input);
        requestedSecret = new Headers(init?.headers).get('x-ticket-internal-secret') ?? '';
        return new Response(JSON.stringify({ issued: 1 }), { status: 200 });
      },
    );

    assert.equal(issued, true);
    assert.equal(requestedUrl, 'http://ticket:3005/internal/orders/17/issue-tickets');
    assert.equal(requestedSecret, 'shared-secret');
  });

  it('stays disabled when no local ticket service is configured', async () => {
    assert.equal(await requestTicketIssuance(17, '', ''), false);
  });

  it('accepts deferred issuance without delaying or undoing payment confirmation', async () => {
    assert.equal(await requestTicketIssuance(17, 'http://ticket:3005', 'offline-secret', async () =>
      new Response(JSON.stringify({ issued: 0, status: 'PENDING' }), { status: 202 })), true);
  });
});

describe('immediate queue refill', () => {
  it('calls the secured internal queue endpoint after a slot is released', async () => {
    let requestedUrl = '';
    let requestedToken = '';
    let requestedMethod = '';
    const refilled = await requestQueueRefill(
      23,
      'http://queue:3003/',
      'internal-token',
      async (input, init) => {
        requestedUrl = String(input);
        requestedToken = new Headers(init?.headers).get('x-internal-token') ?? '';
        requestedMethod = init?.method ?? '';
        return new Response(JSON.stringify({ admitted: 1 }), { status: 200 });
      },
    );

    assert.equal(refilled, true);
    assert.equal(requestedUrl, 'http://queue:3003/events/23/queue/admit-next');
    assert.equal(requestedToken, 'internal-token');
    assert.equal(requestedMethod, 'POST');
  });

  it('stays disabled unless both the queue URL and internal token are configured', async () => {
    assert.equal(await requestQueueRefill(23, '', 'internal-token'), false);
    assert.equal(await requestQueueRefill(23, 'http://queue:3003', ''), false);
  });

  it('rejects a failed refill so the caller can log and use the scheduler fallback', async () => {
    await assert.rejects(
      requestQueueRefill(
        23,
        'http://queue:3003',
        'internal-token',
        async () => new Response(null, { status: 503 }),
      ),
      /queue_refill_failed:503/,
    );
  });
});
