import contextlib
import io
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / 'scripts' / 'promote-production.py'

class ProductionConfiguration(unittest.TestCase):
    def test_private_promotion_preserves_keys_and_is_idempotent(self):
        parent = SOURCE.parent.parent / 'test-output'
        parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'deploy').mkdir()
            script = root / 'scripts' / SOURCE.name
            shutil.copyfile(SOURCE, script)
            original = 'N8N_ENCRYPTION_KEY=synthetic-encryption\nWORKER_TOKEN=synthetic-worker\nFD_API_KEY=synthetic-old\nFD_WEBHOOK_SECRET=synthetic-signing\nFIELD_DESK_BASE_URL=http://mock:8790/api/v1\nMAILBOXES=[]\n'
            env = root / 'deploy' / '.env'
            env.write_text(original)
            output = io.StringIO()
            with patch('socket.gethostname', return_value='field-desk-automation'), contextlib.redirect_stdout(output):
                runpy.run_path(str(script), run_name='__main__')
            parse = lambda text: dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
            config = parse(env.read_text())
            transfer = parse((root / 'data' / 'private' / 'fielddesk-otp-production.env').read_text())
            self.assertEqual(config['N8N_ENCRYPTION_KEY'], 'synthetic-encryption')
            self.assertEqual(config['WORKER_TOKEN'], 'synthetic-worker')
            self.assertEqual(config['FIELD_DESK_BASE_URL'], 'https://fieldesk.runs-at.dev/api/v1')
            self.assertRegex(config['FD_API_KEY'], r'^fd_[0-9a-f]{64}$')
            self.assertRegex(config['FD_WEBHOOK_SECRET'], r'^[0-9a-f]{64}$')
            self.assertEqual(transfer['FD_STEAM_API_KEY'], config['FD_API_KEY'])
            self.assertEqual(transfer['FD_STEAM_WEBHOOK_SECRET'], config['FD_WEBHOOK_SECRET'])
            self.assertEqual(transfer['FD_STEAM_WEBHOOK_URL'], 'http://10.0.0.230:5678/webhook/steam-request')
            self.assertNotIn(config['FD_API_KEY'], output.getvalue())
            self.assertNotIn(config['FD_WEBHOOK_SECRET'], output.getvalue())
            self.assertEqual(next((root / 'data' / 'backups').glob('*.env')).read_text(), original)
            promoted = env.read_text()
            with patch('socket.gethostname', return_value='field-desk-automation'), contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(script), run_name='__main__')
            self.assertEqual(env.read_text(), promoted)
            self.assertEqual(len(list((root / 'data' / 'backups').glob('*.env'))), 1)

    def test_wrong_host_stops_before_reading_configuration(self):
        with patch('socket.gethostname', return_value='unrelated-app-host'), self.assertRaises(SystemExit):
            runpy.run_path(str(SOURCE), run_name='__main__')

if __name__ == '__main__':
    unittest.main()
