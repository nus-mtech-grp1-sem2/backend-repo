import exec from "k6/execution";
import http from "k6/http";
import secrets from "k6/secrets";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const DEFAULT_BASE_URL = "https://d3vlw6jnm44c4l.cloudfront.net";
const COGNITO_REGION = "ap-southeast-1";
const COGNITO_CLIENT_ID = "gh94lqsterju3qoffje1grep8";
const COGNITO_SECRET_NAME = "onestage-k6-users";
const EXPECTED_USER_COUNT = 22;

const functionalSuccess = new Rate("functional_success");
const securitySuccess = new Rate("security_success");
const correlationIdSuccess = new Rate("correlation_id_success");
const cognitoAuthSuccess = new Rate("cognito_auth_success");
const cognitoAuthDuration = new Trend("cognito_auth_duration", true);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function baseUrl() {
  const value = (__ENV.K6_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (!value.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) {
    throw new Error("K6_BASE_URL must use HTTPS unless it targets localhost");
  }
  return value;
}

function cloudOptions(name) {
  return {
    name,
    stackID: positiveInteger(__ENV.K6_CLOUD_STACK_ID, 1607186),
    projectID: positiveInteger(__ENV.K6_CLOUD_PROJECT_ID, 8484325),
    distribution: {
      singapore: {
        loadZone: __ENV.K6_LOAD_ZONE || "amazon:sg:singapore",
        percent: 100,
      },
    },
  };
}

const thresholds = {
  http_req_failed: [
    { threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "30s" },
    "rate<0.01",
  ],
  http_req_duration: ["p(95)<2000"],
  "http_req_duration{endpoint_type:health}": ["p(95)<1000"],
  "http_req_duration{endpoint_type:public}": ["p(95)<1500"],
  "http_req_duration{endpoint_type:authenticated}": ["p(95)<2000"],
  functional_success: ["rate==1"],
  security_success: ["rate==1"],
  correlation_id_success: ["rate==1"],
  cognito_auth_success: ["rate==1"],
  cognito_auth_duration: ["p(95)<2000"],
  dropped_iterations: ["count==0"],
};

export function deploymentOptions() {
  return {
    cloud: cloudOptions("OneStage read-only deployment gate"),
    discardResponseBodies: false,
    scenarios: {
      read_only: {
        executor: "ramping-vus",
        startVUs: 0,
        gracefulStop: "0s",
        gracefulRampDown: "0s",
        stages: [
          { target: 10, duration: "30s" },
          { target: 10, duration: "1m" },
          { target: 50, duration: "1m" },
          { target: 50, duration: "2m" },
          { target: 0, duration: "30s" },
        ],
      },
    },
    thresholds,
  };
}

export function manualOptions() {
  return {
    cloud: cloudOptions("OneStage read-only manual"),
    discardResponseBodies: false,
    scenarios: {
      read_only: {
        executor: "ramping-vus",
        startVUs: 0,
        gracefulStop: "0s",
        gracefulRampDown: "0s",
        stages: [
          { target: 10, duration: "1m" },
          { target: 10, duration: "2m" },
          { target: 50, duration: "2m" },
          { target: 50, duration: "8m" },
          { target: 0, duration: "2m" },
        ],
      },
    },
    thresholds,
  };
}

export const options = __ENV.K6_PROFILE === "deployment" ? deploymentOptions() : manualOptions();

function parseJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function recordResponse(response, expectedStatus, label, metric = functionalSuccess) {
  const statusOk = response.status === expectedStatus;
  const requestIdOk = Boolean(response.headers["X-Request-Id"]);
  metric.add(statusOk, { check: label });
  correlationIdSuccess.add(requestIdOk, { check: label });
  check(response, {
    [`${label}: status ${expectedStatus}`]: () => statusOk,
    [`${label}: request id returned`]: () => requestIdOk,
  });
  return statusOk;
}

function requestParams(endpointType, name, token = null, expectedStatuses = null) {
  const params = {
    tags: { endpoint_type: endpointType, name },
    timeout: "10s",
  };
  if (token) params.headers = { Authorization: `Bearer ${token}` };
  if (expectedStatuses) params.responseCallback = http.expectedStatuses(...expectedStatuses);
  return params;
}

function jsonRequestParams(endpointType, name, token = null, expectedStatuses = null) {
  const params = requestParams(endpointType, name, token, expectedStatuses);
  params.headers = params.headers
    ? { ...params.headers, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
  return params;
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

export async function setup() {
  const rawSecret = await secrets.get(COGNITO_SECRET_NAME);
  const credentials = validateCredentials(rawSecret);
  const tokens = credentials.map((credential, index) => authenticateCredential(credential, index));

  const response = http.get(
    `${baseUrl()}/api/event/events`,
    requestParams("public", "event_list_setup", null, [200]),
  );
  if (!recordResponse(response, 200, "event list setup")) {
    throw new Error(`event fixture discovery failed (HTTP ${response.status})`);
  }
  const body = parseJson(response);
  const events = body && Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) throw new Error("at least one published event is required for the read-only suite");

  const seated = events.find((event) => event.event_type === "TIER2_SEATED");
  const eventId = Number(events[0].event_id);
  const seatedEventId = seated ? Number(seated.event_id) : null;
  if (!Number.isInteger(eventId) || eventId <= 0) throw new Error("published event fixture has an invalid ID");
  if (seated && (!Number.isInteger(seatedEventId) || seatedEventId <= 0)) {
    throw new Error("published seated-event fixture has an invalid ID");
  }
  return {
    tokens,
    eventId,
    seatedEventId,
  };
}

function healthJourney() {
  const services = ["event", "auth", "inventory", "queue", "order", "ticket"];
  const responses = http.batch(
    services.map((service) => [
      "GET",
      `${baseUrl()}/api/${service}/health`,
      null,
      requestParams("health", `${service}_health`, null, [200]),
    ]),
  );
  responses.forEach((response, index) => recordResponse(response, 200, `${services[index]} health`));
}

function publicJourney(data) {
  const listResponses = http.batch([
    ["GET", `${baseUrl()}/api/event/events`, null, requestParams("public", "event_list", null, [200])],
    ["GET", `${baseUrl()}/api/event/venues`, null, requestParams("public", "venue_list", null, [200])],
    ["GET", `${baseUrl()}/api/event/events/${data.eventId}`, null, requestParams("public", "event_detail", null, [200])],
  ]);
  recordResponse(listResponses[0], 200, "event list");
  recordResponse(listResponses[1], 200, "venue list");
  recordResponse(listResponses[2], 200, "event detail");
}

function authenticatedJourney(data, token) {
  const requests = [
    ["GET", `${baseUrl()}/api/ticket/customers/me/tickets`, null, requestParams("authenticated", "customer_tickets", token, [200])],
    ["GET", `${baseUrl()}/api/inventory/events/${data.eventId}/zones`, null, requestParams("authenticated", "booking_zones", token, [200])],
  ];
  if (data.seatedEventId) {
    requests.push([
      "GET",
      `${baseUrl()}/api/inventory/events/${data.seatedEventId}/seats`,
      null,
      requestParams("authenticated", "seat_inventory", token, [200]),
    ]);
  }
  const responses = http.batch(requests);
  recordResponse(responses[0], 200, "customer tickets");
  recordResponse(responses[1], 200, "booking zones");
  if (data.seatedEventId) recordResponse(responses[2], 200, "seat inventory");

  const tickets = parseJson(responses[0]);
  const firstTicket = Array.isArray(tickets?.tickets) ? tickets.tickets[0] : null;
  if (firstTicket?.ticket_id) {
    const detail = http.get(
      `${baseUrl()}/api/ticket/tickets/${firstTicket.ticket_id}`,
      requestParams("authenticated", "ticket_detail", token, [200]),
    );
    recordResponse(detail, 200, "ticket detail");
  }
}

function queueBookingGuardJourney(data, token) {
  const emptyBody = JSON.stringify({});
  const responses = http.batch([
    ["GET", `${baseUrl()}/api/queue/events/not-an-event/queue/me`, null, requestParams("security", "queue_me_invalid_event", token, [400])],
    ["POST", `${baseUrl()}/api/queue/events/${data.eventId}/queue/join`, emptyBody, jsonRequestParams("security", "queue_join_unauthenticated", null, [401])],
    ["POST", `${baseUrl()}/api/inventory/events/${data.eventId}/holds`, emptyBody, jsonRequestParams("security", "hold_unauthenticated", null, [401])],
    ["POST", `${baseUrl()}/api/order/orders`, emptyBody, jsonRequestParams("security", "order_create_unauthenticated", null, [401])],
    ["POST", `${baseUrl()}/api/order/orders/1/payment`, emptyBody, jsonRequestParams("security", "payment_unauthenticated", null, [401])],
    ["GET", `${baseUrl()}/api/order/orders/not-an-order`, null, requestParams("security", "order_detail_invalid_id", token, [400])],
  ]);
  recordResponse(responses[0], 400, "queue position rejects invalid event", securitySuccess);
  recordResponse(responses[1], 401, "queue join rejects anonymous", securitySuccess);
  recordResponse(responses[2], 401, "hold rejects anonymous", securitySuccess);
  recordResponse(responses[3], 401, "order creation rejects anonymous", securitySuccess);
  recordResponse(responses[4], 401, "payment rejects anonymous", securitySuccess);
  recordResponse(responses[5], 400, "order detail rejects invalid ID", securitySuccess);
}

function securityJourney() {
  const responses = http.batch([
    ["GET", `${baseUrl()}/api/order/customers/me/orders`, null, requestParams("security", "orders_unauthenticated", null, [401])],
    ["GET", `${baseUrl()}/api/ticket/customers/me/tickets`, null, requestParams("security", "tickets_unauthenticated", null, [401])],
  ]);
  recordResponse(responses[0], 401, "orders reject anonymous", securitySuccess);
  recordResponse(responses[1], 401, "tickets reject anonymous", securitySuccess);
}

export default function readOnlySuite(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const journey = exec.scenario.iterationInTest % 5;
  if (journey === 0) healthJourney();
  else if (journey === 1) publicJourney(data);
  else if (journey === 2) authenticatedJourney(data, token);
  else if (journey === 3) securityJourney();
  else queueBookingGuardJourney(data, token);
  sleep(1);
}
