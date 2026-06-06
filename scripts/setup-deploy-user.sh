#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run this script as root" >&2
    exit 1
fi

echo "Setting up deployment user 'sitelayer'..."

# Create deployment user
if ! id sitelayer &>/dev/null; then
    useradd --create-home --shell /bin/bash --user-group sitelayer
    echo "Created user 'sitelayer'"
else
    echo "User 'sitelayer' already exists"
fi

# Docker access is root-equivalent. This avoids exposing root SSH, but the
# deployment key can still build/run containers and must be treated as privileged.
usermod -aG docker sitelayer
echo "Added 'sitelayer' to docker group (root-equivalent deployment privilege)"

# Create app directory with proper permissions
mkdir -p /app/sitelayer
chown -R sitelayer:sitelayer /app/sitelayer
echo "Created /app/sitelayer with sitelayer ownership"

mkdir -p /home/sitelayer/.ssh
touch /home/sitelayer/.ssh/authorized_keys
chown -R sitelayer:sitelayer /home/sitelayer/.ssh
chmod 700 /home/sitelayer/.ssh
chmod 600 /home/sitelayer/.ssh/authorized_keys
echo "Prepared /home/sitelayer/.ssh/authorized_keys"

echo ""
echo "✓ Deployment user setup complete"
echo "WARNING: Docker group membership is root-equivalent. Protect DEPLOY_SSH_KEY like a production root key."
echo ""
echo "Next steps:"
echo "1. Append the deployment public SSH key to /home/sitelayer/.ssh/authorized_keys"
echo "2. Update GitHub repository secrets:"
echo "   - DEPLOY_HOST: (your droplet IP or domain)"
echo "   - DEPLOY_SSH_KEY: (private key content)"
echo ""
