import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';

import {
  app,
  checkinInput,
  createQrToken,
  notifyEventCancelled,
  notifyOrderConfirmed,
  parseOrderPaid,
  parseSearchQuery,
  reconcileCancelledEvents,
  reconcilePaidOrders,
  verifyScannerSession,
} from './index.js';

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
      customerName: '',
      items: [{ orderItemId: 91, seatId: 31, quantity: 1 }],
    });
  });

  it('carries the buyer name, cleaned, and treats a missing or malformed one as blank', () => {
    const base = {
      type: 'OrderPaid', version: 1, orderId: 81, eventId: 12, customerSub: 'customer-123',
      customerEmail: 'customer@example.com', items: [{ order_item_id: 91, seat_id: null, quantity: 1 }],
    };
    assert.equal(parseOrderPaid({ ...base, customerName: ' Ada\u0000  Lovelace ' })?.customerName, 'Ada Lovelace');
    assert.equal(parseOrderPaid({ ...base, customerName: 'x'.repeat(300) })?.customerName.length, 255);
    assert.equal(parseOrderPaid({ ...base, customerName: 42 })?.customerName, '');
    assert.equal(parseOrderPaid(base)?.customerName, '');
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

  it('accepts a short all-digit query as an order ID', () => {
    assert.equal(parseSearchQuery({ q: '7' }), '7');
    assert.equal(parseSearchQuery({ q: ' 82 ' }), '82');
    assert.equal(parseSearchQuery({ q: '8a' }), null);
    assert.equal(parseSearchQuery({ q: '' }), null);
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

  it('reconciles every paid order that is missing tickets', async () => {
    const issuedOrderIds: number[] = [];
    const result = await reconcilePaidOrders(
      25,
      async (limit) => {
        assert.equal(limit, 25);
        return [20, 3];
      },
      async (orderId) => {
        issuedOrderIds.push(orderId);
        return { issued: orderId === 20 ? 1 : 2, alreadyIssued: false };
      },
    );

    assert.deepEqual(issuedOrderIds, [20, 3]);
    assert.deepEqual(result, { matchedOrders: 2, issuedTickets: 3, failedOrders: 0 });
  });

  it('continues reconciling after one order fails', async () => {
    const result = await reconcilePaidOrders(
      50,
      async () => [20, 3],
      async (orderId) => {
        if (orderId === 20) throw new Error('temporary_failure');
        return { issued: 2, alreadyIssued: false };
      },
    );

    assert.deepEqual(result, { matchedOrders: 2, issuedTickets: 2, failedOrders: 1 });
  });
});

describe('booking confirmation email hook', () => {
  const payload = {
    orderId: 42,
    eventId: 7,
    customerSub: 'customer-sub',
    customerEmail: 'buyer@example.com',
    event: { title: 'Event NUS', venue: 'NUS ISS', startsAt: '2026-09-16T16:23:00.000Z' },
    order: { totalAmountCents: 5000, currency: 'SGD' },
    tickets: [{ ticketId: 1, qrToken: 'qr-token', description: 'General Admission', seatLabel: null }],
  };

  it('posts the order confirmation to the notification service', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const requester = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ orderId: 42, notifications: [{ ticketId: 1, status: 'SENT' }] }), { status: 201 });
    }) as typeof fetch;

    const sent = await notifyOrderConfirmed(42, async () => payload, 'http://notification:3006/', requester);

    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://notification:3006/notifications/order-confirmation');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), payload);
  });

  it('logs each ticket whose email failed, but still counts the request as accepted', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    try {
      const requester = (async () =>
        new Response(
          JSON.stringify({
            orderId: 42,
            notifications: [
              { ticketId: 1, status: 'SENT' },
              { ticketId: 2, status: 'FAILED', errorMessage: 'smtp exploded' },
            ],
          }),
          { status: 201 },
        )) as typeof fetch;

      assert.equal(await notifyOrderConfirmed(42, async () => payload, 'http://notification:3006', requester), true);
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0]?.arguments[1], { orderId: 42, ticketId: 2, reason: 'smtp exploded' });
    } finally {
      logged.mock.restore();
    }
  });

  it('does nothing when no notification service is configured', async () => {
    let loaded = false;
    const sent = await notifyOrderConfirmed(
      42,
      async () => {
        loaded = true;
        return payload;
      },
      '',
    );

    assert.equal(sent, false);
    assert.equal(loaded, false);
  });

  it('skips the email when the order has no paid tickets to send', async () => {
    let requested = false;
    const requester = (async () => {
      requested = true;
      return new Response('{}', { status: 201 });
    }) as typeof fetch;

    assert.equal(await notifyOrderConfirmed(42, async () => null, 'http://notification:3006', requester), false);
    assert.equal(requested, false);
  });

  it('never throws, so a failed email cannot undo a paid order', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    try {
      const serverError = (async () => new Response('{}', { status: 500 })) as typeof fetch;
      const unreachable = (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch;

      assert.equal(await notifyOrderConfirmed(42, async () => payload, 'http://notification:3006', serverError), false);
      assert.equal(await notifyOrderConfirmed(42, async () => payload, 'http://notification:3006', unreachable), false);
      assert.equal(
        await notifyOrderConfirmed(42, async () => { throw new Error('db down'); }, 'http://notification:3006'),
        false,
      );
    } finally {
      logged.mock.restore();
    }
  });
});

