import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { installOfflineServices, startServer, type TestServer } from '../../test-support/offline-services.js';
import { consumePayments, enqueuePayment, parsePaymentRequest } from './payment-queue.js';

const db = installOfflineServices(mock, {
  env: { DB_NAME: 'checkout', PAYMENT_REQUESTS_QUEUE_URL: 'https://sqs.invalid/payments', ORDER_EVENTS_QUEUE_URL: 'https://sqs.invalid/tickets', QUEUE_SERVICE_URL: '', INTERNAL_API_TOKEN: '' },
  claims: (token) => ({ sub: token, email: `${token}@example.com` }),
});
const sends: unknown[] = [];
let sendFails = false;
const send = mock.method(SQSClient.prototype, 'send', async (command: unknown) => {
  sends.push(command);
  if (sendFails) throw new Error('offline SQS failure');
  return {};
});
const { app, processPayment, database } = await import('./index.js');

describe('asynchronous mock payments', () => {
  let server: TestServer;
  before(async () => { server = await startServer(app); });
  after(() => server.close());
  beforeEach(() => {
    db.reset(); sends.length = 0; sendFails = false;
    send.mock.mockImplementation(async (command: unknown) => {
      sends.push(command);
      if (sendFails) throw new Error('offline SQS failure');
      return {};
    });
  });
  function scriptOrder(status = 'PENDING', seated = false) {
    db.on(/SELECT queue_session_id FROM `queue`\.queue_sessions/, [{ queue_session_id: 1 }]);
    db.on(/SELECT queue_entry_id FROM `queue`\.queue_entries/, [{ queue_entry_id: 99 }]);
    const order = { order_id: 42, event_id: 5, customer_sub: 'alice', customer_email: 'alice@example.com', customer_name: 'Alice Tan', hold_id: 10, status, total_amount_cents: 4000, currency: 'SGD' };
    db.on(/FROM orders .*order_id = \?/, [order]);
    db.on(/FROM order_items/, []);
    db.on(/FROM payments/, []);
    db.on(/FROM event_inventory\.inventory_holds/, [{ hold_id: 10, inventory_item_id: seated ? null : 9, quantity: 2, status: 'ACTIVE', expires_at: new Date(Date.now() + 60_000) }]);
    db.on(/UPDATE `queue`\.queue_entries/, { affectedRows: 0 });
    db.on(/UPDATE event_inventory\.inventory_items/, { affectedRows: 1 });
    db.on(/UPDATE event_inventory\.seats/, { affectedRows: 2 });
    db.on(/UPDATE event_inventory\.inventory_holds/, { affectedRows: 1 });
    db.on(/INSERT INTO payments/, { affectedRows: 1 });
    db.on(/UPDATE orders/, { affectedRows: 1 });
    return order;
  }
  async function submit(token = 'alice', body: unknown = { paymentToken: 'simulated' }) {
    return fetch(`${server.base}/orders/42/payment-requests`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  it('acknowledges a dedicated delayed command, without capturing payment in the HTTP request', async () => {
    scriptOrder();
    const response = await submit();
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { paymentStatus: string }).paymentStatus, 'PROCESSING');
    const command = sends[0] as SendMessageCommand;
    assert.ok(command instanceof SendMessageCommand);
    assert.equal(command.input.QueueUrl, 'https://sqs.invalid/payments');
    assert.equal(command.input.DelaySeconds, 7);
    assert.deepEqual(JSON.parse(command.input.MessageBody!), { type: 'PaymentRequested', version: 1, orderId: 42, customerSub: 'alice' });
    assert.equal(db.calls.some((call) => /^(INSERT|UPDATE)/.test(call.sql)), false);
  });

  it('requires authentication, ownership, and a fixed mock token', async () => {
    assert.equal((await submit('bad')).status, 401);
    assert.equal((await submit('alice', { paymentToken: 'a-card-number' })).status, 400);
    scriptOrder();
    assert.equal((await submit('bob')).status, 403);
    assert.equal(sends.length, 0);
  });

  it('rejects terminal orders and never falls back to capture when SQS is down', async () => {
    const order = scriptOrder('FAILED');
    assert.equal((await submit()).status, 409);
    order.status = 'CANCELLED';
    assert.equal((await submit()).status, 409);
    order.status = 'PENDING'; sendFails = true;
    assert.equal((await submit()).status, 503);
    assert.equal(db.calls.some((call) => /INSERT INTO payments/.test(call.sql)), false);
  });

  for (const seated of [false, true]) {
    it(`captures ${seated ? 'seated' : 'GA'} inventory once and safely replays a duplicate`, async () => {
      const order = scriptOrder('PENDING', seated);
      assert.equal((await processPayment(42, 'alice', 'simulated')).status, 200);
      order.status = 'PAID';
      assert.equal((await processPayment(42, 'alice', 'simulated')).status, 200);
      assert.equal(db.calls.filter((call) => /INSERT INTO payments/.test(call.sql)).length, 1);
      assert.equal(db.calls.filter((call) => seated ? /UPDATE event_inventory\.seats/.test(call.sql) : /UPDATE event_inventory\.inventory_items/.test(call.sql)).length, 1);
      assert.equal(db.calls.filter((call) => /FROM orders .*FOR UPDATE/.test(call.sql)).length, 2);
      assert.equal(sends.length, 2, 'replay republishes OrderPaid so issuance can recover');
      assert.equal((sends[0] as SendMessageCommand).input.QueueUrl, 'https://sqs.invalid/tickets');
      assert.equal((sends[0] as SendMessageCommand).input.DelaySeconds, 10);
      assert.equal(JSON.parse((sends[0] as SendMessageCommand).input.MessageBody!).customerName, 'Alice Tan');
      for (const call of db.calls.filter((call) => /UPDATE `queue`/.test(call.sql))) {
        assert.match(call.sql, /WHERE queue_entry_id = \? AND status = 'IN_CHECKOUT' AND token_expires_at = \?/);
        assert.doesNotMatch(call.sql, /SELECT|JOIN|queue_session_id/);
        assert.equal(call.params[0], 99);
        assert.ok(call.params[1] instanceof Date, 'a replay retains the checkout-expiry guard');
      }
    });
  }

  it('retries publication after a committed payment without rolling it back or capturing twice', async () => {
    const order = scriptOrder(); sendFails = true;
    assert.equal((await processPayment(42, 'alice', 'simulated')).status, 502);
    assert.equal(db.calls.some((call) => call.sql === 'ROLLBACK'), false);
    order.status = 'PAID'; sendFails = false;
    assert.equal((await processPayment(42, 'alice', 'simulated')).status, 200);
    assert.equal(db.calls.filter((call) => /INSERT INTO payments/.test(call.sql)).length, 1);
  });

  it('retries a payment deadlock before commit and publishes once after success', async (context) => {
    scriptOrder();
    const connection = await database.getConnection();
    const execute = connection.execute.bind(connection);
    let attempts = 0;
    context.mock.method(connection, 'execute', async (sql: string, params: unknown[]) => {
      if (/UPDATE event_inventory\.inventory_items/.test(sql) && attempts++ === 0) {
        throw Object.assign(new Error('deadlock'), { errno: 1213 });
      }
      return execute(sql, params);
    });

    assert.equal((await processPayment(42, 'alice', 'simulated')).status, 200);

    assert.equal(db.calls.filter((call) => call.sql === 'ROLLBACK').length, 1);
    assert.equal(db.calls.filter((call) => call.sql === 'COMMIT').length, 1);
    assert.equal(db.calls.filter((call) => /INSERT INTO payments/.test(call.sql)).length, 1);
    assert.equal(sends.length, 1);
  });

  it('does not retry a committed payment when publication throws a lock-shaped error', async () => {
    scriptOrder();
    send.mock.mockImplementation(async () => {
      throw Object.assign(new Error('publication failed'), { errno: 1213 });
    });

    assert.equal((await processPayment(42, 'alice', 'simulated')).status, 502);

    assert.equal(db.calls.filter((call) => call.sql === 'BEGIN').length, 1);
    assert.equal(db.calls.filter((call) => call.sql === 'COMMIT').length, 1);
    assert.equal(db.calls.filter((call) => call.sql === 'ROLLBACK').length, 0);
    assert.equal(db.calls.filter((call) => /INSERT INTO payments/.test(call.sql)).length, 1);
  });

  it('records expired holds as a terminal failure visible to polling clients', async () => {
    db.on(/FROM event_inventory\.inventory_holds/, [{ hold_id: 10, inventory_item_id: 9, quantity: 2, status: 'ACTIVE', expires_at: new Date(0) }]);
    scriptOrder();
    assert.equal((await processPayment(42, 'alice', 'simulated')).status, 409);
    assert.ok(db.calls.some((call) => /UPDATE orders SET status = 'FAILED'/.test(call.sql)));
    assert.equal(db.calls.some((call) => /INSERT INTO payments/.test(call.sql)), false);
    assert.ok(db.calls.some((call) => /SET reserved_qty = reserved_qty -/.test(call.sql)));
    assert.ok(db.calls.some((call) => /inventory_holds SET status = 'RELEASED'/.test(call.sql)));
  });

  it('validates message type/version and identifiers', () => {
    assert.deepEqual(parsePaymentRequest(JSON.stringify({ type: 'PaymentRequested', version: 1, orderId: 42, customerSub: 'alice' })), { orderId: 42, customerSub: 'alice' });
    for (const body of [undefined, '{', '{}', JSON.stringify({ type: 'OrderPaid', version: 1, orderId: 42, customerSub: 'alice' })]) {
      assert.throws(() => parsePaymentRequest(body));
    }
  });

  it('publishes no card data even if a caller supplies extra object fields', async () => {
    const request = { orderId: 42, customerSub: 'alice', cardNumber: '1234 5678 9012 3456', cvc: '123' };
    await enqueuePayment(new SQSClient({}), 'payments', request);
    assert.deepEqual(Object.keys(JSON.parse((sends[0] as SendMessageCommand).input.MessageBody!)).sort(), ['customerSub', 'orderId', 'type', 'version']);
  });

  for (const outcome of [200, 409, 502, 'invalid'] as const) {
    it(`worker ${outcome === 200 || outcome === 409 ? 'acknowledges' : 'retains'} outcome ${outcome}`, async () => {
      const stop = new AbortController();
      const deleted: unknown[] = [];
      send.mock.mockImplementation(async (command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return { Messages: [{ MessageId: 'offline', ReceiptHandle: 'receipt', Body: outcome === 'invalid' ? '{}' : JSON.stringify({ type: 'PaymentRequested', version: 1, orderId: 42, customerSub: 'alice' }) }] };
        }
        if (command instanceof DeleteMessageCommand) deleted.push(command);
        return {};
      });
      // Invalid messages have no processor callback; abort immediately after receiving them.
      if (outcome === 'invalid') {
        let receives = 0;
        send.mock.mockImplementation(async (command: unknown) => {
          if (command instanceof ReceiveMessageCommand && receives++ === 0) return { Messages: [{ ReceiptHandle: 'receipt', Body: '{}' }] };
          if (command instanceof DeleteMessageCommand) deleted.push(command);
          stop.abort(); return {};
        });
      }
      await consumePayments(new SQSClient({}), 'payments', async () => {
        stop.abort(); return { status: Number(outcome), body: {} };
      }, stop.signal);
      assert.equal(deleted.length, outcome === 200 || outcome === 409 ? 1 : 0);
    });
  }
});
