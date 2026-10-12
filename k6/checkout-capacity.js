import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const baselinePaid = new Counter('baseline_paid_orders');
const probeAttempts = new Counter('contention_probe_attempts');
const probePaid = new Counter('contention_probe_paid_orders');
const probeFailures = new Counter('contention_probe_retryable_failures');
const unexpected = new Counter('unexpected_checkout_responses');

export const options = {
  scenarios: {
    sequential_baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 50,
      maxDuration: '30s',
    },
    contention_probe: {
      executor: 'shared-iterations',
      vus: 3,
      iterations: 30,
      startTime: '3s',
      maxDuration: '30s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2000'],
    baseline_paid_orders: ['count==50'],
    contention_probe_attempts: ['count==30'],
    unexpected_checkout_responses: ['count==0'],
  },
};

const baseUrl = (__ENV.K6_ORDER_URL || 'http://127.0.0.1:3104').replace(/\/$/, '');
const eventId = Number(__ENV.K6_EVENT_ID);
const inventoryItemId = Number(__ENV.K6_INVENTORY_ITEM_ID);

export default function checkoutCapacity() {
  const probe = exec.scenario.name === 'contention_probe';
  const customer = `${probe ? 'probe' : 'base'}-${exec.scenario.iterationInTest}`;
  const expected = probe ? http.expectedStatuses(200, 201, 502) : undefined;
  const params = {
    headers: {
      Authorization: `Bearer test-token:${customer}`,
      'Content-Type': 'application/json',
    },
    timeout: '8s',
    ...(expected ? { responseCallback: expected } : {}),
  };
  const create = http.post(
    `${baseUrl}/orders`,
    JSON.stringify({ eventId, inventoryItemId, quantity: 1, customerName: customer }),
    { ...params, tags: { stage: probe ? 'B2_contention_create' : 'B2_baseline_create' } },
  );
  let orderId = 0;
  try {
    orderId = Number(create.json('order.order_id'));
  } catch {
    // Classified below without logging response bodies.
  }
  const paid =
    Number.isSafeInteger(orderId) && orderId > 0
      ? http.post(
          `${baseUrl}/orders/${orderId}/payment`,
          JSON.stringify({ paymentToken: 'simulated' }),
          { ...params, tags: { stage: probe ? 'B2_contention_pay' : 'B2_baseline_pay' } },
        )
      : create;
  let paidStatus = '';
  try {
    paidStatus = String(paid.json('order.status'));
  } catch {
    // Classified below without logging response bodies.
  }
  const valid = create.status === 201 && paid.status === 200 && paidStatus === 'PAID';

  if (!probe) {
    baselinePaid.add(valid ? 1 : 0);
    unexpected.add(valid ? 0 : 1);
    check(paid, { 'baseline order is created and paid': () => valid });
    return;
  }

  probeAttempts.add(1);
  probePaid.add(valid ? 1 : 0);
  const retryableFailure = create.status === 502 || (create.status === 201 && paid.status === 502);
  probeFailures.add(retryableFailure ? 1 : 0);
  unexpected.add(valid || retryableFailure ? 0 : 1);
}