describe('event cancellation email hook', () => {
  const payload = {
    orderId: 42,
    eventId: 7,
    customerSub: 'customer-sub',
    customerEmail: 'buyer@example.com',
    event: { title: 'Event NUS', venue: 'NUS ISS', startsAt: '2026-09-16T16:23:00.000Z' },
    ticketCount: 2,
    refund: { amountCents: 5000, currency: 'SGD' },
  };

  it('posts the cancellation to the notification service', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const requester = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ orderId: 42, notification: { status: 'SENT' } }), { status: 201 });
    }) as typeof fetch;

    assert.equal(await notifyEventCancelled(42, async () => payload, 'http://notification:3006/', requester), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://notification:3006/notifications/event-cancellation');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), payload);
  });

  it('logs an email that was not delivered, but still counts the request as accepted', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    try {
      const requester = (async () =>
        new Response(JSON.stringify({ notification: { status: 'FAILED', errorMessage: 'smtp exploded' } }), {
          status: 201,
        })) as typeof fetch;
      assert.equal(await notifyEventCancelled(42, async () => payload, 'http://notification:3006', requester), true);
      assert.deepEqual(logged.mock.calls[0]?.arguments[1], { orderId: 42, reason: 'smtp exploded' });
    } finally {
      logged.mock.restore();
    }
  });

  it('sends nothing for an order that is not a paid order of a cancelled event', async () => {
    let requested = false;
    const requester = (async () => {
      requested = true;
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    assert.equal(await notifyEventCancelled(42, async () => null, 'http://notification:3006', requester), false);
    assert.equal(requested, false);
  });

  it('never throws', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    try {
      const serverError = (async () => new Response('{}', { status: 500 })) as typeof fetch;
      assert.equal(await notifyEventCancelled(42, async () => payload, 'http://notification:3006', serverError), false);
      assert.equal(
        await notifyEventCancelled(42, async () => { throw new Error('db down'); }, 'http://notification:3006'),
        false,
      );
    } finally {
      logged.mock.restore();
    }
  });
});

describe('cancelled event sweep', () => {
  it('settles stray tickets and orders, then tells each refunded order that has not been told yet', async () => {
    const notified: number[] = [];
    const result = await reconcileCancelledEvents(
      50,
      async () => ({ voidedTickets: 1, refundedOrders: 1 }),
      async (limit) => {
        assert.equal(limit, 50);
        return [11, 12, 13];
      },
      async (orderId) => {
        notified.push(orderId);
        return orderId !== 12;
      },
      'http://notification:3006',
    );

    assert.deepEqual(notified, [11, 12, 13]);
    assert.deepEqual(result, { voidedTickets: 1, refundedOrders: 1, matchedOrders: 3, notifiedOrders: 2 });
  });

  it('still settles when no notification service is configured, but looks for no one to email', async () => {
    let looked = false;
    const result = await reconcileCancelledEvents(
      50,
      async () => ({ voidedTickets: 4, refundedOrders: 2 }),
      async () => {
        looked = true;
        return [11];
      },
      async () => true,
      '',
    );

    assert.equal(looked, false);
    assert.deepEqual(result, { voidedTickets: 4, refundedOrders: 2, matchedOrders: 0, notifiedOrders: 0 });
  });
});
