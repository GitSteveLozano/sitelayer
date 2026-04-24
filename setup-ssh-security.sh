#!/bin/bash
# SSH Security Setup for Sitelayer Droplet
# Run this script via DigitalOcean console as root

set -e

echo "=== Setting up SSH security ==="

# Add SSH public key for ubuntu user
mkdir -p /home/ubuntu/.ssh
cat > /home/ubuntu/.ssh/authorized_keys << 'EOF'
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCwOIWtrOsBIhii8GGf1uoBAAe4+NE/u665ENwXWvtAgTI6wsVEQmfy3eUEPVP0pDTFnXDP6MVXuVzH9+aHsjNqhgDo1N/VyUDtvutK2sb1+mS12hIfkr6isWn0cheAzJfkysiYcUBgDuN/1Q+Cqra8UxJ44M6HTckvs3D6rIoLe/dDC+lSdTEniNLhHKOzCpw4f8l3x2Dk6jde0+NuoKDMG9EvbpD5cFkbiorRdj7kkZ1QE/T4BtotATgOI5Dn1M4itTPCoosZ0DeehhPa8dVFz9J06qmsBNUNXbQ4B5yeFzsLieUdEFIKDWK50csNtyIXlMHWem7N6aR8UseWGlTd taylor@taylor
EOF

chmod 600 /home/ubuntu/.ssh/authorized_keys
chmod 700 /home/ubuntu/.ssh
chown -R ubuntu:ubuntu /home/ubuntu/.ssh

echo "✓ SSH public key added"

# Disable password authentication
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config

# Disable root login (optional but recommended)
sed -i 's/^#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config

# Restrict SSH to key-only
sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# Disable empty passwords
sed -i 's/^#PermitEmptyPasswords no/PermitEmptyPasswords no/' /etc/ssh/sshd_config

echo "✓ SSH hardened: password login disabled, root login disabled"

# Restart SSH service
systemctl reload sshd

echo "✓ SSH configuration reloaded"
echo ""
echo "=== SSH Security Setup Complete ==="
echo "You can now SSH with:"
echo "  ssh -i ~/.ssh/id_rsa ubuntu@159.203.51.158"
echo ""
echo "Password-based login is disabled."
echo "Root login is disabled."
