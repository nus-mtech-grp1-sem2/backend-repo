// Opt-in, stateful load test against the deployed OneStage application.
//
// This test deliberately writes persistent synthetic data to the selected
// environment. It creates one clearly labelled GA event and exercises the
// real queue -> admission -> order -> simulated-payment -> ticket path. It
// never deletes the event or its related rows.

import exec from "k6/execution";
import http from "k6/http";
import secrets from "k6/secrets";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const DEFAULT_BASE_URL = "https://d3vlw6jnm44c4l.cloudfront.net";
const COGNITO_REGION = "ap-southeast-1";
const COGNITO_CLIENT_ID = "gh94lqsterju3qoffje1grep8";
const COGNITO_SECRET_NAME = "onestage-k6-users";
const EXPECTED_USER_COUNT = 22;
const MAX_BUYER_VUS = EXPECTED_USER_COUNT - 1;
const MAX_ITERATIONS_PER_BUYER = 20;

function boundedPositiveInteger(value, fallback, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

const buyerVUs = boundedPositiveInteger(__ENV.K6_LIVE_BUYER_VUS, 10, MAX_BUYER_VUS, "K6_LIVE_BUYER_VUS");
const iterationsPerBuyer = boundedPositiveInteger(
  __ENV.K6_LIVE_ITERATIONS_PER_BUYER,
  3,
  MAX_ITERATIONS_PER_BUYER,
  "K6_LIVE_ITERATIONS_PER_BUYER",
);
const expectedJourneys = buyerVUs * iterationsPerBuyer;

const completedBuyerJourneys = new Counter("completed_live_buyer_journeys");
const liveWriteSuccess = new Rate("live_write_success");
const ticketIssuanceVerified = new Rate("ticket_issuance_verified");
const unexpectedServerError = new Rate("unexpected_server_error");
const requestIdSuccess = new Rate("request_id_success");
const cognitoAuthSuccess = new Rate("cognito_auth_success");
const cognitoAuthDuration = new Trend("cognito_auth_duration", true);

export const options = {
  setupTimeout: "2m",
  teardownTimeout: "90s",
  cloud: {
    name: __ENV.K6_TEST_NAME || "OneStage live stateful buyer journey",
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
    live_buyer_journey: {
      executor: "per-vu-iterations",
      vus: buyerVUs,
      iterations: iterationsPerBuyer,
      maxDuration: "10m",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: [
      { threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "30s" },
      "rate<0.01",
    ],
    http_req_duration: ["p(95)<5000"],
    "http_req_duration{stage:queue_join}": ["p(95)<3000"],
    "http_req_duration{stage:order_create}": ["p(95)<5000"],
    "http_req_duration{stage:payment}": ["p(95)<5000"],
    completed_live_buyer_journeys: [`count==${expectedJourneys}`],
    live_write_success: ["rate==1"],
    ticket_issuance_verified: ["rate==1"],
    unexpected_server_error: ["rate==0"],
    request_id_success: ["rate==1"],
    cognito_auth_success: ["rate==1"],
    cognito_auth_duration: ["p(95)<3000"],
    dropped_iterations: ["count==0"],
  },
};

function baseUrl() {
  const value = (__ENV.K6_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (!value.startsWith("https://")) {
    throw new Error("K6_BASE_URL must use HTTPS for the live stateful test");
  }
  return value;
}

function runId() {
  const value = (__ENV.K6_RUN_ID || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value)) {
    throw new Error("K6_RUN_ID is required and must contain 3-64 letters, digits, dots, underscores, or hyphens");
  }
  return value;
}

function assertLiveWriteOptIn() {
  if (__ENV.K6_ALLOW_LIVE_WRITES !== "CONFIRMED") {
    throw new Error("refusing live writes: set K6_ALLOW_LIVE_WRITES=CONFIRMED");
  }
  const target = baseUrl();
  if (target !== DEFAULT_BASE_URL && __ENV.K6_ALLOW_NON_DEFAULT_TARGET !== "CONFIRMED") {
    throw new Error("refusing non-default target: set K6_ALLOW_NON_DEFAULT_TARGET=CONFIRMED after reviewing it");
  }
}

function parseJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function validateCredentials(rawSecret) {
  let credentials;
  try {
    credentials = JSON.parse(rawSecret);
  } catch {
    throw new Error(`${COGNITO_SECRET_NAME} must contain valid JSON`);
  }
  if (!Array.isArray(credentials) || credentials.length !== EXPECTED_USER_COUNT) {
    throw new Error(`${COGNITO_SECRET_NAME} must contain exactly ${EXPECTED_USER_COUNT} users`);
  }
  const usernames = new Set();
  credentials.forEach((credential, index) => {
    if (!credential || typeof credential.username !== "string" || !credential.username.trim()) {
      throw new Error(`synthetic user ${index + 1} has no username`);
    }
    if (typeof credential.password !== "string" || !credential.password) {
      throw new Error(`synthetic user ${index + 1} has no password`);
    }
    if (usernames.has(credential.username)) {
      throw new Error(`synthetic user ${index + 1} duplicates a username`);
    }
    usernames.add(credential.username);
  });
  return credentials;
}

function authenticateCredential(credential, index) {
  const startedAt = Date.now();
  const response = http.post(
    `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
    JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: credential.username,
        PASSWORD: credential.password,
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      tags: { endpoint_type: "cognito", name: "cognito_initiate_auth" },
      responseType: "text",
      responseCallback: http.expectedStatuses(200),
      timeout: "10s",
    },
  );
  cognitoAuthDuration.add(Date.now() - startedAt);
  const token = parseJson(response)?.AuthenticationResult?.AccessToken;
  const ok = response.status === 200 && typeof token === "string" && token.length > 0;
  cognitoAuthSuccess.add(ok, { user_index: String(index + 1) });
  check(response, { "Cognito authentication succeeds": () => ok });
  if (!ok) throw new Error(`Cognito authentication failed for synthetic user ${index + 1} (HTTP ${response.status})`);
  return token;
}

function requestParams(stage, token, expectedStatuses, json = false) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    },
    tags: { endpoint_type: "live_stateful", stage, name: stage },
    responseType: "text",
    responseCallback: http.expectedStatuses(...expectedStatuses),
    timeout: "15s",
  };
}

function recordResponse(response, expectedStatuses, label, write = false) {
  const statusOk = expectedStatuses.includes(response.status);
  const requestIdOk = Boolean(response.headers["X-Request-Id"]);
  unexpectedServerError.add(response.status >= 500, { stage: label });
  requestIdSuccess.add(requestIdOk, { stage: label });
  if (write) liveWriteSuccess.add(statusOk, { stage: label });
  check(response, {
    [`${label}: expected status`]: () => statusOk,
    [`${label}: request id returned`]: () => requestIdOk,
  });
  return statusOk;
}

function requireSuccess(response, expectedStatuses, label, write = false) {
  if (recordResponse(response, expectedStatuses, label, write)) return parseJson(response);
  const body = String(response.body || "").slice(0, 500);
  throw new Error(`${label} failed (HTTP ${response.status}): ${body}`);
}

function postJson(path, body, token, stage, expectedStatuses = [200]) {
  return http.post(`${baseUrl()}${path}`, JSON.stringify(body), requestParams(stage, token, expectedStatuses, true));
}

function putJson(path, body, token, stage, expectedStatuses = [200]) {
  return http.put(`${baseUrl()}${path}`, JSON.stringify(body), requestParams(stage, token, expectedStatuses, true));
}

export async function setup() {
  assertLiveWriteOptIn();
  const id = runId();
  const rawSecret = await secrets.get(COGNITO_SECRET_NAME);
  const credentials = validateCredentials(rawSecret);
  const tokens = credentials.map((credential, index) => authenticateCredential(credential, index));
  const organiserToken = tokens[0];
  const buyerTokens = tokens.slice(1, buyerVUs + 1);
  const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const inventoryQuantity = expectedJourneys + 10;

  const create = postJson(
    "/api/event/events",
    {
      title: `[K6 TEST DATA - RETAIN] ${id}`,
      description: `Persistent synthetic live-load data. Run ID: ${id}. Do not treat as a real event.`,
      venue: "K6 Synthetic Load Test",
      startsAt,
      tier: "TIER1_GA",
    },
    organiserToken,
    "setup_event_create",
    [201],
  );
  const eventId = Number(requireSuccess(create, [201], "setup event create", true)?.eventId);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error("created event has an invalid eventId");

  const inventory = putJson(
    `/api/inventory/events/${eventId}/inventory`,
    {
      gridRows: 1,
      gridCols: 1,
      zones: [{
        name: "K6 General Admission",
        price: 0,
        color: "#2563EB",
        gridRow: 0,
        gridCol: 0,
        gridRowSpan: 1,
        gridColSpan: 1,
        quantity: inventoryQuantity,
      }],
    },
    organiserToken,
    "setup_inventory",
    [204],
  );
  requireSuccess(inventory, [204], "setup inventory", true);

  const buyers = putJson(
    `/api/event/events/${eventId}/available-buyers`,
    { availableBuyers: buyerVUs },
    organiserToken,
    "setup_available_buyers",
    [204],
  );
  requireSuccess(buyers, [204], "setup available buyers", true);

  const publish = http.post(
    `${baseUrl()}/api/event/events/${eventId}/publish`,
    null,
    requestParams("setup_publish", organiserToken, [204]),
  );
  requireSuccess(publish, [204], "setup publish", true);

  const queueConfig = putJson(
    `/api/queue/events/${eventId}/queue/config`,
    {
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      admissionBatchSize: buyerVUs,
      admissionIntervalSec: 1,
    },
    organiserToken,
    "setup_queue",
    [200],
  );
  requireSuccess(queueConfig, [200], "setup queue", true);

  const zones = http.get(
    `${baseUrl()}/api/inventory/events/${eventId}/zones`,
    requestParams("setup_zones", organiserToken, [200]),
  );
  const zonesBody = requireSuccess(zones, [200], "setup zones");
  const inventoryItemId = Number(zonesBody?.zones?.[0]?.inventoryItemId);
  if (!Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error("created inventory has an invalid inventoryItemId");
  }

  return { runId: id, eventId, inventoryItemId, organiserToken, buyerTokens, iterationsPerBuyer };
}

function waitForAdmission(data, buyerToken) {
  // A public organiser call makes the test deterministic even if the service's
  // periodic admission sweep is delayed. Concurrent calls may legitimately
  // hit the one-second admission cadence and return 429.
  const admit = http.post(
    `${baseUrl()}/api/queue/events/${data.eventId}/queue/admit-next`,
    null,
    requestParams("queue_admit", data.organiserToken, [200, 429]),
  );
  recordResponse(admit, [200, 429], "queue admit", true);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = http.get(
      `${baseUrl()}/api/queue/events/${data.eventId}/queue/me`,
      requestParams("queue_status", buyerToken, [200]),
    );
    const body = parseJson(status);
    const admitted = status.status === 200 && body?.status === "ADMITTED" &&
      typeof body.admissionToken === "string" && body.admissionToken.length > 0;
    if (admitted) {
      recordResponse(status, [200], "queue status");
      return body.admissionToken;
    }
    if (status.status !== 200) {
      recordResponse(status, [200], "queue status");
      return "";
    }
    sleep(0.5);
  }
  check(null, { "queue admission completes within 30 seconds": () => false });
  return "";
}

export default function liveBuyerJourney(data) {
  const buyerIndex = exec.vu.idInTest - 1;
  const buyerToken = data.buyerTokens[buyerIndex];
  if (!buyerToken) throw new Error(`no synthetic buyer token allocated to VU ${exec.vu.idInTest}`);

  const join = http.post(
    `${baseUrl()}/api/queue/events/${data.eventId}/queue/join`,
    null,
    requestParams("queue_join", buyerToken, [200, 201]),
  );
  const joined = recordResponse(join, [200, 201], "queue join", true);
  const admissionToken = joined ? waitForAdmission(data, buyerToken) : "";

  const create = admissionToken
    ? postJson(
        "/api/order/orders",
        {
          eventId: data.eventId,
          inventoryItemId: data.inventoryItemId,
          quantity: 1,
          admissionToken,
          customerEmail: `k6-${data.runId}-${buyerIndex + 1}@example.invalid`,
          customerName: `K6 Synthetic Buyer ${buyerIndex + 1}`,
        },
        buyerToken,
        "order_create",
        [201],
      )
    : null;
  const createOk = create !== null && recordResponse(create, [201], "order create", true);
  const orderId = createOk ? Number(parseJson(create)?.order?.order_id) : 0;
  const validOrderId = Number.isSafeInteger(orderId) && orderId > 0;

  const payment = validOrderId
    ? postJson(
        `/api/order/orders/${orderId}/payment`,
        { paymentToken: "simulated" },
        buyerToken,
        "payment",
        [200],
      )
    : null;
  const paymentBody = payment ? parseJson(payment) : null;
  const paid = payment !== null && recordResponse(payment, [200], "payment", true) && paymentBody?.order?.status === "PAID";

  completedBuyerJourneys.add(paid ? 1 : 0);
  check(payment, {
    "buyer completes queue-to-paid journey": () => joined && Boolean(admissionToken) && createOk && validOrderId && paid,
  });
}

function eventTicketCount(response, eventId) {
  const tickets = parseJson(response)?.tickets;
  if (!Array.isArray(tickets)) return -1;
  return tickets.filter((ticket) => Number(ticket.event_id) === eventId).length;
}

export function teardown(data) {
  const expectedPerBuyer = data.iterationsPerBuyer;
  const verified = new Array(data.buyerTokens.length).fill(false);
  let lastResponses = [];

  // OrderPaid is intentionally delayed on SQS, so allow one minute for the
  // existing ticket worker to issue and persist every ticket.
  for (let attempt = 0; attempt < 12 && verified.some((value) => !value); attempt += 1) {
    const requests = data.buyerTokens.map((token) => [
      "GET",
      `${baseUrl()}/api/ticket/customers/me/tickets`,
      null,
      requestParams("ticket_reconciliation", token, [200]),
    ]);
    lastResponses = http.batch(requests);
    lastResponses.forEach((response, index) => {
      if (response.status === 200 && eventTicketCount(response, data.eventId) === expectedPerBuyer) verified[index] = true;
    });
    if (verified.some((value) => !value)) sleep(5);
  }

  verified.forEach((ok, index) => {
    const response = lastResponses[index];
    if (response) recordResponse(response, [200], "ticket reconciliation");
    ticketIssuanceVerified.add(ok, { user_index: String(index + 1) });
    check(response, { "paid journeys issue the expected retained tickets": () => ok });
  });
}
