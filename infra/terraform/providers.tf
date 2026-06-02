# Provider wiring. Credentials are NEVER hardcoded — they come from variables
# (which in turn read from environment variables; see terraform.tfvars.example).
#
#   export TF_VAR_do_token="$(doctl auth token 2>/dev/null || cat ~/.config/doctl/...)"
#   export TF_VAR_cloudflare_api_token="..."
#   export TF_VAR_spaces_access_id="..."
#   export TF_VAR_spaces_secret_key="..."

provider "digitalocean" {
  token = var.do_token

  # Spaces (S3-compatible) keys are SEPARATE from the DO API token. They are
  # only needed for the spaces_bucket resources; leave blank if you import
  # buckets in a later pass.
  spaces_access_id  = var.spaces_access_id
  spaces_secret_key = var.spaces_secret_key
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
