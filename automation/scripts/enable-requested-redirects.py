"""Enable the owner's request-only redirect policy without printing private settings."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket

if socket.gethostname() != 'field-desk-automation':
    raise SystemExit('Run only on the dedicated automation VM.')
root = Path(__file__).resolve().parent.parent
env_path = root / 'deploy' / '.env'
original = env_path.read_text()
lines = original.splitlines()
entries = [i for i, line in enumerate(lines) if line.startswith('MAILBOXES=')]
if len(entries) != 1:
    raise SystemExit('Expected exactly one existing MAILBOXES setting.')
try:
    boxes = json.loads(lines[entries[0]].split('=', 1)[1])
except (ValueError, TypeError):
    raise SystemExit('Invalid private mailbox configuration; no values displayed.') from None
if not isinstance(boxes, list) or len(boxes) != 1 or boxes[0].get('provider') != 'gmail':
    raise SystemExit('Expected the existing central Gmail mailbox.')
box = boxes[0]
if not isinstance(box.get('trustedForwarders'), list) or not box['trustedForwarders']:
    raise SystemExit('Configure owner-confirmed forwarding addresses privately first.')
box.update(requestOnly=True, allowRequestedRedirects=True)
lines[entries[0]] = 'MAILBOXES=' + json.dumps(boxes, separators=(',', ':'))
updated = '\n'.join(lines) + '\n'
if updated != original:
    backups = root / 'data' / 'backups'
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = backups / ('before-requested-redirects-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.env')
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(original)
    temporary = env_path.with_name('.env.requested-redirects.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(updated)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, env_path)
os.chmod(env_path, 0o600)
print('Request-only forwarded-mail policy enabled. Existing keys, mailbox ID and source addresses preserved; no values printed.')
