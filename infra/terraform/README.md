# Sitelayer Infrastructure (Terraform) — IMPORT, don't apply blind

This module is a **faithful skeleton** of the EXISTING DigitalOcean + Cloudflare
footprint documented in [`INFRASTRUCTURE_READY.md`](../../INFRASTRUCTURE_READY.md)
and `CLAUDE.md`. Every resource here **already exists in production**. This is
groundwork the operator refines and `terraform import`s — it is **not** a clean
`apply`-from-zero stack.

> ⚠️ **Do NOT run `terraform apply` against an empty state.** Terraform would try
> to CREATE a second prod droplet / cluster / bucket (or, worse, propose a
> destroy/recreate). Always `terraform import` the live resources FIRST, then
> `terraform plan` and resolve drift to a no-op before you ever `apply`.

## What this manages

| File           | Resources                                                                         |
| -------------- | --------------------------------------------------------------------------------- |
| `compute.tf`   | Prod droplet (`566798325`), preview droplet (`566806040`)                         |
| `network.tf`   | VPC, two reserved IPs, prod firewall (`sitelayer-tor`), preview firewall          |
| `database.tf`  | Managed PG 18 cluster (`9948c96b-…`), per-tier DBs, non-owner app roles, DB ACL   |
| `storage.tf`   | Spaces `sitelayer-blueprints-prod` + off-region backup bucket, Container Registry |
| `dns.tf`       | Cloudflare `A` records for `*.sandolab.xyz` (prod + dev/demo/preview)             |
| `variables.tf` | All inputs; non-secret defaults mirror the live footprint                         |
| `outputs.tf`   | Non-secret outputs (ids, hosts, bucket/registry names) — **no** passwords/tokens  |

`doadmin` (cluster superuser) and `defaultdb` are created by DO and are **not**
managed here on purpose.

## Prerequisites

- Terraform `>= 1.6`.
- A DO API token, a Cloudflare DNS-edit token scoped to `sandolab.xyz`, and
  (for the Spaces buckets) a Spaces access id + secret. Supply them as env vars
  so they never touch disk:

  ```bash
  export TF_VAR_do_token="dop_v1_..."
  export TF_VAR_cloudflare_api_token="..."
  export TF_VAR_spaces_access_id="..."
  export TF_VAR_spaces_secret_key="..."
  ```

  Or copy `terraform.tfvars.example` → `terraform.tfvars` (gitignored).

## State

No backend is configured — pick one in an **uncommitted** `backend.tf` (see the
commented example in `versions.tf`). A DO Spaces bucket via the `s3` backend is
the natural choice; a local `terraform.tfstate` is fine for the first import
pass. **State is gitignored and must never be committed** (it can contain
secrets and full resource attributes).

## Import the live footprint

Run `terraform init` first, then import each existing resource. The bootstrap
script (`scripts/bootstrap-infra.sh`) automates the single-id imports below; the
composite-id ones (DNS records, per-tier DBs/users) are listed here for the
manual pass.

