#!/usr/bin/env bash
# Phase 0: list the five public NOAA NODD buckets with no credentials.
# Operator: check the NESDIS Notice of Changes before treating a product as current.
#   https://www.nesdis.noaa.gov/notice-of-changes
set -euo pipefail

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found. Install AWS CLI v2; no account or keys are required." >&2
  echo "  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  echo "All listings in this repo use --no-sign-request only. Do not run aws configure." >&2
  exit 1
fi

# NODD objects live in us-east-1. Pinning the region avoids a default-profile surprise.
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

BUCKETS=(
  "s3://noaa-ocs-nationalbathymetry-pds/"
  "s3://noaa-dcdb-bathymetry-pds/"
  "s3://noaa-s102-pds/"
  "s3://noaa-ocs-hydrodata/"
  "s3://noaa-nos-scuba-icesat2-pds/"
)

failed=0
for bucket in "${BUCKETS[@]}"; do
  echo "=== ${bucket} ==="
  if ! aws s3 ls --no-sign-request --region "${REGION}" "${bucket}"; then
    echo "WARN: could not list ${bucket}" >&2
    failed=1
  fi
  echo
done

if [ "${failed}" -ne 0 ]; then
  echo "One or more bucket listings failed. Network, region, or a retired prefix may be the cause." >&2
  echo "Re-check NESDIS Notice of Changes before assuming the product still exists." >&2
  exit 1
fi
