# Droplets. EXISTING — import by ID (prod 566798325, preview 566806040).
#
# NOTE on drift: the live droplets were created out-of-band, so a few computed
# attributes (e.g. exact image/user_data) may not round-trip perfectly on the
# first plan. Review the first `terraform plan` and either align the variable
# or add a lifecycle ignore_changes for genuinely immutable-after-create fields
# rather than letting Terraform propose a destroy/recreate. NEVER let a plan
# recreate a droplet that holds production state.

resource "digitalocean_droplet" "prod" {
  name     = var.prod_droplet_name
  region   = var.region
  size     = var.prod_droplet_size
  image    = var.prod_droplet_image
  ssh_keys = var.ssh_key_ids
  vpc_uuid = digitalocean_vpc.tor1.id

  # The live droplets predate Terraform; guard against an accidental recreate.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [image, user_data]
  }
}

resource "digitalocean_droplet" "preview" {
  name     = var.preview_droplet_name
  region   = var.region
  size     = var.preview_droplet_size
  image    = var.preview_droplet_image
  ssh_keys = var.ssh_key_ids
  vpc_uuid = digitalocean_vpc.tor1.id

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [image, user_data]
  }
}
