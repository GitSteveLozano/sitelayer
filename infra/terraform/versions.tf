terraform {
  required_version = ">= 1.6.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.43"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
  }

  # State backend is intentionally left unconfigured here so the operator can
  # choose where state lives (a DO Spaces bucket via the s3 backend, or a local
  # file for a first import pass). Pick ONE and uncomment in a backend.tf the
  # operator keeps OUT of git, e.g.:
  #
  #   terraform {
  #     backend "s3" {
  #       endpoints                   = { s3 = "https://tor1.digitaloceanspaces.com" }
  #       bucket                      = "sitelayer-tfstate"
  #       key                         = "sitelayer/terraform.tfstate"
  #       region                      = "us-east-1" # Spaces ignores this; required by the s3 backend
  #       skip_credentials_validation = true
  #       skip_metadata_api_check     = true
  #       skip_region_validation      = true
  #       skip_requesting_account_id  = true
  #       use_path_style              = false
  #     }
  #   }
  #
  # Until then, state is a local terraform.tfstate (gitignored). Do NOT commit
  # state — it contains resource attributes and can contain secrets.
}
