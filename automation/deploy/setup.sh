#!/usr/bin/env bash
# Prepare an Ubuntu 24.04 host for the automation stack. Does not start Compose.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run with sudo; pass PRIVATE_IP=10.x.x.x in the environment.' >&2
  exit 1
fi
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
  echo 'This installer supports Ubuntu 24.04 only.' >&2
  exit 1
fi
if [[ ! ${PRIVATE_IP:-} =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] ||
   ! ip -4 -o addr show | grep -Fq " ${PRIVATE_IP}/"; then
  echo "Set PRIVATE_IP to this host's assigned 10.0.0.0/16 IPv4 address." >&2
  exit 1
fi
if [[ ${PRIVATE_IP} != 10.0.* ]]; then
  echo 'PRIVATE_IP must be in 10.0.0.0/16.' >&2
  exit 1
fi

# Docker's official Ubuntu repository and signed packages.
apt-get update
apt-get install -y ca-certificates curl gnupg iptables
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Add swap on small shapes; retain any existing swap and all existing fstab entries.
swap_bytes=$(swapon --show --noheadings --bytes --output SIZE | awk '{sum += $1} END {print sum + 0}')
if (( swap_bytes < 2147483648 )) && [[ ! -e /swapfile-fielddesk-automation ]]; then
  fallocate -l 2G /swapfile-fielddesk-automation
  chmod 600 /swapfile-fielddesk-automation
  mkswap /swapfile-fielddesk-automation
  swapon /swapfile-fielddesk-automation
  printf '/swapfile-fielddesk-automation none swap sw 0 0\n' >> /etc/fstab
fi

# Never flush firewall tables or change SSH rules/policies. Reapply only our rules
# after Docker starts; Docker port publishing otherwise bypasses INPUT filtering.
cat > /usr/local/sbin/fielddesk-automation-firewall <<EOF
#!/usr/bin/env bash
set -euo pipefail
PRIVATE_IP=${PRIVATE_IP}
ensure_rule() {
  local chain=\$1
  shift
  iptables -C "\$chain" "\$@" 2>/dev/null || iptables -I "\$chain" 1 "\$@"
}
ensure_rule INPUT -p tcp --dport 80 -j ACCEPT
ensure_rule INPUT -p tcp --dport 443 -j ACCEPT
ensure_rule INPUT -d "\$PRIVATE_IP" -s 10.0.0.0/16 -p tcp --dport 5678 -j ACCEPT
ensure_rule INPUT -p tcp --dport 5678 ! -s 10.0.0.0/16 -j DROP
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo 'Docker DOCKER-USER chain is missing; refusing incomplete firewall setup.' >&2
  exit 1
fi
ensure_rule DOCKER-USER -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst "\$PRIVATE_IP" --ctorigdstport 5678 ! -s 10.0.0.0/16 -j DROP
EOF
chmod 0755 /usr/local/sbin/fielddesk-automation-firewall
cat > /etc/systemd/system/fielddesk-automation-firewall.service <<'EOF'
[Unit]
Description=Field Desk automation port rules
Wants=docker.service
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/fielddesk-automation-firewall
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable fielddesk-automation-firewall.service
systemctl restart fielddesk-automation-firewall.service

echo 'Host prepared. SSH rules were not changed. Compose was not started.'
echo 'Verify Oracle ingress rules, private IP, firewall, DNS and .env before starting.'
