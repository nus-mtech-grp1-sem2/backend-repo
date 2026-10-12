import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const paidOrders = new Counter('paid_orders');

export const options = {
  scenarios: {
    checkout_capacity: { executor: 'shared-iterations', vus: 5, iterations: 50, maxDuration: '60s' },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2000'],
    paid_orders: ['count==50'],
  },
};

const baseUrl = (__ENV.K6_ORDER_URL || 'http://127.0.0.1:3104').replace(/\/$/, '');
const eventId = Number(__ENV.K6_EVENT_ID);
const inventoryItemId = Number(__ENV.K6_INVENTORY_ITEM_ID);

export default function checkoutCapacity() {
  const customer = `c-${exec.scenario.iterationInTest}`;
  const params = {
    headers: {
      Authorization: `Bearer test-token:${customer}`,
      'Content-Type': 'application/json',
    },
    timeout: '8s',
  };
  const create = http.post(`${baseUrl}/orders`, JSON.stringify({
    eventId, inventoryItemId, quantity: 1, customerName: customer,
  }), { ...params, tags: { stage: 'B2_checkout_create' } });
  let orderId = 0;
  try { orderId = Number(create.json('order.order_id')); } catch { /* classified by the check below */ }
  const paid = Number.isSafeInteger(orderId) && orderId > 0
    ? http.post(`${baseUrl}/orders/${orderId}/payment`, JSON.stringify({ paymentToken: 'simulated' }), {
        ...params, tags: { stage: 'B2_checkout_pay' },
      })
    : create;
  let paidStatus = '';
  try { paidStatus = String(paid.json('order.status')); } catch { /* classified by the check below */ }
  const valid = create.status === 201 && paid.status === 200 && paidStatus === 'PAID';
  paidOrders.add(valid ? 1 : 0);
  check(paid, { 'order is created and paid with simulator': () => valid });
}
