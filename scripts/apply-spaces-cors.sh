#!/usr/bin/env bash
# Apply the CORS rule required for browser PDF.js / image fetches of
# blueprint, attachment, and photo objects served via presigned URLs
# (BLUEPRINT_DOWNLOAD_PRESIGNED=1 in apps/api/src/server.ts).
#
# Idempotent — re-running with the same inputs replaces the rule with
# itself. Safe to run from a deploy script or by hand. See
# docs/RUNBOOK_SPACES_CORS.md for context.
#
# Prereqs:
#   - aws CLI installed
#   - DO Spaces ACCOUNT-OWNER keys (the scoped app key does NOT grant
#     s3:PutBucketCORS). Export:
#       DO_SPACES_KEY      - owner access key id
#       DO_SPACES_SECRET   - owner secret
#       DO_SPACES_REGION   - default tor1
#
# Usage:
#   ./scripts/apply-spaces-cors.sh                    # prod bucket, sandolab origins
#   ./scripts/apply-spaces-cors.sh --bucket sitelayer-blueprints-preview --origin https://main.preview.sitelayer.sandolab.xyz
#   ./scripts/apply-spaces-cors.sh --dry-run          # print the JSON, don't apply

set -euo pipefail

region="${DO_SPACES_REGION:-tor1}"
bucket="sitelayer-blueprints-prod"
# main.preview retired 2026-06-12; dev is the durable non-prod origin.
origins=("https://sitelayer.sandolab.xyz" "https://dev.sitelayer.sandolab.xyz")
dry_run=0
custom_origins=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    --bucket) bucket="$2"; shift 2 ;;
    --origin) custom_origins+=("$2"); shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# If the caller passed any --origin, use only those.
if [[ ${#custom_origins[@]} -gt 0 ]]; then
  origins=("${custom_origins[@]}")
fi

if [[ "$dry_run" -ne 1 ]]; then
  if [[ -z "${DO_SPACES_KEY:-}" || -z "${DO_SPACES_SECRET:-}" ]]; then
    echo "error: DO_SPACES_KEY and DO_SPACES_SECRET must be set" >&2
    echo "       (must be account-owner keys, not the scoped app key)" >&2
    exit 1
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "error: aws CLI not found. install with: pip install awscli" >&2
    exit 1
  fi
fi

# Build the AllowedOrigins JSON array.
origins_json=$(printf '%s\n' "${origins[@]}" | python3 -c '
import json, sys
print(json.dumps([o.strip() for o in sys.stdin.read().splitlines() if o.strip()]))
')

cors_payload=$(cat <<JSON
{
  "CORSRules": [
    {
      "ID": "sitelayer-blueprint-pdfjs",
      "AllowedOrigins": $origins_json,
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": [
        "Range",
        "If-Match",
        "If-Modified-Since",
        "If-None-Match",
        "Authorization"
      ],
      "ExposeHeaders": [
        "Accept-Ranges",
        "Content-Range",
        "Content-Length",
        "ETag",
        "Last-Modified",
        "Content-Disposition"
      ],
      "MaxAgeSeconds": 3600
    }
  ]
}
JSON
)

if [[ "$dry_run" -eq 1 ]]; then
  echo "DRY RUN — would apply to bucket=$bucket region=$region"
  echo "$cors_payload"
  exit 0
fi

endpoint="https://${region}.digitaloceanspaces.com"
export AWS_ACCESS_KEY_ID="$DO_SPACES_KEY"
export AWS_SECRET_ACCESS_KEY="$DO_SPACES_SECRET"
export AWS_DEFAULT_REGION="$region"

tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT
echo "$cors_payload" > "$tmpfile"

echo "applying CORS to bucket=$bucket region=$region"
aws --endpoint-url "$endpoint" s3api put-bucket-cors \
  --bucket "$bucket" \
  --cors-configuration "file://$tmpfile"

echo "verifying:"
aws --endpoint-url "$endpoint" s3api get-bucket-cors --bucket "$bucket"
