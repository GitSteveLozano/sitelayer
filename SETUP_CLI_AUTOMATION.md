# Sitelayer Setup via CLI (No UI Clicking Required)

**Goal:** Automate as much as possible. Only UI required for OAuth flows (Clerk, Intuit QBO).

---

## CLI Tools to Install

```bash
# DigitalOcean CLI
# https://github.com/digitalocean/doctl
curl -sL https://github.com/digitalocean/doctl/releases/download/v1.106.0/doctl-1.106.0-linux-x64.tar.gz | tar -xz -C ~/bin/
~/bin/doctl auth init  # Authenticate with your DO token

# Clerk CLI
# https://clerk.com/docs/cli
npm install -g @clerk/cli
clerk login  # Authenticate with Clerk account

# Sentry CLI
# https://docs.sentry.io/cli/
npm install -g @sentry/cli
sentry login  # Authenticate

# jq (JSON query tool, useful for parsing responses)
sudo apt install -y jq

# Check installations
doctl --version
clerk --version
sentry --version
jq --version
```

---

## Step 1: Create DigitalOcean Infrastructure via doctl

### 1.1 Setup doctl

```bash
# Create DO token: https://cloud.digitalocean.com/account/api/tokens
# Then:
doctl auth init

# Verify
doctl account get
```

### 1.2 Create Droplet

```bash
# List available sizes/regions
doctl compute size list
doctl compute region list

# Create 8GB Droplet (Ubuntu 22.04) in TOR1
doctl compute droplet create sitelayer \
  --region tor1 \
  --size s-2vcpu-8gb \
  --image ubuntu-22-04-x64 \
  --wait \
  --format Name,PublicIPv4,ID \
  --no-header

# Store the output (you'll need Droplet ID + IP)
DROPLET_ID=12345678
DROPLET_IP=1.2.3.4
```

### 1.3 Create Database

```bash
# Create managed Postgres 1GB in TOR1
doctl databases create sitelayer-db \
  --engine pg \
  --region tor1 \
  --size db-s-1vcpu-1gb \
  --wait \
  --format Name,Connection.Host,Connection.Port,Connection.User,Connection.Password \
  --no-header

# Output will be: name, host, port, user, password
# Store: DATABASE_URL=postgres://user:password@host:5432/sitelayer
```

### 1.4 Create Spaces Bucket

```bash
# Create Spaces bucket (S3-compatible)
doctl compute spaces create sitelayer-blueprints --region tor1

# Get access key
doctl compute spaces list-keys --format Key,ID

# If no keys exist, create one
doctl compute spaces create-key sitelayer-blueprints \
  --format Key,ID,Secret \
  --no-header

# Output: key, id, secret
# Store: DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_ENDPOINT=https://tor1.digitaloceanspaces.com
```

### 1.5 Assign Static IP

```bash
# Create static IP in TOR1
doctl compute reserved-ip create --region tor1 \
  --format IPAddress \
  --no-header

# Assign to Droplet
RESERVED_IP=1.2.3.5
doctl compute reserved-ip assign $RESERVED_IP $DROPLET_ID
```

### 1.6 Create Firewall

```bash
doctl compute firewall create sitelayer \
  --inbound-rules protocol:tcp,ports:22,sources.type:address,sources.addresses:YOUR_IP \
  --inbound-rules protocol:tcp,ports:80,sources.type:address,sources.addresses:0.0.0.0/0 \
  --inbound-rules protocol:tcp,ports:443,sources.type:address,sources.addresses:0.0.0.0/0 \
  --inbound-rules protocol:tcp,ports:5432,sources.type:droplet_id,sources.addresses:$DROPLET_ID \
  --outbound-rules protocol:tcp,ports:1:65535,destinations.type:cidr_block,destinations.addresses:0.0.0.0/0 \
  --outbound-rules protocol:udp,ports:1:65535,destinations.type:cidr_block,destinations.addresses:0.0.0.0/0 \
  --format ID,Name
```

### 1.7 Enable Backups

```bash
# Enable weekly backups on Droplet (20% of cost)
doctl compute droplet-action enable-backups $DROPLET_ID
```

---

## Step 2: Domain Registration & DNS (Varies by Registrar)

**Porkbun CLI:**

```bash
# Install porkbun CLI (requires Python)
pip install porkbun-cli

porkbun auth --api-key YOUR_API_KEY --secret_api_key YOUR_SECRET

# Search for domain
porkbun search sitelayer.com

# Register (if available)
porkbun register sitelayer.com

# Update DNS A record to point to Droplet IP
porkbun dns-update sitelayer.com \
  --type A \
  --name @ \
  --content $DROPLET_IP
```

