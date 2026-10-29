"""Prepare inactive mock-only n8n imports on the VM without printing secrets."""
import json
import os
from pathlib import Path
import uuid
import hashlib

root = Path(__file__).resolve().parent.parent
config = dict(line.split('=', 1) for line in (root / 'deploy' / '.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
if config.get('FIELD_DESK_BASE_URL') != 'http://mock:8790/api/v1':
    raise SystemExit('This bootstrap imports only against the mock API.')
target = root / 'data' / 'n8n-import'
target.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(target, 0o700)
credential_id = 'fdOtpWorker000001'
credential = [{'id': credential_id, 'name': 'OTP Worker', 'type': 'httpHeaderAuth', 'data': {'name': 'Authorization', 'value': 'Bearer ' + config['WORKER_TOKEN']}}]
def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output)
workflows = []
ids = {}
for source in sorted((root / 'workflows').glob('*.json')):
    workflow = json.loads(source.read_text())
    workflow['id'] = 'fd' + hashlib.sha256(source.name.encode()).hexdigest()[:14]
    workflow['versionId'] = str(uuid.uuid4())
    workflow['active'] = False
    for node in workflow['nodes']:
        binding = node.get('credentials', {}).get('httpHeaderAuth')
        if binding and binding.get('name') == 'OTP Worker':
            binding['id'] = credential_id
    workflows.append(workflow)
    ids[source.name] = workflow['id']
private_json(target / 'credentials.json', credential)
private_json(target / 'workflows.json', workflows)
private_json(target / 'workflow-ids.json', ids)
print('Prepared inactive imports in automation/data/n8n-import; credential values not printed.')
