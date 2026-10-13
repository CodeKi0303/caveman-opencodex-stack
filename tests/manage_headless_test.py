"""Exercise the actual CLI on a Linux PTY without a desktop or real configuration."""

import errno
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

if sys.platform == 'linux':
    import pty
    import termios


REPO = Path(__file__).resolve().parents[1]
TIMEOUT = 15


class TerminalProcess:
    def __init__(self, command, environment):
        self.master, self.slave = pty.openpty()
        self.initial_attributes = termios.tcgetattr(self.slave)
        self.output = bytearray()
        self.cursor = 0
        self.deadline = time.monotonic() + TIMEOUT
        try:
            self.process = subprocess.Popen(
                command, cwd=REPO, env=environment, stdin=self.slave,
                stdout=self.slave, stderr=self.slave, start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            os.close(self.master)
            os.close(self.slave)
            raise

    def _remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError('CLI exceeded its 15-second deadline. Output:\n' + self.text())
        return remaining

    def _read(self, timeout):
        if not select.select([self.master], [], [], timeout)[0]:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        self.output.extend(data)
        if len(self.output) > 1024 * 1024:
            raise AssertionError('Unexpectedly large CLI output.')

    def expect(self, text):
        needle = text.encode('utf-8')
        while True:
            at = self.output.find(needle, self.cursor)
            if at >= 0:
                self.cursor = at + len(needle)
                return
            self._read(min(0.1, self._remaining()))
            if self.process.poll() is not None:
                self._read(0)
                at = self.output.find(needle, self.cursor)
                if at >= 0:
                    self.cursor = at + len(needle)
                    return
                raise AssertionError('CLI exited before expected prompt {!r}. Output:\n{}'.format(text, self.text()))

    def send(self, data):
        self._remaining()
        os.write(self.master, data.encode('utf-8') if isinstance(data, str) else data)

    def finish(self):
        while self.process.poll() is None:
            self._read(min(0.1, self._remaining()))
        self._read(0)
        return self.process.wait(timeout=self._remaining())

    def text(self):
        return bytes(self.output).decode('utf-8', errors='replace')

    def assert_restored(self, testcase):
        current = termios.tcgetattr(self.slave)
        flags = termios.ECHO | termios.ICANON | termios.ISIG
        testcase.assertEqual(current[3] & flags, self.initial_attributes[3] & flags)

    def close(self):
        # A launcher can have a Node child: terminate the isolated process group,
        # not a host service or any process outside this fixture.
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.process.wait(timeout=3)
        os.close(self.master)
        os.close(self.slave)


@unittest.skipUnless(sys.platform == 'linux', 'Linux PTY integration test')
class ManageHeadlessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = os.environ.get('NODE_BINARY') or shutil.which('node')
        if not cls.node:
            raise unittest.SkipTest('Node.js is unavailable; set NODE_BINARY to Node.js 22.13 or later.')
        version = subprocess.run([cls.node, '--version'], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (22, 13, 0):
            raise unittest.SkipTest('Set NODE_BINARY to Node.js 22.13 or later (found {}).'.format(version))

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='caveman-headless-')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.codex_home = self.home / '.codex'
        self.codex_home.mkdir()
        # An existing login/config sentinel must survive read-only and cancelled
        # interactions; it is deliberately synthetic and never sent anywhere.
        (self.codex_home / 'auth.json').write_text('{"fixture":"synthetic-login"}\n', encoding='utf-8')
        (self.codex_home / 'config.toml').write_text('# existing unrelated settings\nmodel = "fixture"\n', encoding='utf-8')
        self.before = self.snapshot()
        self.environment = dict(os.environ)
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'DESKTOP_SESSION', 'SESSION_MANAGER', 'DBUS_SESSION_BUS_ADDRESS', 'NODE_OPTIONS'):
            self.environment.pop(name, None)
        self.environment.update({
            'HOME': str(self.home), 'CODEX_HOME': str(self.codex_home),
            'XDG_CONFIG_HOME': str(self.home / '.config'),
            'XDG_DATA_HOME': str(self.home / '.local/share'),
            'TERM': 'xterm', 'NO_COLOR': '1',
        })

    def snapshot(self):
        return {str(file.relative_to(self.home)): file.read_bytes()
                for file in self.home.rglob('*') if file.is_file()}

    def terminal(self, args):
        terminal = TerminalProcess([self.node, *args], self.environment)
        self.addCleanup(terminal.close)
        return terminal

    def assert_no_changes(self):
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse((self.codex_home / 'caveman-stack').exists())
        self.assertFalse((self.home / '.config').exists())

    def test_status_then_exit_works_without_a_desktop_and_does_not_write(self):
        for extra in ([], ['--headless']):
            with self.subTest(options=extra):
                terminal = self.terminal([str(REPO / 'scripts/manage-launch.mjs'), *extra])
                terminal.expect('관리 모드: 터미널 전용 · GUI/브라우저가 필요하지 않습니다.')
                terminal.expect('선택 [0]: ')
                terminal.send('3\r')
                terminal.expect('아직 연결이 없습니다.')
                terminal.expect('선택 [0]: ')
                terminal.send('0\r')
                self.assertEqual(terminal.finish(), 0, terminal.text())
                terminal.assert_restored(self)
                self.assert_no_changes()

    def test_cancelling_a_masked_key_returns_to_menu_without_saving(self):
        terminal = self.terminal([str(REPO / 'scripts/manage.mjs'), '--headless'])
        terminal.expect('선택 [0]: ')
        terminal.send('1\r')
        terminal.expect('Pod API 주소: ')
        # The operation is cancelled before validation or any network request.
        terminal.send('http://127.0.0.1:9/v1\r')
        terminal.expect('선택 [2]: ')
        terminal.send('2\r')
        terminal.expect('입력 내용은 표시되지 않습니다): ')
        secret = 'synthetic-headless-key-not-saved-123456'
        terminal.send(secret)
        terminal.expect('*' * len(secret))
        terminal.send(b'\x03')
        terminal.expect('현재 입력을 취소했습니다.')
        terminal.expect('선택 [0]: ')
        terminal.send('0\r')
        self.assertEqual(terminal.finish(), 0, terminal.text())
        self.assertNotIn(secret, terminal.text())
        terminal.assert_restored(self)
        self.assert_no_changes()

    def test_secret_ctrl_c_restores_terminal_before_another_prompt(self):
        module_uri = (REPO / 'scripts/manage.mjs').as_uri()
        source = (
            'const {createTerminalIO}=await import(' + json.dumps(module_uri) + ');'
            'try {await createTerminalIO().secret("MASKED_KEY_TEST"); process.exitCode=2;}'
            'catch(error) {console.log("SECRET_CANCELLED="+(error.message==="CANCELLED"));'
            'console.log("RAW_RESTORED="+(process.stdin.isRaw===false));}'
            'process.stdin.pause();'
        )
        terminal = self.terminal(['--input-type=module', '--eval', source])
        terminal.expect('MASKED_KEY_TEST: ')
        secret = 'synthetic-isolated-secret-123456789'
        terminal.send(secret)
        terminal.expect('*' * len(secret))
        terminal.send(b'\x03')
        terminal.expect('SECRET_CANCELLED=true')
        terminal.expect('RAW_RESTORED=true')
        self.assertEqual(terminal.finish(), 0, terminal.text())
        self.assertNotIn(secret, terminal.text())
        terminal.assert_restored(self)
        self.assert_no_changes()


if __name__ == '__main__':
    unittest.main()
