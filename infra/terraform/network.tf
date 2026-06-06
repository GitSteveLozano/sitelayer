# VPC, reserved IPs, and the two firewalls. All EXISTING resources — import,
# don't apply blind (see README import table).

resource "digitalocean_vpc" "tor1" {
  name     = var.vpc_name
  region   = var.region
  ip_range = var.vpc_ip_range
}

# Reserved (floating) IPs already assigned to the droplets.
resource "digitalocean_reserved_ip" "prod" {
  region     = var.region
  droplet_id = digitalocean_droplet.prod.id
}

resource "digitalocean_reserved_ip" "preview" {
  region     = var.region
  droplet_id = digitalocean_droplet.preview.id
}

# ---------------------------------------------------------------------------
# Production firewall (sitelayer-tor): 80/443 from anywhere, 22 from the
# operator CIDRs plus the preview droplet. No public app ports (3000/3001/…).
# ---------------------------------------------------------------------------
resource "digitalocean_firewall" "prod" {
  name        = var.prod_firewall_name
  droplet_ids = [digitalocean_droplet.prod.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol                  = "tcp"
    port_range                = "22"
    source_addresses          = var.ssh_allow_cidrs
    source_droplet_ids        = [digitalocean_droplet.preview.id]
    source_load_balancer_uids = []
  }

  # Default-allow egress (matches the live "TCP/UDP + ICMP to 0.0.0.0/0").
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# ---------------------------------------------------------------------------
# Preview firewall (sitelayer-preview): 80/443 from anywhere, 22 from the
# operator CIDRs plus the prod droplet.
# ---------------------------------------------------------------------------
resource "digitalocean_firewall" "preview" {
  name        = var.preview_firewall_name
  droplet_ids = [digitalocean_droplet.preview.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol           = "tcp"
    port_range         = "22"
    source_addresses   = var.ssh_allow_cidrs
    source_droplet_ids = [digitalocean_droplet.prod.id]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
