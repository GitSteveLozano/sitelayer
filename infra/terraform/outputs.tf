# Non-secret outputs the operator and the bootstrap script consume. No password
# or token is ever output.

output "prod_droplet_id" {
  description = "Production droplet id."
  value       = digitalocean_droplet.prod.id
}

output "preview_droplet_id" {
  description = "Preview droplet id."
  value       = digitalocean_droplet.preview.id
}

output "reserved_ip_prod" {
  description = "Production reserved IPv4."
  value       = var.reserved_ip_prod
}

output "reserved_ip_preview" {
  description = "Preview reserved IPv4."
  value       = var.reserved_ip_preview
}

output "db_cluster_id" {
  description = "Managed Postgres cluster id."
  value       = digitalocean_database_cluster.sitelayer.id
}

output "db_cluster_host" {
  description = "Managed Postgres host (private + public endpoints are on the cluster resource)."
  value       = digitalocean_database_cluster.sitelayer.host
}

output "db_cluster_port" {
  description = "Managed Postgres port."
  value       = digitalocean_database_cluster.sitelayer.port
}

output "db_names" {
  description = "Per-tier logical databases."
  value       = [for d in digitalocean_database_db.tier : d.name]
}

output "db_app_users" {
  description = "Non-owner app roles managed here (passwords are NOT output)."
  value       = [for u in digitalocean_database_user.app : u.name]
}

output "spaces_bucket_prod" {
  description = "Production blueprint Spaces bucket."
  value       = digitalocean_spaces_bucket.blueprints_prod.name
}

output "spaces_backup_bucket" {
  description = "Off-region backup Spaces bucket."
  value       = digitalocean_spaces_bucket.backups_offregion.name
}

output "registry_endpoint" {
  description = "Container Registry endpoint for image pushes/pulls."
  value       = digitalocean_container_registry.sitelayer.endpoint
}

output "vpc_id" {
  description = "VPC id."
  value       = digitalocean_vpc.tor1.id
}
