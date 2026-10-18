import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';

const db = installOfflineServices(mock, {
  env: { DB_NAME: 'checkout' },
  claims: (token) => ({ sub: token, email: `${token}@example.com` }),
});
const { calls, on } = db;
const { app, DATABASE_TIMEZONE, RESERVATION_TIMEOUT_MINUTES } = await import('./index.js');

describe('reservation cancellation and expiry', () => {
  let server: TestServer;
  let base = '';

  before(async () => {
    server = await startServer(app);
    base = server.base;
  });
  after(() => server.close());
  beforeEach(() => {
    db.reset();
    on(/SELECT queue_session_id FROM `queue`\.queue_sessions/, [{ queue_session_id: 1 }]);
    on(/SELECT queue_entry_id FROM `queue`\.queue_entries/, [{ queue_entry_id: 99 }]);
    on(/SELECT expires_at FROM event_inventory\.inventory_holds/, [{ expires_at: new Date(Date.now() + 60_000) }]);
  });

  const reservation = (overrides: Record<string, unknown> = {}) => ({
    order_id: 42,
    event_id: 7,
    customer_sub: 'alice',
    order_status: 'PENDING',
    hold_id: 81,
    inventory_item_id: 9,
    quantity: 2,
    hold_status: 'ACTIVE',
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  });

  const scriptRelease = (row = reservation()) => {
    on(/WHERE o\.order_id = \? LIMIT 1 FOR UPDATE/, [row]);
    on(/UPDATE event_inventory\.inventory_items/, { affectedRows: 1 });
    on(/UPDATE event_inventory\.seats/, { affectedRows: 2 });
    on(/UPDATE event_inventory\.inventory_holds SET status/, {
      affectedRows: 1,
    });
    on(/UPDATE orders SET status = 'CANCELLED'/, { affectedRows: 1 });
    on(/UPDATE `queue`\.queue_entries/, { affectedRows: 0 });
  };

  const cancel = (token = 'alice', reason?: 'expired') =>
    fetch(`${base}/orders/42/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });

  it('uses a three-minute reservation window', () => {
    assert.equal(RESERVATION_TIMEOUT_MINUTES, 3);
    assert.equal(DATABASE_TIMEZONE, 'Z');
  });

  it('does not release a live reservation when a client reports an early timeout', async () => {
    on(/WHERE o\.order_id = \? LIMIT 1 FOR UPDATE/, [reservation()]);

    const response = await cancel('alice', 'expired');

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'reservation_not_expired' });
    assert.equal(calls.some((call) => call.sql.includes("orders SET status = 'CANCELLED'")), false);
  });

  it('releases a reservation after the database expiry time', async () => {
    scriptRelease(reservation({ expires_at: new Date(Date.now() - 1_000) }));

    const response = await cancel('alice', 'expired');

    assert.equal(response.status, 204);
    assert.ok(calls.some((call) => call.sql.includes('inventory_holds SET status = ?') && call.params[0] === 'EXPIRED'));
  });

  it('cancels a GA reservation and returns its quantity to inventory', async () => {
    scriptRelease();

    const response = await cancel();

    assert.equal(response.status, 204);
    assert.ok(calls.some((call) => call.sql.startsWith('UPDATE event_inventory.inventory_items') && JSON.stringify(call.params) === JSON.stringify([2, 9, 2])));
    assert.ok(calls.some((call) => call.sql.includes('inventory_holds SET status = ?') && call.params[0] === 'RELEASED'));
    assert.ok(calls.some((call) => call.sql.includes("orders SET status = 'CANCELLED'")));
  });

  it('returns held seats to AVAILABLE when a seated reservation is cancelled', async () => {
    scriptRelease(reservation({ inventory_item_id: null }));

    const response = await cancel();

    assert.equal(response.status, 204);
    assert.ok(calls.some((call) => call.sql.includes("seats SET status = 'AVAILABLE', hold_id = NULL") && call.params[0] === 81));
  });

  it('does not let another customer cancel the reservation', async () => {
    on(/WHERE o\.order_id = \? LIMIT 1 FOR UPDATE/, [reservation()]);

    const response = await cancel('mallory');

    assert.equal(response.status, 403);
    assert.equal(
      calls.some((call) => call.sql.includes("SET status = 'AVAILABLE'")),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("orders SET status = 'CANCELLED'")),
      false,
    );
  });

  it('does not cancel an order that has already been paid', async () => {
    on(/WHERE o\.order_id = \? LIMIT 1 FOR UPDATE/, [reservation({ order_status: 'PAID', hold_status: 'CONFIRMED' })]);

    const response = await cancel();

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'reservation_not_cancellable',
    });
  });

  it("leaves a cancelled event's orders out of the customer's own orders", async () => {
    on(/WHERE o\.status = 'PENDING' AND h\.status = 'ACTIVE'/, []);
    on(/FROM orders o INNER JOIN event_inventory\.events e/, [{ order_id: 42, status: 'PAID' }]);

    const response = await fetch(`${base}/customers/me/orders`, {
      headers: { authorization: 'Bearer alice' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { orders: [{ order_id: 42, status: 'PAID' }] });
    const listing = calls.find((call) => /FROM orders o INNER JOIN event_inventory\.events e/.test(call.sql));
    assert.match(listing?.sql ?? '', /WHERE o\.customer_sub = \? AND e\.status <> 'CANCELLED'/);
    assert.deepEqual(listing?.params, ['alice']);
  });

  for (const settled of ['paid', 'hold extended', 'expired']) {
    it(`rechecks an expiry candidate under locks when it has ${settled}`, async () => {
      const row = reservation({ expires_at: new Date(Date.now() - 1_000) });
      on(/WHERE o\.status = 'PENDING' AND h\.status = 'ACTIVE'/, [row]);
      on(/FROM orders WHERE order_id = \? LIMIT 1 FOR UPDATE/, [{
        order_id: 42, event_id: 7, customer_sub: 'alice', hold_id: 81,
        status: settled === 'paid' ? 'PAID' : 'PENDING',
      }]);
      on(/FROM event_inventory\.inventory_holds WHERE hold_id = \?/, settled === 'expired' ? [{
        hold_id: 81, inventory_item_id: 9, quantity: 2, status: 'ACTIVE', expires_at: row.expires_at,
      }] : []);
      on(/FROM orders o INNER JOIN event_inventory\.events e/, []);
      on(/UPDATE event_inventory\.inventory_items/, { affectedRows: 1 });
      on(/UPDATE event_inventory\.inventory_holds/, { affectedRows: 1 });
      on(/UPDATE orders SET status = 'CANCELLED'/, { affectedRows: 1 });
      on(/UPDATE `queue`\.queue_entries/, { affectedRows: 0 });

      const response = await fetch(`${base}/customers/me/orders`, {
        headers: { authorization: 'Bearer alice' },
      });

      assert.equal(response.status, 200);
      const updates = calls.filter((call) => /^UPDATE/.test(call.sql));
      if (settled === 'expired') {
        assert.ok(updates.some((call) => /SET status = 'CANCELLED'/.test(call.sql)));
        assert.ok(updates.some((call) => call.params[0] === 'EXPIRED'));
      } else {
        assert.deepEqual(updates, [], 'a settled or extended reservation must not be released');
      }
    });
  }
});
