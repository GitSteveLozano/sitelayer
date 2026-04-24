#!/usr/bin/env bash
# Creates per-tier DigitalOcean Spaces buckets for Sitelayer and sets private ACL.
# Idempotent — existing buckets are left untouched.
#
# Prereqs:
#   - aws CLI installed
#   - DO Spaces access keys exported:
#       DO_SPACES_KEY, DO_SPACES_SECRET
#   - DO_SPACES_REGION set (defaults to tor1)
#
# Usage:
#   ./scripts/provision-spaces-buckets.sh
#   ./scripts/provision-spaces-buckets.sh --region nyc3

set -euo pipefail

region="${DO_SPACES_REGION:-tor1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${DO_SPACES_KEY:-}" || -z "${DO_SPACES_SECRET:-}" ]]; then
  echo "error: DO_SPACES_KEY and DO_SPACES_SECRET must be set" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws CLI not found. install with: pip install awscli" >&2
  exit 1
fi

endpoint="https://${region}.digitaloceanspaces.com"
export AWS_ACCESS_KEY_ID="$DO_SPACES_KEY"
export AWS_SECRET_ACCESS_KEY="$DO_SPACES_SECRET"
export AWS_DEFAULT_REGION="$region"

buckets=(
  "sitelayer-blueprints-dev"
  "sitelayer-blueprints-preview"
  "sitelayer-blueprints-prod"
)

for bucket in "${buckets[@]}"; do
  if aws --endpoint-url "$endpoint" s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    echo "exists: $bucket"
    continue
  fi
  echo "creating: $bucket in $region"
  aws --endpoint-url "$endpoint" s3api create-bucket --bucket "$bucket" --acl private
  aws --endpoint-url "$endpoint" s3api put-public-access-block \
    --bucket "$bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
    2>/dev/null || echo "  (public-access-block not supported by endpoint — rely on private ACL)"
done

echo
echo "done. bucket names for .env:"
for bucket in "${buckets[@]}"; do
  echo "  DO_SPACES_BUCKET=$bucket"
done
