# DO Spaces buckets + Container Registry. EXISTING — import.
#
# Spaces resources require the spaces_access_id / spaces_secret_key provider
# args (separate from the DO API token). If you import buckets in a later pass,
# leave those blank and comment these two resources out until the keys are set.

# Production blueprint bucket (in-region, versioning on, private).
resource "digitalocean_spaces_bucket" "blueprints_prod" {
  name   = var.spaces_bucket_prod
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Off-region backup bucket (defence-in-depth; consumed by
# scripts/backup-to-offregion.sh via DO_SPACES_OFFREGION_*). Must be in a region
# different from var.region.
resource "digitalocean_spaces_bucket" "backups_offregion" {
  name   = var.spaces_backup_bucket
  region = var.spaces_backup_region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

# DO Container Registry (immutable production image promotion).
resource "digitalocean_container_registry" "sitelayer" {
  name                   = var.registry_name
  subscription_tier_slug = var.registry_tier
  region                 = var.region

  lifecycle {
    prevent_destroy = true
  }
}
