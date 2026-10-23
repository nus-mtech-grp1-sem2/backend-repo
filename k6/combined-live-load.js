// One-run scalability and stateful-load demonstration.
//
// Six arrival-rate streams drive the deployed read paths while 21 isolated
// synthetic buyers concurrently execute real queue -> order -> simulated
// payment -> ticket journeys. Stateful records are intentionally retained.

import exec from "k6/execution";
import {
  authRead,
  eventRead,
  inventoryRead,
  orderRead,
  queueRead,
  ticketRead,
} from "./full-stack-scale-demo.js";
import liveBuyerJourney, {
  setup as setupLiveJourney,
  teardown as teardownLiveJourney,
} from "./live-stateful-buyer-journey.js";

const MAX_BUYERS = 21;
const READ_VU_CEILING = {
  event: 57,
  inventory: 71,
  queue: 127,
  order: 113,
  ticket: 71,
  auth: 140,
};

function boundedPositiveInteger(value, fallback, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

const buyers = boundedPositiveInteger(__ENV.K6_LIVE_BUYER_VUS, 21, MAX_BUYERS, "K6_LIVE_BUYER_VUS");
const iterationsPerBuyer = boundedPositiveInteger(
  __ENV.K6_LIVE_ITERATIONS_PER_BUYER,
  20,
  20,
  "K6_LIVE_ITERATIONS_PER_BUYER",
);
const expectedJourneys = buyers * iterationsPerBuyer;

function rate(service, fallback) {
  return boundedPositiveInteger(__ENV[`K6_${service.toUpperCase()}_RATE`], fallback, 250, `K6_${service.toUpperCase()}_RATE`);
}

function readScenario(service, fallbackRate) {
  const targetRate = rate(service, fallbackRate);
  return {
    executor: "ramping-arrival-rate",
    exec: `${service}ReadCombined`,
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: READ_VU_CEILING[service],
    maxVUs: READ_VU_CEILING[service],
    gracefulStop: "0s",
    stages: [
      { target: Math.ceil(targetRate / 2), duration: "1m" },
      { target: targetRate, duration: "1m" },
      { target: targetRate, duration: "6m" },
      { target: 0, duration: "1m" },
    ],
    tags: { service, workload: "read_scale" },
  };
}

function statefulScenarios() {
  return Object.fromEntries(Array.from({ length: buyers }, (_, buyerIndex) => {
    const suffix = String(buyerIndex + 1).padStart(2, "0");
    return [`stateful_buyer_${suffix}`, {
      executor: "per-vu-iterations",
      exec: "statefulBuyerCombined",
      vus: 1,
      iterations: iterationsPerBuyer,
      maxDuration: "30m",
      gracefulStop: "30s",
      tags: { service: "buyer_journey", workload: "live_write" },
    }];
  }));
}

export const options = {
  setupTimeout: "2m",
  teardownTimeout: "2m",
  cloud: {
    name: __ENV.K6_TEST_NAME || "OneStage combined read scale and live writes",
    stackID: boundedPositiveInteger(__ENV.K6_CLOUD_STACK_ID, 1607186, 10_000_000, "K6_CLOUD_STACK_ID"),
    projectID: boundedPositiveInteger(__ENV.K6_CLOUD_PROJECT_ID, 8484325, 100_000_000, "K6_CLOUD_PROJECT_ID"),
    distribution: {
      singapore: {
        loadZone: __ENV.K6_LOAD_ZONE || "amazon:sg:singapore",
        percent: 100,
      },
    },
  },
  discardResponseBodies: false,
  scenarios: {
    event: readScenario("event", 100),
    inventory: readScenario("inventory", 125),
    queue: readScenario("queue", 225),
    order: readScenario("order", 200),
    ticket: readScenario("ticket", 125),
    auth: readScenario("auth", 250),
    ...statefulScenarios(),
  },
  thresholds: {
    http_req_failed: [
      { threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "45s" },
      "rate<0.01",
    ],
    http_req_duration: ["p(95)<5000"],
    "http_req_duration{service:event}": ["p(95)<2000"],
    "http_req_duration{service:inventory}": ["p(95)<2000"],
    "http_req_duration{service:queue}": ["p(95)<2000"],
    "http_req_duration{service:order}": ["p(95)<2000"],
    "http_req_duration{service:ticket}": ["p(95)<2000"],
    "http_req_duration{service:auth}": ["p(95)<1000"],
    "http_req_duration{stage:queue_join}": ["p(95)<3000"],
    "http_req_duration{stage:order_create}": ["p(95)<5000"],
    "http_req_duration{stage:payment}": ["p(95)<5000"],
    service_success: ["rate==1"],
    live_write_success: ["rate==1"],
    completed_live_buyer_journeys: [`count==${expectedJourneys}`],
    ticket_issuance_verified: ["rate==1"],
    unexpected_server_error: ["rate<0.001"],
    correlation_id_success: ["rate==1"],
    request_id_success: ["rate==1"],
    cognito_auth_success: ["rate==1"],
    cognito_auth_duration: ["p(95)<3000"],
    dropped_iterations: ["count==0"],
  },
};

export async function setup() {
  const live = await setupLiveJourney();
  return {
    live,
    read: {
      eventId: live.eventId,
      tokens: [live.organiserToken, ...live.buyerTokens],
    },
  };
}

export function eventReadCombined(data) { eventRead(data.read); }
export function inventoryReadCombined(data) { inventoryRead(data.read); }
export function queueReadCombined(data) { queueRead(data.read); }
export function orderReadCombined(data) { orderRead(data.read); }
export function ticketReadCombined(data) { ticketRead(data.read); }
export function authReadCombined(data) { authRead(data.read); }

export function statefulBuyerCombined(data) {
  const match = /^stateful_buyer_(\d+)$/.exec(exec.scenario.name);
  const buyerIndex = match ? Number(match[1]) - 1 : -1;
  if (!Number.isSafeInteger(buyerIndex) || buyerIndex < 0 || buyerIndex >= data.live.buyerTokens.length) {
    throw new Error(`invalid stateful buyer scenario: ${exec.scenario.name}`);
  }
  liveBuyerJourney({ ...data.live, buyerIndex });
}

export function teardown(data) {
  teardownLiveJourney(data.live);
}
