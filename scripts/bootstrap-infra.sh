#!/usr/bin/env bash
#
# Sitelayer infrastructure bootstrap — one command to stand up (or, for the
# EXISTING live footprint, to RECONCILE) the DigitalOcean + Cloudflare resources
# in infra/terraform, and to render the env manifest that the prod tier expects.
#
# IMPORTANT: the live resources in INFRASTRUCTURE_READY.md / CLAUDE.md ALREADY
# EXIST. This script DOES NOT `terraform apply` by default. Its job is:
#
#   1. terraform init (in infra/terraform)
#   2. terraform import for any resource not yet in state (driven by the import
#      table in infra/terraform/README.md). It is idempotent: an already-imported
#      resource is skipped.
#   3. terraform plan (read-only) so the operator can eyeball drift.
#   4. Render the env manifest from ops/env/production.env.json to a preview file
#      (NON-enforcing, NON-secret) so the operator sees the expected shape of
#      /app/sitelayer/.env without leaking secrets.
#
# An actual `terraform apply` is a DELIBERATE, separate operator step
# (BOOTSTRAP_APPLY=1) — never the default — because applying against existing,
# production-bearing resources risks a destroy/recreate. Read the plan first.
#
# Usage:
#   scripts/bootstrap-infra.sh                 # init + import-missing + plan + render-preview
#   scripts/bootstrap-infra.sh --plan-only     # skip imports; just init + plan + render
#   scripts/bootstrap-infra.sh --render-only    # only render the env manifest preview
#   BOOTSTRAP_APPLY=1 scripts/bootstrap-infra.sh   # ALSO runs `terraform apply` (guarded)
#
# Env:
#   TF_DIR              terraform dir (default: infra/terraform)
#   ENV_MANIFEST        env manifest (default: ops/env/production.env.json)
#   ENV_RENDER_OUT      preview output (default: infra/terraform/production.env.rendered, gitignored)
#   TERRAFORM_BIN       terraform binary (default: terraform)
#   BOOTSTRAP_APPLY     set 1 to run a guarded `terraform apply` after the plan
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TF_DIR="${TF_DIR:-infra/terraform}"
ENV_MANIFEST="${ENV_MANIFEST:-ops/env/production.env.json}"
ENV_RENDER_OUT="${ENV_RENDER_OUT:-$TF_DIR/production.env.rendered}"
TERRAFORM_BIN="${TERRAFORM_BIN:-terraform}"

DO_IMPORT=1
DO_PLAN=1
DO_RENDER=1

for arg in "$@"; do
  case "$arg" in
    --plan-only) DO_IMPORT=0 ;;
    --render-only)
      DO_IMPORT=0
      DO_PLAN=0
      ;;
    -h | --help)
      sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "bootstrap-infra: unknown argument: $arg" >&2
      echo "  see: scripts/bootstrap-infra.sh --help" >&2
      exit 2
      ;;
  esac
done

log() { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap WARN] %s\n' "$*" >&2; }
die() {
  printf '[bootstrap FATAL] %s\n' "$*" >&2
  exit 1
}

# ---- Resource id map (EXISTING live footprint) -----------------------------
# "<terraform address>=<import id>" — the import id format is provider-specific
# (see infra/terraform/README.md for the canonical reference). Only resources
# with a stable, known id live here; the rest (DNS records, db sub-resources)
# are imported by the README's documented composite ids.
IMPORT_MAP=(
  "digitalocean_droplet.prod=566798325"
  "digitalocean_droplet.preview=566806040"
  "digitalocean_database_cluster.sitelayer=9948c96b-b6b6-45ad-adf7-d20e4c206c66"
  "digitalocean_container_registry.sitelayer=sitelayer"
  "digitalocean_spaces_bucket.blueprints_prod=tor1,sitelayer-blueprints-prod"
  "digitalocean_spaces_bucket.backups_offregion=nyc3,sitelayer-backups-nyc3"
)

render_env_preview() {
  log "rendering env manifest preview from $ENV_MANIFEST (non-secret, non-enforcing)"
  if [ ! -f "$ENV_MANIFEST" ]; then
    warn "env manifest not found: $ENV_MANIFEST — skipping render"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found — cannot render env preview; run on a box with node"
    return 0
  fi
  # --no-enforce: never fail bootstrap on a missing secret; this is a SHAPE
  # preview, not the real /app/sitelayer/.env (which is rendered/owned on the
  # droplet, mode 600). The renderer never prints secret VALUES to stdout.
  node scripts/render-production-env.mjs \
    --manifest "$ENV_MANIFEST" \
    --output "$ENV_RENDER_OUT" \
    --no-enforce
  log "env manifest preview written to $ENV_RENDER_OUT (gitignored). This is the"
  log "expected shape of /app/sitelayer/.env; the LIVE file is rendered + kept"
  log "on the prod droplet (see ops/env/production.env.json + INFRASTRUCTURE_READY.md)."
}

if [ "$DO_RENDER" = "1" ] && [ "$DO_IMPORT" = "0" ] && [ "$DO_PLAN" = "0" ]; then
  # --render-only path.
  render_env_preview
  exit 0
fi

command -v "$TERRAFORM_BIN" >/dev/null 2>&1 ||
  die "terraform not found (install it, or set TERRAFORM_BIN). This is groundwork — nothing is applied without it."

[ -d "$TF_DIR" ] || die "terraform dir not found: $TF_DIR"

log "terraform init ($TF_DIR)"
"$TERRAFORM_BIN" -chdir="$TF_DIR" init -input=false

if [ "$DO_IMPORT" = "1" ]; then
  log "importing EXISTING resources not yet in state (idempotent — skips ones already tracked)"
  for entry in "${IMPORT_MAP[@]}"; do
    address="${entry%%=*}"
    import_id="${entry#*=}"
    if "$TERRAFORM_BIN" -chdir="$TF_DIR" state show "$address" >/dev/null 2>&1; then
      log "  already in state: $address"
      continue
    fi
    log "  import $address <- $import_id"
    if ! "$TERRAFORM_BIN" -chdir="$TF_DIR" import -input=false "$address" "$import_id"; then
      warn "  import failed for $address (id=$import_id). Resolve per infra/terraform/README.md, then re-run."
    fi
  done
  log "DNS records + per-tier db/db-user resources are imported by composite id —"
  log "see the import table in infra/terraform/README.md (this script only covers"
  log "the resources with a single stable id)."
fi

if [ "$DO_PLAN" = "1" ]; then
  log "terraform plan (READ-ONLY — review drift; nothing is changed)"
  "$TERRAFORM_BIN" -chdir="$TF_DIR" plan -input=false -refresh=true || warn "plan reported a non-zero exit; review the output above"
fi

if [ "$DO_RENDER" = "1" ]; then
  render_env_preview
fi

if [ "${BOOTSTRAP_APPLY:-0}" = "1" ]; then
  warn "BOOTSTRAP_APPLY=1 — running 'terraform apply' against the LIVE footprint."
  warn "Resources here carry PRODUCTION state. Re-read the plan above; a recreate"
  warn "of a droplet/cluster/bucket is data loss. Ctrl-C now if the plan proposes"
  warn "anything other than the additive/no-op changes you expect."
  "$TERRAFORM_BIN" -chdir="$TF_DIR" apply -input=false
else
  log "done. No apply performed (set BOOTSTRAP_APPLY=1 to apply AFTER reviewing the plan)."
fi
