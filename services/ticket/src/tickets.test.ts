import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type mysql from 'mysql2/promise';
// test-helpers MUST be imported first: it forces NODE_ENV=test and loads
// real DB creds from .env before index.ts's top-level code runs (which
// reads process.env once, at import time, to build its DB pool and decide
// whether to bind the real port).
import {
  fakeVerifier,
  authHeader,
  createEventFixture,
  createOrderFixture,
  createTicketFixture,
  destroyFixture,
  checkoutPool,
  eventInventoryPool,
  queuePool,
  ticketingPool,
} from './test-helpers.js';
import {
  app,
  database,
  __setVerifierForTests,
  issueTicketsForOrder,
  loadEventCancellation,
  loadOrderConfirmation,
  reconcileCancelledEvents,
  reconcilePaidOrders,
} from './index.js';

__setVerifierForTests(fakeVerifier);

let baseUrl: string;
let server: Server;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  // fetch() keeps its connection alive by default, which stalls server.close()
  // until the keep-alive socket times out; force it closed immediately instead.
  server.closeAllConnections();
  await closed;
  await Promise.all([eventInventoryPool.end(), ticketingPool.end(), checkoutPool.end(), queuePool.end(), database.end()]);
});

async function createOrderItemFixture(orderId: number, description: string, quantity: number): Promise<number> {
  const [result] = await checkoutPool.execute<mysql.ResultSetHeader>(
    'INSERT INTO order_items (order_id, inventory_item_id, description, quantity, unit_price_cents) VALUES (?, 1, ?, ?, ?)',
    [orderId, description, quantity, 12500],
  );
  return result.insertId;
}

