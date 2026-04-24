#!/usr/bin/env bash
set -euo pipefail

SSH_ALLOWED_CIDR="${SSH_ALLOWED_CIDR:-50.71.113.46/32}"
ACME_EMAIL="${ACME_EMAIL:-admin@sandolab.xyz}"
TRAEFIK_ROOT="/opt/sitelayer-preview-router"
TRAEFIK_NETWORK="sitelayer-preview-router"
PREVIEW_ROOT="/app/previews"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg gzip lsb-release postgresql-client rsync ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi

systemctl enable --now docker

if ! id sitelayer >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group sitelayer
fi
usermod -aG docker sitelayer

mkdir -p /home/sitelayer/.ssh
touch /home/sitelayer/.ssh/authorized_keys
if [ -s /root/.ssh/authorized_keys ] && [ ! -s /home/sitelayer/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/sitelayer/.ssh/authorized_keys
fi
chown -R sitelayer:sitelayer /home/sitelayer/.ssh
chmod 700 /home/sitelayer/.ssh
chmod 600 /home/sitelayer/.ssh/authorized_keys

mkdir -p "$PREVIEW_ROOT"
chown -R sitelayer:sitelayer "$PREVIEW_ROOT"

mkdir -p "$TRAEFIK_ROOT/letsencrypt"
touch "$TRAEFIK_ROOT/letsencrypt/acme.json"
chmod 600 "$TRAEFIK_ROOT/letsencrypt/acme.json"

cat > "$TRAEFIK_ROOT/docker-compose.yml" <<EOF
services:
  traefik:
    image: traefik:v3
    container_name: traefik
    restart: unless-stopped
    command:
      - --api.dashboard=false
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=${TRAEFIK_NETWORK}
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - ${TRAEFIK_NETWORK}

networks:
  ${TRAEFIK_NETWORK}:
    name: ${TRAEFIK_NETWORK}
    external: true
EOF

docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1 || docker network create "$TRAEFIK_NETWORK"
docker compose -f "$TRAEFIK_ROOT/docker-compose.yml" up -d

ufw default deny incoming
ufw default allow outgoing
ufw allow from "$SSH_ALLOWED_CIDR" to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Preview host ready"
echo "Traefik root: $TRAEFIK_ROOT"
echo "Preview root: $PREVIEW_ROOT"
echo "SSH allowed CIDR: $SSH_ALLOWED_CIDR"
