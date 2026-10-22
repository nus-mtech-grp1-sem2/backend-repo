// Read-only application-tier autoscaling demonstration.
//
// This script sends independent, bounded traffic streams through
// CloudFront -> ALB -> Kong to each publicly reachable Node.js service. It is
// intended to demonstrate Kong scaling to its configured ceiling and the
// CPU-based ECS policies scaling Node.js services from one task to at least
// two. Notification is deliberately excluded: it has no Kong route, and its
// real workload sends email and writes notification records. Pre-scale that
// service separately when a two-task topology must be shown.
//
// Safety boundary: every application request below is GET-only. Queue and
// Order use authenticated invalid identifiers that are rejected before their
// database mutation paths. The arrival rates, virtual users, duration and
// request timeout are bounded. Tune rates between runs with the K6_*_RATE
// variables instead of editing the script.

import exec from "k6/execution";
import http from "k6/http";
import secrets from "k6/secrets";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const DEFAULT_BASE_URL = "https://d3vlw6jnm44c4l.cloudfront.net";
const COGNITO_REGION = "ap-southeast-1";
const COGNITO_CLIENT_ID = "gh94lqsterju3qoffje1grep8";
const COGNITO_SECRET_NAME = "onestage-k6-users";
const EXPECTED_USER_COUNT = 22;

const serviceSuccess = new Rate("service_success");
const correlationIdSuccess = new Rate("correlation_id_success");
const unexpectedServerError = new Rate("unexpected_server_error");
const cognitoAuthSuccess = new Rate("cognito_auth_success");
const cognitoAuthDuration = new Trend("cognito_auth_duration", true);

function boundedPositiveInteger(value, fallback, maximum, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}

function baseUrl() {
  const value = (__ENV.K6_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (!value.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) {
    throw new Error("K6_BASE_URL must use HTTPS unless it targets localhost");
  }
  return value;
}

function cloudOptions() {
  return {
    name: "OneStage full-stack read-only scale demo",
    stackID: boundedPositiveInteger(__ENV.K6_CLOUD_STACK_ID, 1607186, 10_000_000, "K6_CLOUD_STACK_ID"),
    projectID: boundedPositiveInteger(__ENV.K6_CLOUD_PROJECT_ID, 8484325, 100_000_000, "K6_CLOUD_PROJECT_ID"),
    distribution: {
      singapore: {
        loadZone: __ENV.K6_LOAD_ZONE || "amazon:sg:singapore",
        percent: 100,
      },
    },
  };
}

function rate(name, fallback) {
  return boundedPositiveInteger(__ENV[`K6_${name.toUpperCase()}_RATE`], fallback, 250, `K6_${name.toUpperCase()}_RATE`);
}

function scenario(service, fallbackRate) {
  return {
    executor: "ramping-arrival-rate",
    exec: `${service}Read`,
    startRate: 1,
    timeUnit: "1s",
    preAllocatedVUs: 10,
    maxVUs: 50,
    gracefulStop: "0s",
    stages: [
      { target: Math.ceil(rate(service, fallbackRate) / 2), duration: "1m" },
      { target: rate(service, fallbackRate), duration: "1m" },
      { target: rate(service, fallbackRate), duration: "6m" },
      { target: 0, duration: "1m" },
    ],
    tags: { service },
  };
}

export const options = {
  cloud: cloudOptions(),
  discardResponseBodies: true,
  scenarios: {
    event: scenario("event", 60),
    inventory: scenario("inventory", 70),
    queue: scenario("queue", 100),
    order: scenario("order", 100),
    ticket: scenario("ticket", 70),
    auth: scenario("auth", 150),
  },
  thresholds: {
    http_req_failed: [
      { threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "45s" },
      "rate<0.01",
    ],
    http_req_duration: ["p(95)<2000"],
    "http_req_duration{service:event}": ["p(95)<2000"],
    "http_req_duration{service:inventory}": ["p(95)<2000"],
    "http_req_duration{service:queue}": ["p(95)<2000"],
    "http_req_duration{service:order}": ["p(95)<2000"],
    "http_req_duration{service:ticket}": ["p(95)<2000"],
    "http_req_duration{service:auth}": ["p(95)<1000"],
    service_success: ["rate==1"],
    unexpected_server_error: ["rate<0.001"],
    correlation_id_success: ["rate==1"],
    cognito_auth_success: ["rate==1"],
    cognito_auth_duration: ["p(95)<2000"],
    dropped_iterations: ["count==0"],
  },
};

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
      timeout: "10s",
    },
  );
  cognitoAuthDuration.add(Date.now() - startedAt);
  const body = parseJson(response);
  const token = body?.AuthenticationResult?.AccessToken;
  const ok = response.status === 200 && typeof token === "string" && token.length > 0;
  cognitoAuthSuccess.add(ok, { user_index: String(index + 1) });
  check(response, { "Cognito authentication succeeds": () => ok });
  if (!ok) throw new Error(`Cognito authentication failed for synthetic user ${index + 1} (HTTP ${response.status})`);
  return token;
}

function requestParams(service, name, expectedStatuses, token = null, keepBody = false) {
  const params = {
    tags: { endpoint_type: "scale_read", service, name },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    timeout: "10s",
  };
  if (token) params.headers = { Authorization: `Bearer ${token}` };
  if (keepBody) params.responseType = "text";
  return params;
}

function recordResponse(response, service, label, expectedStatuses) {
  const statusOk = expectedStatuses.includes(response.status);
  const requestIdOk = Boolean(response.headers["X-Request-Id"]);
  serviceSuccess.add(statusOk, { service });
  unexpectedServerError.add(response.status >= 500, { service });
  correlationIdSuccess.add(requestIdOk, { service });
  check(response, {
    [`${label}: expected status`]: () => statusOk,
    [`${label}: request id returned`]: () => requestIdOk,
  });
}

function tokenFor(data) {
  return data.tokens[(exec.vu.idInTest - 1) % data.tokens.length];
}

export async function setup() {
  const rawSecret = await secrets.get(COGNITO_SECRET_NAME);
  const credentials = validateCredentials(rawSecret);
  const tokens = credentials.map((credential, index) => authenticateCredential(credential, index));

  const response = http.get(
    `${baseUrl()}/api/event/events`,
    requestParams("event", "event_list_setup", [200], null, true),
  );
  recordResponse(response, "event", "event list setup", [200]);
  const body = parseJson(response);
  const events = body && Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) throw new Error("at least one published event is required for the scale demo");
  const eventId = Number(events[0].event_id);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error("published event has an invalid ID");
  return { tokens, eventId };
}

function get(data, service, path, label, expectedStatuses, authenticated = true) {
  const response = http.get(
    `${baseUrl()}${path}`,
    requestParams(service, label, expectedStatuses, authenticated ? tokenFor(data) : null),
  );
  recordResponse(response, service, label, expectedStatuses);
}

export function eventRead(data) {
  get(data, "event", `/api/event/events/${data.eventId}`, "event detail", [200], false);
}

export function inventoryRead(data) {
  get(data, "inventory", `/api/inventory/events/${data.eventId}/zones`, "inventory zones", [200]);
}

export function queueRead(data) {
  get(data, "queue", "/api/queue/events/not-an-event/queue/me", "queue invalid event read", [400]);
}

export function orderRead(data) {
  get(data, "order", "/api/order/orders/not-an-order", "order invalid id read", [400]);
}

export function ticketRead(data) {
  get(data, "ticket", "/api/ticket/customers/me/tickets", "customer tickets", [200]);
}

export function authRead(data) {
  get(data, "auth", "/api/auth/health", "auth health", [200], false);
}