**Cloudflare CLI:**

```bash
# Install Cloudflare CLI
npm install -g wrangler

wrangler login

# If you want to manage DNS via Cloudflare
# (more complex, requires zone ID)
```

**Generic approach (works everywhere):**

```bash
# Just use curl to update DNS via your registrar's API
# Example: Namecheap, Route53, etc. all have REST APIs
# See your registrar's API docs
```

---

## Step 3: Clerk Auth Setup via CLI

### 3.1 Create Clerk App

```bash
# Install Clerk CLI
npm install -g @clerk/cli

clerk login  # Opens browser to authenticate

# Create new application
clerk apps create sitelayer

# List apps and get IDs
clerk apps list

# Get credentials
CLERK_PUBLISHABLE_KEY=$(clerk apps list --format json | jq -r '.[] | select(.name=="sitelayer") | .public_key')
CLERK_SECRET_KEY=$(clerk apps list --format json | jq -r '.[] | select(.name=="sitelayer") | .secret_key')
```

### 3.2 Configure Organization Model

```bash
# This part must be done in Clerk dashboard (no CLI support yet)
# But you can do it in 2 minutes:
# 1. Go to https://dashboard.clerk.com
# 2. Select your app
# 3. Organizations → Create → Organization
# 4. Add roles: owner, admin, estimator, field
# 5. JWT template → customize to include org context

# Then export credentials:
echo "export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY" >> ~/.env.sitelayer
echo "export CLERK_SECRET_KEY=$CLERK_SECRET_KEY" >> ~/.env.sitelayer
```

### 3.3 Configure OAuth Providers (Optional but Recommended)

```bash
# This also must be done in UI, but CLI can validate:
clerk apps get sitelayer --format json | jq '.oauth_providers'
```

---

## Step 4: Intuit QBO OAuth Setup (UI Required)

```bash
# No CLI for Intuit OAuth app creation, but here's what to do:
# 1. Go to https://developer.intuit.com
# 2. Create new app (Accounting)
# 3. Copy Client ID and Secret
# 4. Set local redirect URI: http://localhost:3001/api/integrations/qbo/callback
# 5. Add production redirect URI after deployment: https://yourdomain.com/api/integrations/qbo/callback

# Then save:
echo "export QBO_CLIENT_ID=YOUR_CLIENT_ID" >> ~/.env.sitelayer
echo "export QBO_CLIENT_SECRET=YOUR_CLIENT_SECRET" >> ~/.env.sitelayer
echo "export QBO_REDIRECT_URI=http://localhost:3001/api/integrations/qbo/callback" >> ~/.env.sitelayer
echo "export QBO_SUCCESS_REDIRECT_URI=http://localhost:3000/?qbo=connected" >> ~/.env.sitelayer
echo "export QBO_ENVIRONMENT=sandbox" >> ~/.env.sitelayer
```

---

## Step 5: Sentry Setup via CLI

### 5.1 Create Organization + Projects

```bash
sentry login  # Opens browser

# Create new organization
sentry org create --name sitelayer

# List organizations
sentry org list

# Create API + Frontend projects
sentry project create --organization sitelayer --name sitelayer-api
sentry project create --organization sitelayer --name sitelayer-web

# Get DSNs
sentry project list --organization sitelayer --format json | jq '.[] | {name, dsn}'

# Save credentials
echo "export SENTRY_DSN=https://..." >> ~/.env.sitelayer
echo "export NEXT_PUBLIC_SENTRY_DSN=https://..." >> ~/.env.sitelayer
```

### 5.2 Configure Error Routing

```bash
# Set up default error routing via API
curl -X POST https://sentry.io/api/0/organizations/sitelayer/rules/ \
  -H "Authorization: Bearer YOUR_SENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Send all errors to email",
    "conditions": [],
    "actions": [
      {
        "service": "mail",
        "target_type": "team",
        "target_identifier": "YOUR_TEAM_ID"
      }
    ]
  }'
```

---

## Step 6: UptimeRobot Setup via API

