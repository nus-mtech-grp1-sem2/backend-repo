import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const joined = new Counter('queue_joined');

export const options = {
  scenarios: {
    queue_capacity: { executor: 'shared-iterations', vus: 20, iterations: 100, maxDuration: '45s' },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<1500'],
    queue_joined: ['count==100'],
  },
};

const baseUrl = (__ENV.K6_QUEUE_URL || 'http://127.0.0.1:3103').replace(/\/$/, '');
const eventId = Number(__ENV.K6_EVENT_ID);

export default function queueCapacity() {
  const customer = `q-${exec.scenario.iterationInTest}`;
  const response = http.post(`${baseUrl}/events/${eventId}/queue/join`, null, {
    headers: { Authorization: `Bearer test-token:${customer}` },
    timeout: '5s',
    tags: { stage: 'B1_queue_join' },
  });
  const valid = response.status === 201 && Number(response.json('position')) > 0;
  joined.add(valid ? 1 : 0);
  check(response, { 'buyer joins queue exactly once': () => valid });
}
