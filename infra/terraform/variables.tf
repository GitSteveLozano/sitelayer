# All inputs. NO secret has a default. NO secret is committed — populate via
# environment (TF_VAR_*) or an UNCOMMITTED terraform.tfvars (see .gitignore +
# terraform.tfvars.example). The non-secret defaults below mirror the LIVE
# footprint documented in INFRASTRUCTURE_READY.md / CLAUDE.md so a plan after
# `terraform import` is a near no-op.

# ---------------------------------------------------------------------------
# Credentials (secrets — no defaults, never committed)
# ---------------------------------------------------------------------------

variable "do_token" {
  description = "DigitalOcean API token (read/write). Read from TF_VAR_do_token."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token scoped to the sandolab.xyz zone (DNS edit). Read from TF_VAR_cloudflare_api_token."
  type        = string
  sensitive   = true
}

variable "spaces_access_id" {
  description = "DigitalOcean Spaces access key id (S3-compatible). Only needed for spaces_bucket resources."
  type        = string
  sensitive   = true
  default     = ""
}

variable "spaces_secret_key" {
  description = "DigitalOcean Spaces secret key (S3-compatible)."
  type        = string
  sensitive   = true
  default     = ""
}

# Per-tier managed-Postgres app-role passwords. These are SECRETS; the cluster
# already has these roles, so on import the password is unknown to Terraform —
# supply the live value (or rotate deliberately and apply). Empty default keeps
# `terraform validate` working before the operator wires real values.
variable "db_password_prod" {
  description = "Password for sitelayer_prod_app. Supply the live value on import or rotate deliberately."
  type        = string
  sensitive   = true
  default     = ""
}

variable "db_password_dev" {
  description = "Password for sitelayer_dev_app."
  type        = string
  sensitive   = true
  default     = ""
}

variable "db_password_preview" {
  description = "Password for sitelayer_preview_app."
  type        = string
  sensitive   = true
  default     = ""
}

variable "db_password_demo" {
  description = "Password for sitelayer_demo_app (least-priv demo role; see scripts/provision-demo-db-role.sh)."
  type        = string
  sensitive   = true
  default     = ""
}

# ---------------------------------------------------------------------------
# Region / zone
# ---------------------------------------------------------------------------

variable "region" {
  description = "DigitalOcean region slug for all resources."
  type        = string
  default     = "tor1"
}

variable "cloudflare_zone" {
  description = "Cloudflare DNS zone the *.sandolab.xyz records live in."
  type        = string
  default     = "sandolab.xyz"
}

# ---------------------------------------------------------------------------
# Droplets (EXISTING — import by ID; see README import table)
# ---------------------------------------------------------------------------

variable "ssh_key_ids" {
  description = "DO SSH key IDs attached to the droplets (key 2238080 in the live footprint)."
  type        = list(string)
  default     = ["2238080"]
}

variable "prod_droplet_name" {
  description = "Production droplet name."
  type        = string
  default     = "sitelayer"
}

variable "prod_droplet_size" {
  description = "Production droplet size slug."
  type        = string
  default     = "s-4vcpu-8gb"
}

variable "prod_droplet_image" {
  description = "Production droplet base image slug."
  type        = string
  default     = "ubuntu-22-04-x64"
}

variable "preview_droplet_name" {
  description = "Preview droplet name."
  type        = string
  default     = "sitelayer-preview"
}

variable "preview_droplet_size" {
  description = "Preview droplet size slug."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "preview_droplet_image" {
  description = "Preview droplet base image slug."
  type        = string
  default     = "ubuntu-22-04-x64"
}

# ---------------------------------------------------------------------------
# Reserved IPs (EXISTING — assigned to the droplets)
# ---------------------------------------------------------------------------

variable "reserved_ip_prod" {
  description = "Reserved IPv4 assigned to the prod droplet."
  type        = string
  default     = "159.203.51.158"
}

variable "reserved_ip_preview" {
  description = "Reserved IPv4 assigned to the preview droplet."
  type        = string
  default     = "159.203.53.218"
}

# ---------------------------------------------------------------------------
# Managed Postgres (EXISTING — cluster id 9948c96b-...)
# ---------------------------------------------------------------------------

variable "db_cluster_name" {
  description = "Managed Postgres cluster name."
  type        = string
  default     = "sitelayer-db"
}

variable "db_cluster_id" {
  description = "Managed Postgres cluster id (informational; the cluster is imported by this id)."
  type        = string
  default     = "9948c96b-b6b6-45ad-adf7-d20e4c206c66"
}

variable "db_engine_version" {
  description = "Managed Postgres major version."
  type        = string
  default     = "18"
}

variable "db_size" {
  description = "Managed Postgres node size slug."
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "db_node_count" {
  description = "Managed Postgres node count."
  type        = number
  default     = 1
}

variable "db_names" {
  description = "Per-tier logical databases on the cluster."
  type        = list(string)
  default     = ["sitelayer_prod", "sitelayer_dev", "sitelayer_preview", "sitelayer_demo"]
}

# Non-owner application roles, one per tier. doadmin (the cluster owner) is NOT
# managed here. The demo role is the least-priv role provisioned by
# scripts/provision-demo-db-role.sh.
variable "db_app_users" {
  description = "Map of app-role name -> password variable. Passwords come from the db_password_* variables."
  type        = map(string)
  default = {
    sitelayer_prod_app    = "prod"
    sitelayer_dev_app     = "dev"
    sitelayer_preview_app = "preview"
    sitelayer_demo_app    = "demo"
  }
}

# ---------------------------------------------------------------------------
# Object storage (Spaces) + Container Registry
# ---------------------------------------------------------------------------

variable "spaces_bucket_prod" {
  description = "Production blueprint Spaces bucket (in-region)."
  type        = string
  default     = "sitelayer-blueprints-prod"
}

variable "spaces_backup_bucket" {
  description = "Off-region backup Spaces bucket (defence-in-depth; see scripts/backup-to-offregion.sh)."
  type        = string
  default     = "sitelayer-backups-nyc3"
}

variable "spaces_backup_region" {
  description = "Region for the off-region backup bucket (must differ from var.region)."
  type        = string
  default     = "nyc3"
}

variable "registry_name" {
  description = "DO Container Registry name."
  type        = string
  default     = "sitelayer"
}

variable "registry_tier" {
  description = "DO Container Registry subscription tier."
  type        = string
  default     = "starter"
}

# ---------------------------------------------------------------------------
# Firewalls — inbound allow-lists. Operator SSH source(s) are sensitive-ish but
# not secret; keep them as a variable so they are easy to rotate.
# ---------------------------------------------------------------------------

variable "ssh_allow_cidrs" {
  description = "CIDRs allowed to SSH (22) to the droplets (operator workstation, etc.)."
  type        = list(string)
  default     = ["50.71.113.46/32"]
}

variable "prod_firewall_name" {
  description = "Production firewall name."
  type        = string
  default     = "sitelayer-tor"
}

variable "preview_firewall_name" {
  description = "Preview firewall name."
  type        = string
  default     = "sitelayer-preview"
}

# ---------------------------------------------------------------------------
# VPC (private network the droplets + cluster live on)
# ---------------------------------------------------------------------------

variable "vpc_name" {
  description = "VPC name for the tor1 private network."
  type        = string
  default     = "sitelayer-tor1"
}

variable "vpc_ip_range" {
  description = "VPC private IPv4 CIDR (matches the 10.118.0.0/x private IPs in the footprint)."
  type        = string
  default     = "10.118.0.0/20"
}