```bash
# UptimeRobot has API but no official CLI
# Create monitors via curl:

UPTIMEROBOT_API_KEY=YOUR_API_KEY

# Monitor 1: App health
curl -X POST https://api.uptimerobot.com/v2/monitor \
  -H "Content-Type: application/json" \
  -d "{
    \"api_key\": \"$UPTIMEROBOT_API_KEY\",
    \"type\": 1,
    \"url\": \"https://yourdomain.com\",
    \"friendly_name\": \"Sitelayer App\",
    \"interval\": 300
  }" | jq '.monitor.id'

# Monitor 2: API health
curl -X POST https://api.uptimerobot.com/v2/monitor \
  -H "Content-Type: application/json" \
  -d "{
    \"api_key\": \"$UPTIMEROBOT_API_KEY\",
    \"type\": 1,
    \"url\": \"https://yourdomain.com/api/bootstrap\",
    \"friendly_name\": \"Sitelayer API\",
    \"interval\": 300
  }" | jq '.monitor.id'

# Monitor 3: Database health (ping Postgres)
# (Requires custom script on Droplet)
```

---

## Step 7: Postmark Email Setup (Optional)

```bash
# Postmark has no CLI, but easy API setup:

POSTMARK_API_KEY=$(curl -s -X POST https://api.postmarkapp.com/servers \
  -H "X-Postmark-Account-Token: YOUR_ACCOUNT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"Name":"Sitelayer","ServerLink":"","Color":"default"}' \
  | jq -r '.ApiTokens[0]')

echo "export POSTMARK_API_TOKEN=$POSTMARK_API_KEY" >> ~/.env.sitelayer

# Verify sender domain (requires DKIM/SPF DNS records)
curl -X POST https://api.postmarkapp.com/domains \
  -H "X-Postmark-Server-Token: $POSTMARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"Name":"yourdomain.com"}'
```

---

## Master Setup Script (All CLI Steps)

```bash
#!/bin/bash
set -e

# Load existing DigitalOcean token
read -p "Enter DigitalOcean API token: " DO_TOKEN
read -p "Enter Clerk API key: " CLERK_KEY
read -p "Enter Sentry auth token: " SENTRY_TOKEN
read -p "Enter UptimeRobot API key: " UPTIMEROBOT_KEY
read -p "Enter domain name (e.g., sitelayer.com): " DOMAIN
read -p "Enter your SSH public IP (for firewall): " SSH_IP

# Setup DigitalOcean
export DIGITALOCEAN_TOKEN=$DO_TOKEN
doctl auth init --access-token $DO_TOKEN

echo "Creating Droplet..."
DROPLET=$(doctl compute droplet create sitelayer \
  --region tor1 \
  --size s-2vcpu-8gb \
  --image ubuntu-22-04-x64 \
  --wait \
  --format ID,PublicIPv4 \
  --no-header)

DROPLET_ID=$(echo $DROPLET | awk '{print $1}')
DROPLET_IP=$(echo $DROPLET | awk '{print $2}')

echo "Droplet created: ID=$DROPLET_ID, IP=$DROPLET_IP"

echo "Creating database..."
DB=$(doctl databases create sitelayer-db \
  --engine pg \
  --region tor1 \
  --size db-s-1vcpu-1gb \
  --wait \
  --format Name,Connection.Host,Connection.Port,Connection.User,Connection.Password \
  --no-header)

DB_HOST=$(echo $DB | awk '{print $2}')
DB_PORT=$(echo $DB | awk '{print $3}')
DB_USER=$(echo $DB | awk '{print $4}')
DB_PASSWORD=$(echo $DB | awk '{print $5}')

echo "Database created: $DB_HOST:$DB_PORT"

echo "Creating Spaces bucket..."
doctl compute spaces create sitelayer-blueprints --region tor1

echo "Setting up firewall..."
doctl compute firewall create sitelayer \
  --inbound-rules protocol:tcp,ports:22,sources.type:address,sources.addresses:$SSH_IP \
  --inbound-rules protocol:tcp,ports:80,sources.type:address,sources.addresses:0.0.0.0/0 \
  --inbound-rules protocol:tcp,ports:443,sources.type:address,sources.addresses:0.0.0.0/0 \
  --outbound-rules protocol:tcp,ports:1:65535,destinations.type:cidr_block,destinations.addresses:0.0.0.0/0 \
  --outbound-rules protocol:udp,ports:53,destinations.type:cidr_block,destinations.addresses:0.0.0.0/0

echo "Enabling backups..."
doctl compute droplet-action enable-backups $DROPLET_ID

# Setup Sentry
echo "Setting up Sentry..."
npm install -g @sentry/cli
sentry login --auth-token $SENTRY_TOKEN
sentry org create --name sitelayer || true  # May already exist
sentry project create --organization sitelayer --name sitelayer-api || true
sentry project create --organization sitelayer --name sitelayer-web || true

# Setup Clerk
echo "Setting up Clerk..."
npm install -g @clerk/cli
# Note: clerk login requires browser interaction
echo "Please run: clerk login"
echo "Then create organization at https://dashboard.clerk.com"

# Setup UptimeRobot monitors
echo "Setting up UptimeRobot monitors..."
curl -s -X POST https://api.uptimerobot.com/v2/monitor \
  -H "Content-Type: application/json" \
  -d "{
    \"api_key\": \"$UPTIMEROBOT_KEY\",
    \"type\": 1,
    \"url\": \"https://$DOMAIN\",
    \"friendly_name\": \"Sitelayer App\",
    \"interval\": 300
  }" | jq '.monitor.id'

# Create .env file
cat > ~/.env.sitelayer << EOF
# DigitalOcean
DROPLET_ID=$DROPLET_ID
DROPLET_IP=$DROPLET_IP
DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/sitelayer
DO_SPACES_ENDPOINT=https://tor1.digitaloceanspaces.com
DO_SPACES_BUCKET=sitelayer-blueprints

# Domain
DOMAIN=$DOMAIN

# Add these after manual setup:
# CLERK_SECRET_KEY=sk_...
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
# QBO_CLIENT_ID=...
# QBO_CLIENT_SECRET=...
# SENTRY_DSN=...
# POSTMARK_API_TOKEN=...
EOF

echo "✅ Setup complete!"
echo ""
echo "Saved to ~/.env.sitelayer"
echo "Next steps:"
echo "1. SSH into Droplet: ssh -i ~/.ssh/id_rsa root@$DROPLET_IP"
echo "2. Setup Clerk at: https://dashboard.clerk.com"
echo "3. Setup Intuit QBO at: https://developer.intuit.com"
echo "4. Copy credentials to ~/.env.sitelayer"
```

