import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const completed = new Counter('completed_buyer_journeys');

export const options = {
  scenarios: {
    small_end_to_end: { executor: 'shared-iterations', vus: 1, iterations: 10, maxDuration: '60s' },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2500'],
    completed_buyer_journeys: ['count==10'],
  },
};

const queueUrl = (__ENV.K6_QUEUE_URL || 'http://127.0.0.1:3103').replace(/\/$/, '');
const orderUrl = (__ENV.K6_ORDER_URL || 'http://127.0.0.1:3104').replace(/\/$/, '');
const eventId = Number(__ENV.K6_EVENT_ID);
const seats = (__ENV.K6_SEAT_IDS || '').split(',').map(Number);

export default function buyerJourney() {
  const iteration = exec.scenario.iterationInTest;
  const customer = `e-${iteration}`;
  const auth = { Authorization: `Bearer test-token:${customer}` };
  const json = { ...auth, 'Content-Type': 'application/json' };
  const join = http.post(`${queueUrl}/events/${eventId}/queue/join`, null, {
    headers: auth, timeout: '5s', tags: { stage: 'A_queue' },
  });
  const admit = http.post(`${queueUrl}/events/${eventId}/queue/admit-next`, null, {
    headers: { 'x-internal-token': __ENV.K6_INTERNAL_TOKEN }, timeout: '5s', tags: { stage: 'A_admit' },
  });
  const status = http.get(`${queueUrl}/events/${eventId}/queue/me`, {
    headers: auth, timeout: '5s', tags: { stage: 'A_queue_status' },
  });
  let admissionToken = '';
  try { admissionToken = String(status.json('admissionToken') || ''); } catch { /* classified below */ }
  const create = http.post(`${orderUrl}/orders`, JSON.stringify({
    eventId, quantity: 1, seatIds: [seats[iteration]], admissionToken, customerName: customer,
  }), { headers: json, timeout: '8s', tags: { stage: 'A_booking' } });
  let orderId = 0;
  try { orderId = Number(create.json('order.order_id')); } catch { /* classified below */ }
  const paid = Number.isSafeInteger(orderId) && orderId > 0
    ? http.post(`${orderUrl}/orders/${orderId}/payment`, JSON.stringify({ paymentToken: 'simulated' }), {
        headers: json, timeout: '8s', tags: { stage: 'A_payment' },
      })
    : create;
  let paidStatus = '';
  try { paidStatus = String(paid.json('order.status')); } catch { /* classified below */ }
  const valid = join.status === 201 && admit.status === 200 && status.status === 200 &&
    admissionToken.length > 0 && create.status === 201 && paid.status === 200 && paidStatus === 'PAID';
  completed.add(valid ? 1 : 0);
  check(paid, { 'buyer completes queue-to-paid journey': () => valid });
}
