#!/usr/bin/env bash
# One-time setup for the Terraform remote state backend. Must run before
# `terraform init` can use backend.hcl — the bucket has to exist first.
# Run once via the bootstrap IAM user (onestage-cicd-bootstrap).
set -euo pipefail

BUCKET="onestage-tfstate-195663985359-apse1"
REGION="ap-southeast-1"

echo "Creating state bucket ${BUCKET} in ${REGION}..."
aws s3api create-bucket \
  --bucket "${BUCKET}" \
  --region "${REGION}" \
  --create-bucket-configuration LocationConstraint="${REGION}"

aws s3api put-bucket-versioning \
  --bucket "${BUCKET}" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "${BUCKET}" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket "${BUCKET}" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "Done. Bucket ${BUCKET} is ready for 'terraform init -backend-config=backend.hcl'."
