"""Real Linux process tests; no X server or WeChat account is involved."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


@unittest.skipUnless(sys.platform == 'linux', 'Linux flock/pidfd ownership tests')
class WatcherLockTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='wx-lock-test-')
        self.root = Path(self.directory.name)
        self.runner = self.root / 'wxwatch.py'
        self.runner.write_text(
            'import sys,time\n'
            f'sys.path.insert(0,{str(SCRIPTS)!r})\n'
            'from wxlock import watcher_lock,display_lock\n'
            'lock=display_lock("watcher",blocking=False) if "legacy" in sys.argv else watcher_lock(__file__)\n'
            'with lock:\n'
            ' print("ready",flush=True)\n'
            ' if "hold" in sys.argv: time.sleep(60)\n', encoding='utf8')
        self.env = dict(os.environ, HOME=str(self.root), WX_DISPLAY=':871')
        self.processes = []
        self.orphans = []

    def tearDown(self):
        for process in self.processes:
            process.terminate()
            process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
        for pid in self.orphans:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.directory.cleanup()

    def holder(self):
        process = subprocess.Popen([sys.executable, str(self.runner), 'hold'], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        self.assertEqual(process.stdout.readline().strip(), 'ready')
        return process

    def probe(self, **env):
        return subprocess.run([sys.executable, str(self.runner)], env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=5)

    def test_preserves_live_owner_and_allows_another_display(self):
        holder = self.holder()
        duplicate = self.probe()
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn('stop its owning host', duplicate.stderr)
        self.assertIsNone(holder.poll())
        self.assertEqual(self.probe(WX_DISPLAY=':872').returncode, 0)
        help_result = subprocess.run([sys.executable, str(SCRIPTS / 'wxwatch.py'), '--help'],
                                     env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)

    def test_recovers_verified_legacy_orphan_in_the_same_repository(self):
        log = self.root / 'orphan.log'
        launcher = (
            'import subprocess,sys\n'
            f'f=open({str(log)!r},"w")\n'
            f'p=subprocess.Popen([sys.executable,{str(self.runner)!r},"legacy","hold"],stdout=f,stderr=f)\n'
            'print(p.pid)\n'
        )
        result = subprocess.run([sys.executable, '-c', launcher], env=self.env,
                                capture_output=True, text=True, check=True, timeout=5)
        pid = int(result.stdout)
        self.orphans.append(pid)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and (not log.exists() or 'ready' not in log.read_text()):
            time.sleep(0.02)
        self.assertIn('ready', log.read_text())
        result = self.probe()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_forged_pid_metadata_cannot_terminate_a_live_process(self):
        holder = self.holder()
        lock = next((self.root / '.local/state/dsh-wechat-mate').glob('*-watcher.lock'))
        lock.write_text(json.dumps({'pid': os.getpid(), 'parent': 1}), encoding='utf8')
        self.assertNotEqual(self.probe().returncode, 0)
        self.assertIsNone(holder.poll())


if __name__ == '__main__':
    unittest.main()
