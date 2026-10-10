import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

const successfulHolds = new Counter("successful_holds");
const capacityRejections = new Counter("capacity_rejections");
const unexpectedResponses = new Counter("unexpected_responses");
const unexpectedServerErrors = new Rate("unexpected_server_errors");

export const options = {
  scenarios: {
    oversell_race: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 50,
      maxDuration: "30s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<2000"],
    successful_holds: ["count==10"],
    capacity_rejections: ["count==40"],
    unexpected_responses: ["count==0"],
    unexpected_server_errors: ["rate==0"],
  },
};

const baseUrl = (__ENV.K6_FIXTURE_URL || "http://127.0.0.1:3002").replace(/\/$/, "");
const eventId = Number(__ENV.K6_EVENT_ID);
const inventoryItemId = Number(__ENV.K6_INVENTORY_ITEM_ID);

if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0) {
  throw new Error("K6_EVENT_ID and K6_INVENTORY_ITEM_ID must be positive integers");
}

export default function () {
  const customer = `k6-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const response = http.post(
    `${baseUrl}/events/${eventId}/holds`,
    JSON.stringify({ inventoryItemId, quantity: 1 }),
    {
      headers: {
        Authorization: `Bearer test-token:${customer}`,
        "Content-Type": "application/json",
      },
      responseCallback: http.expectedStatuses(201, 409),
      tags: { endpoint_type: "booking", name: "concurrent_inventory_hold" },
      timeout: "5s",
    },
  );

  let body = {};
  try {
    body = response.json();
  } catch {
    // The checks below classify a non-JSON response as unexpected.
  }
  const created = response.status === 201 && body.status === "ACTIVE";
  const rejected = response.status === 409 &&
    ["insufficient_inventory", "hold_contention_exceeded"].includes(body.error);

  successfulHolds.add(created ? 1 : 0);
  capacityRejections.add(rejected ? 1 : 0);
  unexpectedResponses.add(created || rejected ? 0 : 1);
  unexpectedServerErrors.add(response.status >= 500);
  check(response, {
    "hold is created or safely rejected": () => created || rejected,
  });
}
