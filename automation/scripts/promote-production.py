"""Run on the automation VM; create production secrets without printing them."""
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import socket

if socket.gethostname() != 'field-desk-automation':
    raise SystemExit('Refusing a host other than the dedicated automation VM.')
root = Path(__file__).resolve().parent.parent
env_path = root / 'deploy' / '.env'
original = env_path.read_text()
def parse(text):
    return dict(line.split('=', 1) for line in text.splitlines() if line and not line.startswith('#') and '=' in line)
current = parse(original)
if not current.get('N8N_ENCRYPTION_KEY') or not current.get('WORKER_TOKEN'):
    raise SystemExit('Existing n8n and worker keys are required and must be preserved.')
private = root / 'data' / 'private'
private.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(private, 0o700)
handoff = private / 'fielddesk-otp-production.env'
if handoff.exists():
    values = parse(handoff.read_text())
    if not values.get('FD_STEAM_API_KEY') or not values.get('FD_STEAM_WEBHOOK_SECRET'):
        raise SystemExit('Existing handoff file is incomplete; refusing secret rotation.')
else:
    values = {'FD_STEAM_API_KEY': 'fd_' + secrets.token_hex(32),
              'FD_STEAM_WEBHOOK_SECRET': secrets.token_hex(32),
              'FD_STEAM_WEBHOOK_URL': 'http://10.0.0.230:5678/webhook/steam-request'}
    descriptor = os.open(handoff, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(''.join(f'{key}={value}\n' for key, value in values.items()))
        output.flush()
        os.fsync(output.fileno())
updates = {'FD_API_KEY': values['FD_STEAM_API_KEY'],
           'FD_WEBHOOK_SECRET': values['FD_STEAM_WEBHOOK_SECRET'],
           'FIELD_DESK_BASE_URL': 'https://fieldesk.runs-at.dev/api/v1'}
if any(current.get(key) != value for key, value in updates.items()):
    backups = root / 'data' / 'backups'
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = backups / ('pre-production-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.env')
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(original)
    lines = []
    remaining = dict(updates)
    for line in original.splitlines():
        key = line.split('=', 1)[0]
        lines.append(f'{key}={remaining.pop(key)}' if key in remaining else line)
    lines.extend(f'{key}={value}' for key, value in remaining.items())
    temporary = env_path.with_name('.env.production.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write('\n'.join(lines) + '\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, env_path)
print('Production API target and secrets prepared. Existing n8n and worker keys preserved.')
print('Private Field Desk handoff: automation/data/private/fielddesk-otp-production.env (mode 600).')
print('Copy its FD_STEAM_* values privately to Field Desk; no values were printed.')
