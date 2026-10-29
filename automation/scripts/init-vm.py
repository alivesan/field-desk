"""Generate VM-local secrets; never prints or overwrites them. Run on the new VM."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets

parser = argparse.ArgumentParser()
parser.add_argument('--private-ip', required=True)
parser.add_argument('--domain', required=True)
args = parser.parse_args()
if ipaddress.ip_address(args.private_ip) not in ipaddress.ip_network('10.0.0.0/16'):
    parser.error('Expected the automation VM private address')
if not re.fullmatch(r'n8n\.[0-9-]+\.sslip\.io', args.domain):
    parser.error('Expected the reviewed sslip.io hostname')
config = {
    'N8N_ENCRYPTION_KEY': secrets.token_hex(32),
    'WORKER_TOKEN': secrets.token_hex(32),
    'FD_API_KEY': 'fd_' + secrets.token_hex(32),
    'FD_WEBHOOK_SECRET': secrets.token_hex(32),
    'MAILBOXES': json.dumps([{'id': 'central-gmail', 'provider': 'gmail', 'trustedForwarders': []}], separators=(',', ':')),
    'PRIVATE_IP': args.private_ip,
    'N8N_DOMAIN': args.domain,
    'FIELD_DESK_BASE_URL': 'http://mock:8790/api/v1',
}
target = Path(__file__).resolve().parent.parent / 'deploy' / '.env'
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as output:
    for name, value in config.items():
        output.write(f'{name}={value}\n')
print('Created VM-local mock configuration with private secrets; existing files are never overwritten.')