test('customer can fetch their own issued tickets, but not another customer\'s', async () => {
  const fixture = await createEventFixture();
  try {
    await createTicketFixture({ eventId: fixture.eventId, customerSub: 'customer-1' });
    await createTicketFixture({ eventId: fixture.eventId, customerSub: 'customer-1', status: 'CHECKED_IN' });
    await createTicketFixture({ eventId: fixture.eventId, customerSub: 'customer-2' });

    const res = await fetch(`${baseUrl}/customers/me/tickets`, {
      headers: { ...authHeader('customer-1') },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tickets.length, 2);
    for (const ticket of body.tickets) {
      assert.equal(ticket.event_id, fixture.eventId);
      assert.ok(['ISSUED', 'CHECKED_IN'].includes(ticket.status));
      assert.equal(typeof ticket.qr_token, 'string');
      assert.equal(typeof ticket.event_title, 'string');
    }

    await createTicketFixture({ eventId: fixture.eventId, customerSub: fixture.organiserSub });
    const organiserResponse = await fetch(`${baseUrl}/customers/me/tickets`, {
      headers: { ...authHeader(fixture.organiserSub) },
    });
    assert.equal(organiserResponse.status, 200);
    const organiserBody = await organiserResponse.json();
    assert.equal(organiserBody.tickets.length, 1);
    assert.equal(organiserBody.tickets[0].event_id, fixture.eventId);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('loads a paid order confirmation with live ticket details and excludes void tickets', async () => {
  const fixture = await createEventFixture();
  try {
    const customerSub = `confirmation-${fixture.eventId}`;
    const orderId = await createOrderFixture({ eventId: fixture.eventId, customerSub, totalAmountCents: 12500 });
    const orderItemId = await createOrderItemFixture(orderId, 'Reserved seating', 2);
    const issuedTicketId = await createTicketFixture({ eventId: fixture.eventId, customerSub, orderId, orderItemId });
    await createTicketFixture({ eventId: fixture.eventId, customerSub, orderId, orderItemId, status: 'VOID' });

    const confirmation = await loadOrderConfirmation(orderId);
    assert.ok(confirmation);
    assert.equal(confirmation.orderId, orderId);
    assert.equal(confirmation.customerSub, customerSub);
    assert.equal(confirmation.customerEmail, `${customerSub}@test.example`);
    assert.match(confirmation.event.title, /^TDD-TEST-EVENT-/);
    assert.equal(confirmation.event.venue, 'Test Venue');
    assert.ok(Number.isFinite(Date.parse(confirmation.event.startsAt)));
    assert.deepEqual(confirmation.order, { totalAmountCents: 12500, currency: 'SGD' });
    assert.equal(confirmation.tickets.length, 1);
    const [ticket] = confirmation.tickets;
    assert.ok(ticket);
    assert.equal(ticket.ticketId, issuedTicketId);
    assert.match(ticket.qrToken, /^tdd-qr-/);
    assert.equal(ticket.description, 'Reserved seating');
    assert.equal(ticket.seatLabel, null);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('does not prepare a confirmation for an unpaid order or one with no live tickets', async () => {
  const fixture = await createEventFixture();
  try {
    const unpaidOrderId = await createOrderFixture({
      eventId: fixture.eventId,
      customerSub: `unpaid-${fixture.eventId}`,
      status: 'PENDING',
    });
    assert.equal(await loadOrderConfirmation(unpaidOrderId), null);

    const voidedCustomerSub = `voided-${fixture.eventId}`;
    const voidedOrderId = await createOrderFixture({ eventId: fixture.eventId, customerSub: voidedCustomerSub });
    const orderItemId = await createOrderItemFixture(voidedOrderId, 'General admission', 1);
    await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: voidedCustomerSub,
      orderId: voidedOrderId,
      orderItemId,
      status: 'VOID',
    });
    assert.equal(await loadOrderConfirmation(voidedOrderId), null);
    assert.equal(await loadOrderConfirmation(999999999), null);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('general-admission tickets are numbered 1, 2, 3... within their own section, across orders', async () => {
  const fixture = await createEventFixture();
  const sections: number[] = [];
  try {
    for (const name of ['Standing Floor', 'Balcony']) {
      const [section] = await eventInventoryPool.execute<mysql.ResultSetHeader>(
        'INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES (?, ?, 100, 5000)',
        [fixture.eventId, name],
      );
      sections.push(section.insertId);
    }
    const [floor, balcony] = sections as [number, number];
    const paidOrder = async (customerSub: string, items: [number, number][]) => {
      const orderId = await createOrderFixture({ eventId: fixture.eventId, customerSub });
      await checkoutPool.execute(
        'UPDATE orders SET paid_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 MINUTE) WHERE order_id = ?',
        [orderId],
      );
      for (const [section, quantity] of items) {
        await checkoutPool.execute(
          'INSERT INTO order_items (order_id, inventory_item_id, description, quantity, unit_price_cents) VALUES (?, ?, ?, ?, 5000)',
          [orderId, section, 'General admission', quantity],
        );
      }
      return orderId;
    };
    const numbers = async (orderId: number) => {
      const [rows] = await ticketingPool.query<mysql.RowDataPacket[]>(
        'SELECT section_item_id, section_seat_number FROM tickets WHERE order_id = ? ORDER BY ticket_id',
        [orderId],
      );
      return rows.map((row) => [Number(row.section_item_id), Number(row.section_seat_number)]);
    };

    const first = await paidOrder(`ga-numbers-a-${fixture.eventId}`, [[floor, 2], [balcony, 1]]);
    assert.deepEqual(await issueTicketsForOrder(first), { issued: 3, alreadyIssued: false });
    assert.deepEqual(await numbers(first), [[floor, 1], [floor, 2], [balcony, 1]]);

    // The next buyer in the same section carries on where the last one stopped.
    const second = await paidOrder(`ga-numbers-b-${fixture.eventId}`, [[floor, 2]]);
    await issueTicketsForOrder(second);
    assert.deepEqual(await numbers(second), [[floor, 3], [floor, 4]]);

    // A replay issues nothing new and uses up no numbers.
    assert.deepEqual(await issueTicketsForOrder(first), { issued: 0, alreadyIssued: true });
    const third = await paidOrder(`ga-numbers-c-${fixture.eventId}`, [[floor, 1]]);
    await issueTicketsForOrder(third);
    assert.deepEqual(await numbers(third), [[floor, 5]]);

    // Two orders issued at the same moment take turns on the section's counter.
    const racing = await Promise.all([
      paidOrder(`ga-numbers-d-${fixture.eventId}`, [[floor, 2]]),
      paidOrder(`ga-numbers-e-${fixture.eventId}`, [[floor, 2]]),
    ]);
    await Promise.all(racing.map((orderId) => issueTicketsForOrder(orderId)));
    const raced = [...(await numbers(racing[0])), ...(await numbers(racing[1]))].map(([, n]) => n);
    assert.deepEqual(raced.sort((a, b) => a - b), [6, 7, 8, 9]);

    // Everywhere a ticket is shown, its seat uses the reserved-seat-style section letter and number.
    const confirmation = await loadOrderConfirmation(first);
    assert.deepEqual(
      confirmation?.tickets.map((ticket) => ticket.seatLabel),
      ['A1', 'A2', 'B1'],
    );
  } finally {
    await destroyFixture(fixture.eventId);
    for (const section of sections) {
      await ticketingPool.execute('DELETE FROM ga_section_counters WHERE inventory_item_id = ?', [section]);
    }
  }
});

test('real ticket issuance fills only missing quantities and leaves tickets unchanged on replay', async () => {
  const fixture = await createEventFixture();
  try {
    const customerSub = `issuance-${fixture.eventId}`;
    const orderId = await createOrderFixture({ eventId: fixture.eventId, customerSub });
    const orderItemId = await createOrderItemFixture(orderId, 'General admission', 3);
    const existingTicketId = await createTicketFixture({ eventId: fixture.eventId, customerSub, orderId, orderItemId });
    await checkoutPool.execute(
      "UPDATE orders SET paid_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 MINUTE), customer_name = '  Test Buyer  ' WHERE order_id = ?",
      [orderId],
    );

    assert.deepEqual(await issueTicketsForOrder(orderId), { issued: 2, alreadyIssued: false });
    const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT ticket_id, order_id, order_item_id, event_id, customer_sub, customer_email, customer_name, seat_id, qr_token, status FROM tickets WHERE order_id = ? ORDER BY ticket_id',
      [orderId],
    );
    assert.equal(tickets.length, 3);
    assert.equal(Number(tickets[0]?.ticket_id), existingTicketId);
    assert.equal(new Set(tickets.map((ticket) => ticket.qr_token)).size, 3);
    for (const ticket of tickets.slice(1)) {
      assert.equal(Number(ticket.order_id), orderId);
      assert.equal(Number(ticket.order_item_id), orderItemId);
      assert.equal(Number(ticket.event_id), fixture.eventId);
      assert.equal(ticket.customer_sub, customerSub);
      assert.equal(ticket.customer_email, `${customerSub}@test.example`);
      assert.equal(ticket.customer_name, 'Test Buyer');
      assert.equal(ticket.seat_id, null);
      assert.equal(ticket.status, 'ISSUED');
      assert.match(String(ticket.qr_token), /^[A-Za-z0-9_-]{43}$/);
    }

    assert.deepEqual(await issueTicketsForOrder(orderId), { issued: 0, alreadyIssued: true });
    const [replayedTickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT ticket_id, order_id, order_item_id, event_id, customer_sub, customer_email, customer_name, seat_id, qr_token, status FROM tickets WHERE order_id = ? ORDER BY ticket_id',
      [orderId],
    );
    assert.deepEqual(replayedTickets, tickets);

    const [locks] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT IS_FREE_LOCK(?) AS available',
      [`ticket-order-${orderId}`],
    );
    assert.equal(Number(locks[0]?.available), 1);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('paid-order recovery selects missing and partial tickets oldest first while respecting the batch limit', async () => {
  const fixture = await createEventFixture();
  try {
    const scenarios = [
      { name: 'missing', status: 'PAID' as const, existingTickets: 0, paidAgeSeconds: 180 },
      { name: 'partial', status: 'PAID' as const, existingTickets: 1, paidAgeSeconds: 120 },
      { name: 'complete', status: 'PAID' as const, existingTickets: 2, paidAgeSeconds: 60 },
      { name: 'unpaid', status: 'PENDING' as const, existingTickets: 0, paidAgeSeconds: 0 },
      { name: 'recent', status: 'PAID' as const, existingTickets: 0, paidAgeSeconds: 0 },
    ];
    const orderIds = new Map<string, number>();
    for (const scenario of scenarios) {
      const customerSub = `recovery-${scenario.name}-${fixture.eventId}`;
      const orderId = await createOrderFixture({ eventId: fixture.eventId, customerSub, status: scenario.status });
      const orderItemId = await createOrderItemFixture(orderId, 'General admission', 2);
      orderIds.set(scenario.name, orderId);
      if (scenario.status === 'PAID') {
        await checkoutPool.execute(
          'UPDATE orders SET paid_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? SECOND) WHERE order_id = ?',
          [scenario.paidAgeSeconds, orderId],
        );
      }
      for (let ticketIndex = 0; ticketIndex < scenario.existingTickets; ticketIndex += 1) {
        await createTicketFixture({ eventId: fixture.eventId, customerSub, orderId, orderItemId });
      }
    }

    const attemptedOrderIds: number[] = [];
    const issue = async (orderId: number) => {
      attemptedOrderIds.push(orderId);
      return { issued: 0, alreadyIssued: false };
    };

    assert.deepEqual(await reconcilePaidOrders(1, undefined, issue), {
      matchedOrders: 1,
      issuedTickets: 0,
      failedOrders: 0,
    });
    assert.deepEqual(attemptedOrderIds, [orderIds.get('missing')]);

    attemptedOrderIds.length = 0;
    assert.deepEqual(await reconcilePaidOrders(50, undefined, issue), {
      matchedOrders: 2,
      issuedTickets: 0,
      failedOrders: 0,
    });
    assert.deepEqual(attemptedOrderIds, [orderIds.get('missing'), orderIds.get('partial')]);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('cancellation reconciliation settles late tickets and paid orders once while preserving other records', async () => {
  const fixture = await createEventFixture();
  const publishedFixture = await createEventFixture();
  try {
    const paidOrderId = await createOrderFixture({ eventId: fixture.eventId, customerSub: `late-paid-${fixture.eventId}` });
    const pendingOrderId = await createOrderFixture({
      eventId: fixture.eventId,
      customerSub: `late-pending-${fixture.eventId}`,
      status: 'PENDING',
    });
    const issuedTicketId = await createTicketFixture({ eventId: fixture.eventId, customerSub: 'late-issued', orderId: paidOrderId });
    const checkedInTicketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: 'late-checked-in',
      orderId: paidOrderId,
      status: 'CHECKED_IN',
    });
    const voidTicketId = await createTicketFixture({ eventId: fixture.eventId, customerSub: 'already-void', orderId: paidOrderId, status: 'VOID' });
    const publishedOrderId = await createOrderFixture({ eventId: publishedFixture.eventId, customerSub: `published-${publishedFixture.eventId}` });
    const publishedTicketId = await createTicketFixture({ eventId: publishedFixture.eventId, customerSub: 'published-ticket', orderId: publishedOrderId });
    const [beforeOrders] = await checkoutPool.query<mysql.RowDataPacket[]>(
      'SELECT paid_at FROM orders WHERE order_id = ?',
      [paidOrderId],
    );
    await eventInventoryPool.execute("UPDATE events SET status = 'CANCELLED' WHERE event_id = ?", [fixture.eventId]);

    const result = await reconcileCancelledEvents(50, undefined, undefined, undefined, '');
    assert.deepEqual(result, { voidedTickets: 2, refundedOrders: 1, matchedOrders: 0, notifiedOrders: 0 });

    const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT ticket_id, status FROM tickets WHERE event_id IN (?, ?)',
      [fixture.eventId, publishedFixture.eventId],
    );
    const ticketStatuses = new Map(tickets.map((ticket) => [Number(ticket.ticket_id), ticket.status]));
    assert.equal(ticketStatuses.get(issuedTicketId), 'VOID');
    assert.equal(ticketStatuses.get(checkedInTicketId), 'VOID');
    assert.equal(ticketStatuses.get(voidTicketId), 'VOID');
    assert.equal(ticketStatuses.get(publishedTicketId), 'ISSUED');

    const [orders] = await checkoutPool.query<mysql.RowDataPacket[]>(
      'SELECT order_id, status, paid_at FROM orders WHERE event_id IN (?, ?)',
      [fixture.eventId, publishedFixture.eventId],
    );
    const savedOrders = new Map(orders.map((order) => [Number(order.order_id), order]));
    assert.equal(savedOrders.get(paidOrderId)?.status, 'CANCELLED');
    assert.deepEqual(savedOrders.get(paidOrderId)?.paid_at, beforeOrders[0]?.paid_at);
    assert.equal(savedOrders.get(pendingOrderId)?.status, 'PENDING');
    assert.equal(savedOrders.get(pendingOrderId)?.paid_at, null);
    assert.equal(savedOrders.get(publishedOrderId)?.status, 'PAID');

    assert.deepEqual(await reconcileCancelledEvents(50, undefined, undefined, undefined, ''), {
      voidedTickets: 0,
      refundedOrders: 0,
      matchedOrders: 0,
      notifiedOrders: 0,
    });
  } finally {
    await destroyFixture(publishedFixture.eventId);
    await destroyFixture(fixture.eventId);
  }
});

test('cancellation email selection excludes unpaid orders and all previously recorded cancellations', async () => {
  const fixture = await createEventFixture();
  try {
    const customerSub = `selection-${fixture.eventId}`;
    const eligibleOrderId = await createOrderFixture({ eventId: fixture.eventId, customerSub, status: 'CANCELLED' });
    const unpaidOrderId = await createOrderFixture({ eventId: fixture.eventId, customerSub, status: 'CANCELLED' });
    await checkoutPool.execute('UPDATE orders SET paid_at = NULL WHERE order_id = ?', [unpaidOrderId]);
    await createOrderFixture({ eventId: fixture.eventId, customerSub, status: 'PAID' });

    for (const status of ['PENDING', 'SENT', 'FAILED']) {
      const orderId = await createOrderFixture({ eventId: fixture.eventId, customerSub, status: 'CANCELLED' });
      await database.execute(
        `INSERT INTO notification.email_notifications
           (order_id, ticket_id, event_id, customer_sub, customer_email, type, status, subject)
         VALUES (?, NULL, ?, ?, ?, 'EVENT_CANCELLATION', ?, 'Test cancellation')`,
        [orderId, fixture.eventId, customerSub, `${customerSub}@test.example`, status],
      );
    }

    const notifiedOrderIds: number[] = [];
    const settle = async () => ({ voidedTickets: 0, refundedOrders: 0 });
    const notify = async (orderId: number) => {
      notifiedOrderIds.push(orderId);
      await database.execute(
        `INSERT INTO notification.email_notifications
           (order_id, ticket_id, event_id, customer_sub, customer_email, type, status, subject)
         VALUES (?, NULL, ?, ?, ?, 'EVENT_CANCELLATION', 'PENDING', 'Test cancellation')`,
        [orderId, fixture.eventId, customerSub, `${customerSub}@test.example`],
      );
      return true;
    };

    const result = await reconcileCancelledEvents(50, settle, undefined, notify, 'http://notification.test');
    assert.deepEqual(notifiedOrderIds, [eligibleOrderId]);
    assert.deepEqual(result, { voidedTickets: 0, refundedOrders: 0, matchedOrders: 1, notifiedOrders: 1 });

    assert.deepEqual(await reconcileCancelledEvents(50, settle, undefined, notify, 'http://notification.test'), {
      voidedTickets: 0,
      refundedOrders: 0,
      matchedOrders: 0,
      notifiedOrders: 0,
    });
    assert.deepEqual(notifiedOrderIds, [eligibleOrderId]);
  } finally {
    await database.execute('DELETE FROM notification.email_notifications WHERE event_id = ?', [fixture.eventId]);
    await destroyFixture(fixture.eventId);
  }
});

test('loads a cancelled paid order refund and sums its order-item quantities', async () => {
  const fixture = await createEventFixture();
  try {
    const customerSub = `cancelled-${fixture.eventId}`;
    const orderId = await createOrderFixture({
      eventId: fixture.eventId,
      customerSub,
      status: 'CANCELLED',
      totalAmountCents: 22500,
    });
    await createOrderItemFixture(orderId, 'General admission', 2);
    await createOrderItemFixture(orderId, 'Reserved seating', 1);

    const cancellation = await loadEventCancellation(orderId);
    assert.ok(cancellation);
    assert.equal(cancellation.orderId, orderId);
    assert.equal(cancellation.eventId, fixture.eventId);
    assert.equal(cancellation.customerSub, customerSub);
    assert.equal(cancellation.customerEmail, `${customerSub}@test.example`);
    assert.match(cancellation.event.title, /^TDD-TEST-EVENT-/);
    assert.equal(cancellation.event.venue, 'Test Venue');
    assert.ok(Number.isFinite(Date.parse(cancellation.event.startsAt)));
    assert.equal(cancellation.ticketCount, 3);
    assert.deepEqual(cancellation.refund, { amountCents: 22500, currency: 'SGD' });
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('does not prepare a cancellation email for an order without a paid timestamp', async () => {
  const fixture = await createEventFixture();
  try {
    const orderId = await createOrderFixture({
      eventId: fixture.eventId,
      customerSub: `unpaid-cancelled-${fixture.eventId}`,
      status: 'CANCELLED',
    });
    await checkoutPool.execute('UPDATE orders SET paid_at = NULL WHERE order_id = ?', [orderId]);

    assert.equal(await loadEventCancellation(orderId), null);
    assert.equal(await loadEventCancellation(999999999), null);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
