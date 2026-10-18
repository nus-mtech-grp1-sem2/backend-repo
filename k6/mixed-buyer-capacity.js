import exec from 'k6/execution';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const joined = new Counter('mixed_joined_buyers');
const paid = new Counter('mixed_paid_orders');
const failures = new Counter('mixed_buyer_failures');

export const options = {
  scenarios: {
    checkout: { executor: 'shared-iterations', exec: 'checkout', vus: 20, iterations: 200, maxDuration: '60s' },
    join: { executor: 'shared-iterations', exec: 'join', vus: 100, iterations: 300, maxDuration: '60s' },
    admission: { executor: 'shared-iterations', exec: 'admit', vus: 1, iterations: 100, maxDuration: '60s' },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<5000'],
    mixed_joined_buyers: ['count==300'],
    mixed_paid_orders: ['count==200'],
    mixed_buyer_failures: ['count==0'],
  },
};

const queueUrl = (__ENV.K6_QUEUE_URL || 'http://127.0.0.1:3103').replace(/\/$/, '');
const orderUrl = (__ENV.K6_ORDER_URL || 'http://127.0.0.1:3104').replace(/\/$/, '');
const eventId = Number(__ENV.K6_EVENT_ID);
const inventoryItemId = Number(__ENV.K6_INVENTORY_ITEM_ID);

function params(customer, stage) {
  return {
    headers: { Authorization: `Bearer test-token:${customer}`, 'Content-Type': 'application/json' },
    timeout: '15s', tags: { stage },
  };
}

export function join() {
  const customer = `mixed-join-${exec.scenario.iterationInTest}`;
  const response = http.post(`${queueUrl}/events/${eventId}/queue/join`, null, params(customer, 'mixed_join'));
  const valid = response.status === 201;
  joined.add(valid ? 1 : 0);
  failures.add(valid ? 0 : 1);
  check(response, { 'mixed buyer joins successfully': () => valid });
}

export function checkout() {
  const customer = `mixed-${exec.scenario.iterationInTest}`;
  const create = http.post(`${orderUrl}/orders`, JSON.stringify({
    eventId, inventoryItemId, quantity: 1, admissionToken: `k6-admission-${customer}`,
  }), params(customer, 'mixed_create'));
  let orderId = 0;
  try { orderId = Number(create.json('order.order_id')); } catch { /* checked below */ }
  const payment = create.status === 201 && Number.isSafeInteger(orderId) && orderId > 0
    ? http.post(`${orderUrl}/orders/${orderId}/payment`, JSON.stringify({ paymentToken: 'simulated' }), params(customer, 'mixed_pay'))
    : create;
  let status = '';
  try { status = payment.json('order.status'); } catch { /* checked below */ }
  const valid = create.status === 201 && payment.status === 200 && status === 'PAID';
  paid.add(valid ? 1 : 0);
  failures.add(valid ? 0 : 1);
  check(payment, { 'mixed buyer creates and pays an order': () => valid });
}

export function admit() {
  const response = http.post(`${queueUrl}/events/${eventId}/queue/admit-next`, null, {
    headers: { 'x-internal-token': __ENV.K6_INTERNAL_TOKEN }, timeout: '15s', tags: { stage: 'mixed_admit' },
  });
  failures.add(response.status === 200 ? 0 : 1);
  check(response, { 'mixed admission succeeds': r => r.status === 200 });
  sleep(0.02);
}
