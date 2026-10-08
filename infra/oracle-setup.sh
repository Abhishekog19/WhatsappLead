#!/usr/bin/env bash
#
# Provisions a fresh Oracle Cloud "Always Free" ARM instance to run this
# platform. Run once, as a user with sudo, on a clean Ubuntu 22.04/24.04 image:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/infra/oracle-setup.sh | bash
#
# or, more sensibly, clone the repo first and run it from there so you can read
# it before it touches anything.
#
# Why Oracle: the Always Free ARM shape gives 4 OCPU / 24 GB of RAM across up
# to two instances (2 OCPU / 12 GB is plenty here) and, unlike free tiers that
# sleep after inactivity, it stays up. A sending run that pauses 45 minutes
# between batches would otherwise be suspended mid-campaign.
#
# What this does NOT do: open the firewall in the Oracle console. Oracle
# applies a security list at the VCN level *in addition* to the host firewall,
# and it cannot be configured from inside the instance. See the note printed at
# the end.

set -euo pipefail

REPO_URL="${REPO_URL:-}"
APP_DIR="${APP_DIR:-$HOME/whatsapp-lead-platform}"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\n\033[1;33m!! \033[0m %s\n' "$1"; }

if [[ $EUID -eq 0 ]]; then
	warn "Run this as a normal user with sudo, not as root — the Docker group"
	warn "membership below is pointless for root."
	exit 1
fi

# ---------------------------------------------------------------------------
log "Updating the base system"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

log "Installing prerequisites"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
	ca-certificates curl git gnupg ufw

# ---------------------------------------------------------------------------
log "Installing Docker Engine and the Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
	sudo install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
		sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
	sudo chmod a+r /etc/apt/keyrings/docker.gpg

	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
		sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

	sudo apt-get update -qq
	sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
		docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

# ---------------------------------------------------------------------------
# Oracle's Ubuntu images ship iptables rules that drop almost everything, and
# they are *not* managed by ufw. Both have to agree or ports 80/443 stay shut.
log "Opening ports 80 and 443 on the host"
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent
sudo netfilter-persistent save

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# ---------------------------------------------------------------------------
# The ARM free shape has 12 GB of RAM but no swap. A Next.js build is the
# memory high-water mark of the whole deploy; 4 GB of swap keeps it from being
# OOM-killed on a box that is also running Postgres.
log "Adding 4 GB of swap"
if [[ ! -f /swapfile ]]; then
	sudo fallocate -l 4G /swapfile
	sudo chmod 600 /swapfile
	sudo mkswap /swapfile
	sudo swapon /swapfile
	echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
	# Prefer RAM; the swap is insurance for build spikes, not a working store.
	sudo sysctl -w vm.swappiness=10
	echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf >/dev/null
fi

# ---------------------------------------------------------------------------
log "Capping container log growth"
# Without this, a chatty container fills the boot volume and Postgres stops
# being able to write.
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
sudo systemctl restart docker

# ---------------------------------------------------------------------------
if [[ -n "$REPO_URL" ]]; then
	log "Cloning the application into $APP_DIR"
	[[ -d "$APP_DIR" ]] || git clone "$REPO_URL" "$APP_DIR"
fi

# ---------------------------------------------------------------------------
cat <<'NEXT'

==============================================================
  Host is ready. Three things left, none of them automatable:
==============================================================

1. OPEN THE PORTS IN THE ORACLE CONSOLE.
   Networking > Virtual Cloud Networks > your VCN > Security Lists >
   Default Security List > Add Ingress Rules:
       Source 0.0.0.0/0, TCP, destination port 80
       Source 0.0.0.0/0, TCP, destination port 443
   The host firewall above is not enough on its own. This is the single
   most common reason a fresh Oracle instance appears unreachable.

2. POINT DNS AT THIS INSTANCE.
   An A record for your domain -> this instance's public IP. Caddy needs
   the name to resolve before it can complete the ACME challenge.

3. CONFIGURE AND START THE APP.
       cd <app dir>
       cp .env.example .env
       # generate the two secrets it asks for, set DOMAIN and ACME_EMAIL,
       # set POSTGRES_PASSWORD, and add the Google OAuth credentials
       docker compose up -d --build
       docker compose logs -f

   Then add https://<your domain>/api/auth/callback/google as an
   authorised redirect URI in the Google Cloud console.

Log out and back in first, so your shell picks up the docker group.

NEXT
