#!/usr/bin/env bash
# Field Desk on a fresh Ubuntu server — made for Oracle Cloud Always Free (ARM or AMD), works on any VPS.
#
#   sudo bash deploy/setup.sh                 HTTPS on the free <ip-with-dashes>.sslip.io address
#   sudo bash deploy/setup.sh fd.example.com  HTTPS on your own domain (point its A record at this server first)
#
# Safe to run again: it keeps deploy/.env (your HQ code) and only rebuilds / restarts the app.
# Also open TCP 80 and 443 in Oracle's console: Networking → your VCN → Security List → Ingress rules.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash deploy/setup.sh" >&2; exit 1; fi

# 1. Docker + compose
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
  systemctl enable --now docker
fi
docker compose version >/dev/null

# Small machines (Oracle's free AMD micro has 1 GB): add 2 GB of swap so the app's build doesn't run out of memory.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# 2. This machine's own firewall. Oracle's Ubuntu images reject everything but SSH in iptables,
#    on top of the cloud Security List — both must allow 80 (certificate check) and 443.
if command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null; fi
fi

# 3. Settings: the HQ code (generated once, kept) and the address.
touch .env
chmod 600 .env
if ! grep -q '^SUPER_ADMIN_CODE=' .env; then
  echo "SUPER_ADMIN_CODE=$(head -c 18 /dev/urandom | base64 | tr '+/' '-_')" >>.env
  echo "New HQ code created in deploy/.env — read it with: sudo grep SUPER_ADMIN_CODE deploy/.env"
fi
domain="${1:-}"
if [ -z "$domain" ]; then
  domain="$(grep '^DOMAIN=' .env | cut -d= -f2- || true)"
fi
if [ -z "$domain" ]; then
  ip="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
  domain="${ip//./-}.sslip.io"
fi
sed -i '/^DOMAIN=/d' .env
echo "DOMAIN=$domain" >>.env

# 4. Build and start (first build takes a few minutes on the free machines).
docker compose up -d --build
echo
echo "Field Desk is starting on https://$domain"
echo "HQ signs in at https://$domain/hq with the code in deploy/.env"
echo "If the page doesn't load in a minute: open TCP 80 and 443 in Oracle's Security List, then: cd deploy && docker compose logs caddy"
