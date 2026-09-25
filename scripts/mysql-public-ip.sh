#!/usr/bin/env bash
# Prints the current public IP of the running mysql task, for pasting into
# DBeaver — Fargate assigns a new ENI (and public IP) on every task restart,
# so there is no fixed address to hardcode.
set -euo pipefail

CLUSTER="onestage-cluster"
REGION="ap-southeast-1"

task_arn=$(aws ecs list-tasks \
  --region "${REGION}" \
  --cluster "${CLUSTER}" \
  --service-name onestage-mysql \
  --desired-status RUNNING \
  --query 'taskArns[0]' \
  --output text)

if [[ "${task_arn}" == "None" || -z "${task_arn}" ]]; then
  echo "No running mysql task found — start it first (scripts/start-env.sh)." >&2
  exit 1
fi

eni_id=$(aws ecs describe-tasks \
  --region "${REGION}" \
  --cluster "${CLUSTER}" \
  --tasks "${task_arn}" \
  --query 'tasks[0].attachments[?type==`ElasticNetworkInterface`] | [0].details[?name==`networkInterfaceId`].value | [0]' \
  --output text)

aws ec2 describe-network-interfaces \
  --region "${REGION}" \
  --network-interface-ids "${eni_id}" \
  --query 'NetworkInterfaces[0].Association.PublicIp' \
  --output text
