#!/usr/bin/env bash
# Scale the environment back to zero after a session. Once every service is
# at desired-count 0, the capacity provider's managed scaling drains the EC2
# ASG to 0 on its own within a few minutes — this is the same mechanism the
# nightly EventBridge safety net (scale_schedule.tf) uses.
set -euo pipefail

CLUSTER="onestage-cluster"
REGION="ap-southeast-1"
SERVICES=(kong event inventory queue order ticket notification auth mysql)

for svc in "${SERVICES[@]}"; do
  echo "Stopping onestage-${svc}..."
  aws ecs update-service \
    --region "${REGION}" \
    --cluster "${CLUSTER}" \
    --service "onestage-${svc}" \
    --desired-count 0 \
    --no-cli-pager >/dev/null
done

echo "All services set to desired-count 0. EC2 capacity will drain automatically over the next few minutes."
