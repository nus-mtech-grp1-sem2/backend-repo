import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

const db = installOfflineServices(mock, {
  env: { DB_NAME: 'ticketing', TICKET_INTERNAL_SHARED_SECRET: 'offline-secret', NOTIFICATION_SERVICE_URL: '', ORDER_EVENTS_QUEUE_URL: '' },
  claims: (token) => ({ sub: token }),
});
const { app, issueTickets, issueTicketsForOrder, reconcilePaidOrders, TicketIssuanceDeferred } = await import('./index.js');

describe('ticket issuance delay', () => {
  let server: TestServer;
  before(async () => { server = await startServer(app); });
  after(() => server.close());
  beforeEach(() => db.reset());
  const event = {
    type: 'OrderPaid' as const, version: 1 as const, orderId: 42, eventId: 5,
    customerSub: 'alice', customerEmail: 'alice@example.com', customerName: 'Alice Tan',
    items: [{ orderItemId: 7, seatId: null, quantity: 2 }],
  };

  function script(age: number | null, status = 'PAID', existing = 0, seatId: number | null = null) {
    db.on(/AS paid_age_ms/, [{ status, paid_age_ms: age }]);
    db.on(/GET_LOCK/, [{ acquired: 1 }]);
    db.on(/RELEASE_LOCK/, []);
    db.on(/FROM checkout.orders WHERE order_id = \? FOR UPDATE/, [{ order_id: 42, status, event_id: 5, customer_sub: 'alice', customer_email: 'alice@example.com', customer_name: 'Alice Tan' }]);
    db.on(/FROM checkout.order_items/, [{ order_item_id: 7, inventory_item_id: 3, quantity: seatId === null ? 2 : 1, seat_id: seatId }]);
    db.on(/INSERT INTO ticketing\.ga_section_counters/, { affectedRows: 1 });
    db.on(/SELECT LAST_INSERT_ID\(\) AS seat_number/, [{ seat_number: 12 }]);
    db.on(/SELECT order_item_id FROM tickets/, Array.from({ length: existing }, () => ({ order_item_id: 7 })));
    db.on(/SELECT COUNT\(\*\) AS count/, [{ count: existing }]);
    db.on(/INSERT INTO (ticketing\.)?tickets/, { affectedRows: 1 });
  }

  for (const path of ['message', 'internal'] as const) {
    const issue = () => path === 'message' ? issueTickets(event) : issueTicketsForOrder(42);
    it(`${path} waits until ten seconds after payment without holding transaction locks`, async () => {
      script(9_999);
      await assert.rejects(issue(), (error: unknown) => error instanceof TicketIssuanceDeferred && error.retryAfterMs === 1);
      assert.equal(db.calls.length, 1);
      assert.match(db.calls[0]!.sql, /CURRENT_TIMESTAMP\(3\)/);
    });

    it(`${path} issues both tickets once the delay has elapsed`, async () => {
      script(10_000);
      await issue();
      const inserts = db.calls.filter((call) => /INSERT INTO (ticketing\.)?tickets/.test(call.sql));
      assert.equal(inserts.length, 2);
      for (const insert of inserts) {
        assert.match(insert.sql, /customer_email, customer_name,/);
        assert.equal(insert.params[5], 'Alice Tan', 'the buyer name is stored on every ticket');
        assert.equal(insert.params[7], 3, 'a general-admission ticket is numbered in its section');
        assert.equal(insert.params[8], 12, 'and gets the number the section counter handed out');
      }
      const numbersTaken = db.calls.filter((call) => /INSERT INTO ticketing\.ga_section_counters/.test(call.sql));
      assert.deepEqual(numbersTaken.map((call) => call.params), [[3], [3]], 'one number per ticket, from the same section');
      assert.ok(db.calls.some((call) => call.sql === 'COMMIT'));
    });

    it(`${path} leaves a seated ticket unnumbered: it already has a real seat`, async () => {
      script(10_000, 'PAID', 0, 55);
      await (path === 'message'
        ? issueTickets({ ...event, items: [{ orderItemId: 7, seatId: 55, quantity: 1 }] })
        : issueTicketsForOrder(42));
      const [insert] = db.calls.filter((call) => /INSERT INTO (ticketing\.)?tickets/.test(call.sql));
      assert.deepEqual([insert?.params[6], insert?.params[7], insert?.params[8]], [55, null, null]);
      assert.equal(db.calls.some((call) => /ga_section_counters/.test(call.sql)), false);
    });

    it(`${path} does not restart the delay or duplicate tickets on replay`, async () => {
      script(60_000, 'PAID', 2);
      await issue();
      assert.equal(db.calls.some((call) => /INSERT INTO/.test(call.sql)), false);
    });

    it(`${path} rejects unpaid orders and unknown payment times`, async () => {
      script(60_000, 'PENDING');
      await assert.rejects(issue(), /order_not_paid/);
      db.reset(); script(null);
      await assert.rejects(issue(), /invalid_payment_time/);
      assert.equal(db.calls.some((call) => /INSERT INTO/.test(call.sql)), false);
    });
  }

  it('filters recent payments out of the reconciliation query', async () => {
    db.on(/SELECT o.order_id, MIN\(o.paid_at\)/, []);
    await reconcilePaidOrders(25);
    assert.match(db.calls[0]!.sql, /TIMESTAMPDIFF\(MICROSECOND, o.paid_at, CURRENT_TIMESTAMP\(3\)\) >= \?/);
    assert.deepEqual(db.calls[0]!.params, [10_000_000, 25]);
  });

  it('returns 202 for local issuance while the paid order is still within the buffer', async () => {
    script(0);
    const response = await fetch(`${server.base}/internal/orders/42/issue-tickets`, { method: 'POST', headers: { 'x-ticket-internal-secret': 'offline-secret' } });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { issued: 0, alreadyIssued: false, status: 'PENDING', retryAfterMs: 10_000 });
    assert.equal(db.calls.some((call) => /INSERT INTO/.test(call.sql)), false);
  });

  it('loads customer tickets with GA section labels when migration 18 is installed', async () => {
    db.on(/t\.section_seat_number/, [{
      ticket_id: 7, order_id: 42, seat_label: null,
      section_seat_number: 12, section_position: 27, ga_number_missing: 0,
    }]);

    const response = await fetch(`${server.base}/customers/me/tickets`, {
      headers: { authorization: 'Bearer alice' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tickets: [{ ticket_id: 7, order_id: 42, seat_label: 'AA12' }],
    });
    assert.equal(db.calls.length, 1);
    assert.deepEqual(db.calls[0]?.params, ['alice']);
  });

  it('still loads existing customer tickets before migration 18 is installed', async () => {
    const missingColumn = Object.assign(new Error('Unknown column section_seat_number'), {
      code: 'ER_BAD_FIELD_ERROR',
    });
    db.on(/t\.section_seat_number/, missingColumn);
    db.on(/ROW_NUMBER\(\) OVER/, [{
      ticket_id: 7, order_id: 42, seat_label: null,
      section_seat_number: 12, section_position: 27,
    }]);
    const warned = mock.method(console, 'warn', () => undefined);
    try {
      const response = await fetch(`${server.base}/customers/me/tickets`, {
        headers: { authorization: 'Bearer alice' },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        tickets: [{ ticket_id: 7, order_id: 42, seat_label: 'AA12' }],
      });
      assert.equal(db.calls.length, 2);
      assert.equal(warned.mock.callCount(), 1);
    } finally {
      warned.mock.restore();
    }
  });

  it('derives a section number for tickets issued before the numbering migration', async () => {
    db.on(/t\.section_seat_number/, [{
      ticket_id: 7, order_id: 42, seat_label: null,
      section_seat_number: null, section_position: null, ga_number_missing: 1,
    }]);
    db.on(/ROW_NUMBER\(\) OVER/, [{
      ticket_id: 7, order_id: 42, seat_label: null,
      section_seat_number: 12, section_position: 27,
    }]);

    const response = await fetch(`${server.base}/customers/me/tickets`, {
      headers: { authorization: 'Bearer alice' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tickets: [{ ticket_id: 7, order_id: 42, seat_label: 'AA12' }],
    });
    assert.equal(db.calls.length, 2);
  });
});