---

## Summary: What's Automated vs Manual

| Task                        | CLI            | UI  | Time  |
| --------------------------- | -------------- | --- | ----- |
| Create Droplet              | ✅ doctl       | ❌  | 2 min |
| Create Database             | ✅ doctl       | ❌  | 2 min |
| Create Spaces bucket        | ✅ doctl       | ❌  | 1 min |
| Assign static IP            | ✅ doctl       | ❌  | 1 min |
| Setup firewall              | ✅ doctl       | ❌  | 1 min |
| Enable backups              | ✅ doctl       | ❌  | 1 min |
| Register domain             | ✅ porkbun-cli | ❌  | 2 min |
| Update DNS                  | ✅ CLI/API     | ❌  | 1 min |
| Create Clerk app            | ✅ clerk-cli   | ❌  | 1 min |
| Configure org model         | ❌             | ✅  | 2 min |
| Configure OAuth providers   | ❌             | ✅  | 2 min |
| Create QBO app              | ❌             | ✅  | 2 min |
| Setup Sentry                | ✅ sentry-cli  | ⚠️  | 2 min |
| Create UptimeRobot monitors | ✅ curl API    | ❌  | 2 min |
| Create Postmark account     | ❌             | ✅  | 1 min |

**Total automated:** ~18 minutes  
**Total manual (UI):** ~9 minutes  
**Total:** ~27 minutes start-to-finish with existing DO account

---

## Run This Now

```bash
# Step 1: Install required tools
curl -sL https://github.com/digitalocean/doctl/releases/download/v1.106.0/doctl-1.106.0-linux-x64.tar.gz | tar -xz -C ~/.local/bin/
sudo apt install -y jq
npm install -g @clerk/cli @sentry/cli

# Step 2: Authenticate
~/.local/bin/doctl auth init
clerk login
sentry login

# Step 3: Verify
doctl account get
clerk org list
sentry org list

# Step 4: Then run the master script above
```

---

## Notes

- **doctl:** DigitalOcean's official CLI — excellent, full-featured
- **clerk-cli:** Basic CLI, OAuth setup still needs UI
- **sentry-cli:** Good for project creation, email routing via API
- **porkbun-cli:** Works great for domain registration + DNS
- **UptimeRobot:** API-first, no official CLI but easy curl commands
- **Postmark:** API-first, no CLI but simple REST calls

All credentials will be saved to `~/.env.sitelayer` for the Droplet deployment.
