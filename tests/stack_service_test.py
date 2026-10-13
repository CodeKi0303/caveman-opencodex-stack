"""No real systemd/Podman commands: inspect lifecycle, ownership and rollback."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'scripts/install-stack-service.py'
spec = importlib.util.spec_from_file_location('stack_service_installer', source)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


class FakeRuntime:
    def __init__(self, plan):
        self.plan = plan
        self.enabled = False
        self.active = False
        self.container = None
        self.linger = False
        self.dropins = ''
        self.calls = []
        self.failure = None
        self.health_failure = False

    def new_container(self, running=True):
        return {'Id': 'fixture-container', 'Config': {'Labels': {'io.caveman-stack.managed': 'true'}},
                'Mounts': [{'Type': 'bind', 'Destination': '/state', 'Source': str(self.plan.repo / 'data/state')}],
                'State': {'Running': running}}

    def __call__(self, command, timeout=240, allowed=(0,)):
        command = list(map(str, command))
        self.calls.append(command)
        if self.failure and self.failure == command:
            self.failure = None
            raise RuntimeError('Synthetic operation failure')
        out, code = '', 0
        if command[0] == 'systemctl':
            args = command[1:]
            assert ('--user' in args) == (not self.plan.system)
            action = args[1] if args[0] == '--user' else args[0]
            if action == 'show':
                exists = self.plan.unit_path.exists()
                out = '\n'.join(f'{k}={v}' for k, v in {
                    'LoadState': 'loaded' if exists else 'not-found',
                    'FragmentPath': str(self.plan.unit_path) if exists else '',
                    'DropInPaths': self.dropins,
                    'UnitFileState': 'enabled' if self.enabled else 'disabled' if exists else '',
                    'ActiveState': 'active' if self.active else 'inactive',
                }.items())
            elif action == 'start':
                self.active = True
                self.container = self.new_container()
            elif action == 'stop':
                self.active = False
                self.container = None
            elif action == 'enable':
                self.enabled = True
            elif action == 'disable':
                self.enabled = False
        elif command[0] == 'podman':
            if command[1:3] == ['container', 'exists']:
                code = 0 if self.container else 1
            elif command[1] == 'inspect':
                out = json.dumps([self.container])
            elif command[1] == 'exec' and self.health_failure:
                raise RuntimeError('Synthetic unhealthy container')
            elif command[1] == 'stop':
                self.container['State']['Running'] = False
        elif command[0] == 'loginctl':
            out = 'yes' if self.linger else 'no'
        elif command[0] == 'sudo':
            self.linger = 'enable-linger' in command
        elif command[:2] == [self.plan.python, str(self.plan.repo / 'stack')]:
            self.container = self.new_container() if command[2] == 'up' else None
        else:
            raise AssertionError(command)
        if code not in allowed:
            raise RuntimeError('Synthetic command error')
        return SimpleNamespace(stdout=out, stderr='', returncode=code)


class ServiceTests(unittest.TestCase):
    def fixture(self, system=True):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repo = Path(temporary.name) / 'checkout'
        (repo / 'data/state').mkdir(parents=True)
        (repo / '.env').write_text('STACK_NAME=caveman-stack\nIMAGE=localhost/test:fixture\n')
        (repo / 'stack').write_text('# fixture\n')
        unit = Path(temporary.name) / 'units/caveman-stack.service'
        plan = m.Plan(repo, system, os.getuid(), 'fixture-user', unit, '/usr/bin/python3')
        runtime = FakeRuntime(plan)
        return plan, runtime, m.Installer(plan, runtime)

    def test_install_reinstall_status_and_restart_keep_owned_service_and_data(self):
        for system in (True, False):
            with self.subTest(system=system):
                plan, runtime, installer = self.fixture(system)
                (plan.repo / 'data/state/ccr.db').write_bytes(b'fixture state')
                runtime.container = runtime.new_container()
                result = installer.execute('install')
                self.assertTrue(result['active'] and result['enabled'] and result['containerRunning'])
                self.assertIn([plan.python, str(plan.repo / 'stack'), 'down'], runtime.calls)
                self.assertEqual((plan.repo / 'data/state/ccr.db').read_bytes(), b'fixture state')
                first = plan.unit_path.read_bytes()
                self.assertIn(b'WantedBy=' + (b'multi-user.target' if system else b'default.target'), first)
                self.assertIn(b'TimeoutStartSec=180', first)
                self.assertTrue(installer.execute('install')['owned'])
                self.assertTrue(installer.execute('restart')['containerRunning'])
                self.assertTrue(installer.execute('status')['owned'])
                self.assertEqual(plan.unit_path.read_bytes(), first)
                self.assertFalse(any(command[0] == 'sudo' for command in runtime.calls))

    def test_dry_run_writes_nothing_and_runs_no_mutating_commands(self):
        plan, runtime, installer = self.fixture(False)
        before = sorted(str(p.relative_to(plan.repo)) for p in plan.repo.rglob('*'))
        result = installer.execute('install', dry_run=True, enable_linger=True)
        self.assertTrue(result['dryRun'] and result['willEnableLinger'])
        self.assertFalse(plan.unit_path.exists())
        self.assertEqual(before, sorted(str(p.relative_to(plan.repo)) for p in plan.repo.rglob('*')))
        self.assertFalse(any(any(verb in command for verb in ['stop', 'start', 'enable', 'disable', 'sudo']) for command in runtime.calls))

    def test_foreign_service_checksum_repo_manifest_dropins_and_mount_refused_before_stop(self):
        for condition in ['foreign', 'checksum', 'manifest_repo', 'dropin', 'label', 'mount', 'volume', 'extra_state_mount', 'symlink']:
            with self.subTest(condition=condition):
                plan, runtime, installer = self.fixture()
                installer.execute('install')
                if condition == 'foreign':
                    plan.manifest_path.unlink()
                elif condition == 'checksum':
                    plan.unit_path.write_bytes(plan.unit_path.read_bytes() + b'# changed\n')
                elif condition == 'manifest_repo':
                    record = json.loads(plan.manifest_path.read_text())
                    record['repo'] = '/other/checkout'
                    plan.manifest_path.write_text(json.dumps(record))
                elif condition == 'dropin':
                    runtime.dropins = '/etc/systemd/system/caveman-stack.service.d/other.conf'
                elif condition == 'label':
                    runtime.container['Config']['Labels'] = {}
                elif condition == 'mount':
                    runtime.container['Mounts'][0]['Source'] = '/other/data/state'
                elif condition == 'volume':
                    runtime.container['Mounts'][0]['Type'] = 'volume'
                elif condition == 'extra_state_mount':
                    runtime.container['Mounts'] *= 2
                elif condition == 'symlink':
                    original = plan.unit_path.read_bytes()
                    plan.unit_path.unlink()
                    other = plan.unit_path.parent / 'other.service'
                    other.write_bytes(original)
                    plan.unit_path.symlink_to(other)
                runtime.calls.clear()
                with self.assertRaises(RuntimeError):
                    installer.execute('install')
                self.assertFalse(any('stop' in command or 'down' in command for command in runtime.calls))

    def test_failure_restores_service_bytes_enablement_and_active_or_manual_container(self):
        for owned, enabled, active, manual in [(True, True, True, None), (True, False, False, None),
                                             (False, False, False, True), (False, False, False, False),
                                             (False, False, False, None)]:
            with self.subTest(owned=owned, enabled=enabled, active=active, manual=manual):
                plan, runtime, installer = self.fixture()
                if owned:
                    installer.execute('install')
                runtime.enabled, runtime.active = enabled, active
                runtime.container = runtime.new_container() if active else runtime.new_container(manual) if manual is not None else None
                before = {path: path.read_bytes() if path.exists() else None for path in [plan.unit_path, plan.manifest_path]}
                runtime.health_failure = True
                with self.assertRaisesRegex(RuntimeError, 'Previous service and container state restored'):
                    installer.execute('install')
                for path, data in before.items():
                    self.assertEqual(path.read_bytes() if path.exists() else None, data)
                self.assertEqual((runtime.enabled, runtime.active), (enabled, active))
                self.assertEqual(None if runtime.container is None else runtime.container['State']['Running'], True if active else manual)

    def test_explicit_linger_only_and_failed_linger_restores_service(self):
        plan, runtime, installer = self.fixture(False)
        self.assertFalse(installer.execute('install')['linger'])
        result = installer.execute('install', enable_linger=True)
        self.assertTrue(result['linger'])
        self.assertEqual([command for command in runtime.calls if command[0] == 'sudo'],
                         [['sudo', '-n', '--', 'loginctl', 'enable-linger', 'fixture-user']])
        plan, runtime, installer = self.fixture(False)
        runtime.failure = ['sudo', '-n', '--', 'loginctl', 'enable-linger', 'fixture-user']
        with self.assertRaisesRegex(RuntimeError, 'Previous service and container state restored'):
            installer.execute('install', enable_linger=True)
        self.assertFalse(runtime.active or runtime.enabled or runtime.linger)
        self.assertFalse(plan.unit_path.exists())

    def test_same_checkout_manual_service_requires_explicit_adoption_and_rejects_extra_execution(self):
        for extra in ['', 'ExecStartPre=/usr/bin/true\n', 'User=root\n', 'Environment=OTHER=1\n']:
            with self.subTest(extra=extra):
                plan, runtime, installer = self.fixture()
                plan.unit_path.parent.mkdir(parents=True)
                unit = m.render_unit(plan).decode().replace('Type=oneshot\n', 'Type=oneshot\n' + extra)
                plan.unit_path.write_text(unit)
                plan.unit_path.chmod(0o644)
                runtime.active = runtime.enabled = True
                runtime.container = runtime.new_container()
                status = installer.execute('status')
                self.assertFalse(status['owned'])
                self.assertTrue(status['installed'])
                self.assertEqual(status['adoptable'], not bool(extra))
                self.assertIsNotNone(status['ownershipError'])
                with self.assertRaisesRegex(RuntimeError, 'not owned'):
                    installer.execute('install')
                if extra:
                    with self.assertRaisesRegex(RuntimeError, 'not owned'):
                        installer.execute('install', adopt_existing=True)
                else:
                    self.assertTrue(installer.execute('install', adopt_existing=True)['owned'])

    def test_failed_adoption_restores_old_unit_without_claiming_ownership(self):
        plan, runtime, installer = self.fixture()
        plan.unit_path.parent.mkdir(parents=True)
        original = m.render_unit(plan).replace(b'TimeoutStartSec=180', b'TimeoutStartSec=120')
        plan.unit_path.write_bytes(original)
        plan.unit_path.chmod(0o644)
        runtime.enabled = runtime.active = True
        runtime.container = runtime.new_container()
        runtime.health_failure = True
        with self.assertRaisesRegex(RuntimeError, 'Previous service and container state restored'):
            installer.execute('install', adopt_existing=True)
        self.assertEqual(plan.unit_path.read_bytes(), original)
        self.assertFalse(plan.manifest_path.exists())
        self.assertTrue(runtime.enabled and runtime.active)

    def test_service_path_quote_disables_percent_and_exec_variable_expansion(self):
        plan, _, _ = self.fixture()
        plan.repo = Path('/home/a $USER/50%/"quoted"')
        unit = m.render_unit(plan).decode()
        self.assertIn('50%%', unit)
        self.assertIn('ExecStart=:', unit)
        self.assertIn('\\"quoted\\"', unit)
        with self.assertRaises(RuntimeError):
            m.quote('/path\nExecStart=/bin/false')

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze is unavailable')
    def test_real_systemd_parser_accepts_working_directory_with_spaces_and_specifiers(self):
        plan, _, _ = self.fixture()
        repo = plan.repo.parent / 'checkout with spaces 50% $USER'
        repo.mkdir()
        (repo / 'stack').write_text('# fixture\n')
        plan.repo = repo
        plan.unit_path.parent.mkdir(parents=True)
        plan.unit_path.write_bytes(m.render_unit(plan))
        result = subprocess.run(['systemd-analyze', 'verify', '--man=no', str(plan.unit_path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_scope_must_match_current_user(self):
        for uid, system in [(1000, True), (0, False)]:
            with self.subTest(uid=uid), patch.object(m.os, 'geteuid', return_value=uid), patch.object(m.pwd, 'getpwuid', return_value=SimpleNamespace(pw_name='fixture', pw_dir='/home/fixture')):
                with self.assertRaisesRegex(RuntimeError, 'actual non-root Podman user'):
                    m.make_plan(system)


if __name__ == '__main__':
    unittest.main()
