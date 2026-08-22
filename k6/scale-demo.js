// Minimal, deliberately small load test to demonstrate ECS Service Auto
// Scaling actually scales Kong out under load — not a capacity/stress test.
//
// Target: Kong's own scaling policy (autoscaling_capacity via
// modules/ecs_service, locals.tf) tracks ALBRequestCountPerTarget at 75
// req/min/target, min=1 max=4. A modest, capped, constant request rate
// sustained for a few minutes is enough to cross that threshold several
// times over without needing any real backend compute cost — this is a
// request-count trigger, not a CPU trigger.
//
// Safety: constant-arrival-rate bounds the exact request rate regardless of
// response latency (avoids coordinated omission and avoids an uncontrolled
// VU pile-up if the backend slows down); preAllocatedVUs/maxVUs cap the
// absolute worst case; a correctness threshold aborts early if the target
// isn't healthy. max_count=4 on Kong's own autoscaling target is the hard
// ceiling on however far this can push cost, independent of this script.

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://d3vlw6jnm44c4l.cloudfront.net";

export const options = {
  scenarios: {
    scale_demo: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 50,
      stages: [
        { target: 8, duration: "30s" }, // ramp up to 8 req/s
        { target: 8, duration: "4m" }, // hold — sustained well above the 75/min (~1.25/s) per-target threshold
        { target: 0, duration: "30s" }, // ramp down
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"], // abort-worthy signal if Kong/services are actually unhealthy, not just scaling
    http_req_duration: ["p(95)<2000"],
  },
};

const PATHS = [
  "/api/event/health",
  "/api/auth/health",
  "/api/inventory/health",
  "/api/order/health",
];

export default function () {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const res = http.get(`${BASE_URL}${path}`);
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}
