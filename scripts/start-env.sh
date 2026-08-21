#!/usr/bin/env bash
# Scale the environment up for a dev/demo/load-test session. Setting each
# ECS service's desired count back to 1 is enough — the capacity provider's
# managed scaling (autoscaling_capacity.tf) automatically launches EC2
# capacity to host the newly-desired tasks, no ASG call needed here.
set -euo pipefail

CLUSTER="onestage-cluster"
REGION="ap-southeast-1"
SERVICES=(kong event inventory queue order ticket notification auth mysql)

for svc in "${SERVICES[@]}"; do
  echo "Starting onestage-${svc}..."
  aws ecs update-service \
    --region "${REGION}" \
    --cluster "${CLUSTER}" \
    --service "onestage-${svc}" \
    --desired-count 1 \
    --no-cli-pager >/dev/null
done

echo "All services set to desired-count 1. Capacity provider will scale EC2 instances up automatically."
echo "Check progress with: aws ecs describe-services --cluster ${CLUSTER} --services onestage-kong --region ${REGION}"
