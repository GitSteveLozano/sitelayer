# Cloudflare DNS for *.sandolab.xyz. These point at the reserved IPs.
#
# IMPORTANT: keep proxied = false (gray cloud) so Let's Encrypt HTTP-01 cert
# validation works on the droplets (Caddy on prod, Traefik on preview). See
# INFRASTRUCTURE_READY.md → DNS Configuration.

data "cloudflare_zone" "sandolab" {
  name = var.cloudflare_zone
}

locals {
  zone_id = data.cloudflare_zone.sandolab.id

  # Records that resolve to the PROD reserved IP.
  prod_a_records = {
    "sitelayer" = var.reserved_ip_prod # apex app host: sitelayer.sandolab.xyz
  }

  # Records that resolve to the PREVIEW reserved IP. dev + demo + the preview
  # wildcard all live on the preview droplet (Traefik host-routes them).
  preview_a_records = {
    "preview.sitelayer"      = var.reserved_ip_preview # preview.sitelayer.sandolab.xyz
    "*.preview.sitelayer"    = var.reserved_ip_preview # per-PR previews
    "dev.sitelayer"          = var.reserved_ip_preview # dev tier
    "demo.preview.sitelayer" = var.reserved_ip_preview # demo tier
  }
}

resource "cloudflare_record" "prod_a" {
  for_each = local.prod_a_records

  zone_id = local.zone_id
  name    = each.key
  type    = "A"
  content = each.value
  proxied = false
  ttl     = 1 # 1 = "automatic" when not proxied
}

resource "cloudflare_record" "preview_a" {
  for_each = local.preview_a_records

  zone_id = local.zone_id
  name    = each.key
  type    = "A"
  content = each.value
  proxied = false
  ttl     = 1
}
