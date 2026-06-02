# Managed Postgres 18 cluster (sitelayer-db, id 9948c96b-...), its per-tier
# logical databases, and the non-owner app roles. EXISTING — import by id.
#
# doadmin (the cluster owner/superuser) is NOT managed here on purpose: it is
# created by DO at cluster birth and Terraform should not own it.

resource "digitalocean_database_cluster" "sitelayer" {
  name       = var.db_cluster_name
  engine     = "pg"
  version    = var.db_engine_version
  size       = var.db_size
  region     = var.region
  node_count = var.db_node_count

  # Keep the cluster on the same private network as the droplets.
  private_network_uuid = digitalocean_vpc.tor1.id

  lifecycle {
    prevent_destroy = true
  }
}

# Trusted sources: only the two droplets may reach the cluster (DO firewall for
# managed DBs). This mirrors "Managed Postgres trusted sources: droplet
# 566798325 + droplet 566806040".
resource "digitalocean_database_firewall" "sitelayer" {
  cluster_id = digitalocean_database_cluster.sitelayer.id

  rule {
    type  = "droplet"
    value = digitalocean_droplet.prod.id
  }

  rule {
    type  = "droplet"
    value = digitalocean_droplet.preview.id
  }
}

# Per-tier logical databases (defaultdb is created by DO and not managed here).
resource "digitalocean_database_db" "tier" {
  for_each   = toset(var.db_names)
  cluster_id = digitalocean_database_cluster.sitelayer.id
  name       = each.value
}

# Non-owner application roles, one per tier. On import their passwords are
# DO-managed (see the lifecycle note below); the db_password_* secrets feed the
# .env render / provisioning path, not this resource.
resource "digitalocean_database_user" "app" {
  for_each   = var.db_app_users
  cluster_id = digitalocean_database_cluster.sitelayer.id
  name       = each.key

  # `password` is Optional+Computed on digitalocean_database_user: omit it and
  # DO keeps the role's existing password (import-friendly — Terraform records
  # the live value into state without changing it). The db_password_* secrets
  # are consumed by the .env render path / scripts/provision-demo-db-role.sh,
  # not pushed from here, so a leaked tfvars file can't silently rotate a role.
  # each.value is the tier key ("prod"/"dev"/...). To let Terraform OWN the
  # password instead, set `password = var.db_password_<tier>` and drop the
  # ignore_changes below.

  lifecycle {
    # The live roles already exist with passwords Terraform doesn't know on the
    # first import. Treat the password as DO-managed; flip this if you decide
    # Terraform should be the password authority.
    ignore_changes = [password]
  }
}