```bash
cd infra/terraform
terraform init

# --- Droplets (import id = droplet id) ---
terraform import digitalocean_droplet.prod    566798325
terraform import digitalocean_droplet.preview 566806040

# --- VPC (import id = VPC uuid; get it from `doctl vpcs list`) ---
terraform import digitalocean_vpc.tor1 <vpc-uuid>

# --- Reserved IPs (import id = the IP) ---
terraform import digitalocean_reserved_ip.prod    159.203.51.158
terraform import digitalocean_reserved_ip.preview 159.203.53.218

# --- Firewalls (import id = firewall id) ---
terraform import digitalocean_firewall.prod    63b5d4f6-0949-4658-ba91-48e119c53ee3
terraform import digitalocean_firewall.preview 7a8f443e-cd74-4867-af8a-118559f33561

# --- Managed Postgres cluster (import id = cluster id) ---
terraform import digitalocean_database_cluster.sitelayer 9948c96b-b6b6-45ad-adf7-d20e4c206c66

# --- Per-tier databases (import id = "<cluster-id>/<db-name>") ---
terraform import 'digitalocean_database_db.tier["sitelayer_prod"]'    9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_prod
terraform import 'digitalocean_database_db.tier["sitelayer_dev"]'     9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_dev
terraform import 'digitalocean_database_db.tier["sitelayer_preview"]' 9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_preview
terraform import 'digitalocean_database_db.tier["sitelayer_demo"]'    9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_demo

# --- App roles (import id = "<cluster-id>/<role-name>") ---
terraform import 'digitalocean_database_user.app["sitelayer_prod_app"]'    9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_prod_app
terraform import 'digitalocean_database_user.app["sitelayer_dev_app"]'     9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_dev_app
terraform import 'digitalocean_database_user.app["sitelayer_preview_app"]' 9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_preview_app
terraform import 'digitalocean_database_user.app["sitelayer_demo_app"]'    9948c96b-b6b6-45ad-adf7-d20e4c206c66/sitelayer_demo_app

# --- Database firewall / trusted sources (import id = cluster id) ---
terraform import digitalocean_database_firewall.sitelayer 9948c96b-b6b6-45ad-adf7-d20e4c206c66

# --- Spaces buckets (import id = "<region>,<bucket>") ---
terraform import digitalocean_spaces_bucket.blueprints_prod   tor1,sitelayer-blueprints-prod
terraform import digitalocean_spaces_bucket.backups_offregion nyc3,sitelayer-backups-nyc3

# --- Container Registry (import id = registry name) ---
terraform import digitalocean_container_registry.sitelayer sitelayer

# --- Cloudflare DNS records (import id = "<zone-id>/<record-id>") ---
# Get zone + record ids from `cloudflare` API or the dashboard, then:
terraform import 'cloudflare_record.prod_a["sitelayer"]'                 <zone-id>/<record-id>
terraform import 'cloudflare_record.preview_a["preview.sitelayer"]'      <zone-id>/<record-id>
terraform import 'cloudflare_record.preview_a["*.preview.sitelayer"]'    <zone-id>/<record-id>
terraform import 'cloudflare_record.preview_a["dev.sitelayer"]'          <zone-id>/<record-id>
terraform import 'cloudflare_record.preview_a["demo.preview.sitelayer"]' <zone-id>/<record-id>
```

> Looking up ids: `doctl compute droplet list`, `doctl vpcs list`,
> `doctl databases list`, `doctl compute firewall list`,
> `doctl compute reserved-ip list`, `doctl registry get`. For Cloudflare,
> `GET /zones?name=sandolab.xyz` then `GET /zones/<id>/dns_records`.

## After import: reconcile to a no-op

```bash
terraform plan
```

Expect some drift on first plan (image slug, user_data, db user passwords —
which Terraform can't read on import). Resolve each by **aligning the variable**
or adding a `lifecycle { ignore_changes = [...] }` (the droplets/cluster already
carry `prevent_destroy = true` and ignore `image`/`user_data`; db users ignore
`password`). **Never accept a plan that recreates a stateful resource.** Only
once `plan` is a clean no-op (or purely additive) is it safe to `apply`.

## One-command stand-up / reconcile

```bash
# init + import-the-missing + read-only plan + render the env-manifest preview:
scripts/bootstrap-infra.sh

# add a guarded apply ONLY after you've read the plan:
BOOTSTRAP_APPLY=1 scripts/bootstrap-infra.sh
```

There is no `Makefile` in this repo today; `scripts/bootstrap-infra.sh` is the
"`make bootstrap`" entrypoint. If a `Makefile` is later added, wire:

```make
bootstrap: ## init + import + plan + render env manifest (no apply)
	scripts/bootstrap-infra.sh
```

The script also renders `ops/env/production.env.json` to a **non-secret,
non-enforcing** preview (`infra/terraform/production.env.rendered`, gitignored)
so you can eyeball the expected shape of `/app/sitelayer/.env`. The LIVE env file
is rendered and owned on the prod droplet (mode `600`); this module never writes
secrets.

## Secrets discipline

- No token, password, or Spaces secret is committed. Secrets flow via `TF_VAR_*`
  env or an uncommitted `terraform.tfvars`.
- `outputs.tf` exposes ids/hosts/names only — never passwords or tokens.
- `db_password_*` variables feed the env-render / provisioning path, **not** the
  `digitalocean_database_user` resource (which keeps DO-managed passwords on
  import). A leaked tfvars therefore cannot silently rotate a live role.
- State and `terraform.tfvars` are in `.gitignore`. Keep them there.
