#!/usr/bin/env python3
"""Install the current checkout's Podman stack as an owned systemd service."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass

OWNER = 'caveman-opencodex-stack'
UNIT = 'caveman-stack.service'
ROOT = Path(__file__).resolve().parents[1]


def quote(value):
    text = str(value)
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise RuntimeError('A service path contains a control character.')
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def digest(data):
    return hashlib.sha256(data).hexdigest()


@dataclass
class Plan:
    repo: Path
    system: bool
    uid: int
    username: str
    unit_path: Path
    python: str

    @property
    def manifest_path(self):
        return self.repo / 'data/stack-service-install.json'


def make_plan(system=None, repo=ROOT):
    uid = os.geteuid()
    account = pwd.getpwuid(uid)
    system = uid == 0 if system is None else system
    if system != (uid == 0):
        raise RuntimeError('--system requires root; --user requires the actual non-root Podman user.')
    repo = Path(repo).resolve(strict=True)
    if not Path.cwd().resolve().is_relative_to(repo):
        raise RuntimeError('Run this installer from inside its Git checkout.')
    home = Path(account.pw_dir).resolve()
    if not system and Path(os.environ.get('HOME', str(home))).resolve() != home:
        raise RuntimeError('HOME must match the current Linux user; do not use sudo for --user.')
    directory = Path('/etc/systemd/system') if system else Path(os.environ.get('XDG_CONFIG_HOME', home / '.config')) / 'systemd/user'
    if not directory.is_absolute():
        raise RuntimeError('The systemd configuration directory must be absolute.')
    for path in [repo, repo / 'stack', repo / '.env', repo / 'data']:
        if path.is_symlink() or not path.exists() or path.stat().st_uid != uid:
            raise RuntimeError('Initialize the checkout as the same Linux user who will run Podman.')
        # Root service code must not be group-writable. A user's checkout may
        # intentionally use umask 002 for its trusted Unix group; never elevate
        # such a checkout to root, and always reject world-writable sources.
        if path.stat().st_mode & (0o022 if system else 0o002):
            raise RuntimeError('The checkout, stack, .env and data have unsafe write permissions for this service scope.')
    return Plan(repo, system, uid, account.pw_name, directory / UNIT, str(Path(sys.executable).resolve()))


def render_unit(plan):
    return (f'# Managed by {OWNER}; Podman stack\n[Unit]\n'
            'Description=Caveman OpenCodex Podman stack\nAfter=network-online.target\nWants=network-online.target\n\n'
            '[Service]\nType=oneshot\nRemainAfterExit=yes\n'
            f'WorkingDirectory={quote(plan.repo)}\n'
            f'ExecStart=:{quote(plan.python)} {quote(plan.repo / "stack")} up\n'
            f'ExecStop=:{quote(plan.python)} {quote(plan.repo / "stack")} down\n'
            'TimeoutStartSec=180\nTimeoutStopSec=90\nUMask=0077\n\n[Install]\n'
            f'WantedBy={"multi-user.target" if plan.system else "default.target"}\n').encode()


def adoptable_unit(plan, unit):
    """Recognize only the old documented minimal unit; reject executable additions."""
    allowed = {'Unit': {'Description', 'After', 'Wants'},
               'Service': {'Type', 'RemainAfterExit', 'WorkingDirectory', 'ExecStart', 'ExecStop',
                           'TimeoutStartSec', 'TimeoutStopSec', 'UMask'},
               'Install': {'WantedBy'}}
    sections = {name: {} for name in allowed}
    section = None
    try:
        for line in unit.decode().splitlines():
            line = line.strip()
            if not line or line.startswith(('#', ';')):
                continue
            if line.startswith('[') and line.endswith(']'):
                section = line[1:-1]
                if section not in allowed:
                    return False
                continue
            key, separator, value = line.partition('=')
            if not separator or section not in allowed or key not in allowed[section] or key in sections[section] or line.endswith('\\'):
                return False
            sections[section][key] = value
        service = sections['Service']
        for directive in ('After', 'Wants'):
            if any(target not in ('network.target', 'network-online.target') for target in sections['Unit'].get(directive, '').split()):
                return False
        def parse(value):
            # Adoption intentionally excludes systemd substitutions/escaping. The
            # freshly generated installer unit supports arbitrary safe path names.
            if any(mark in value for mark in ('$', '%', '\\', '\n')):
                raise ValueError()
            return shlex.split(value)
        directory = parse(service['WorkingDirectory'])
        if len(directory) != 1 or Path(directory[0]).resolve() != plan.repo:
            return False
        if service['Type'] != 'oneshot' or service['RemainAfterExit'] != 'yes':
            return False
        for directive, action in [('ExecStart', 'up'), ('ExecStop', 'down')]:
            value = service[directive]
            command = parse(value[1:] if value.startswith(':') else value)
            if command not in [[str(plan.repo / 'stack'), action], [plan.python, str(plan.repo / 'stack'), action]]:
                return False
        if sections['Install'].get('WantedBy') != ('multi-user.target' if plan.system else 'default.target'):
            return False
        return True
    except (ValueError, KeyError, UnicodeError):
        return False


def run(command, timeout=240, allowed=(0,)):
    try:
        result = subprocess.run(list(map(str, command)), capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(f'{Path(command[0]).name} failed or timed out; inspect local service logs.') from None
    if result.returncode not in allowed:
        # Podman/systemd output may include environment values; do not echo it.
        raise RuntimeError(f'{Path(command[0]).name} operation failed (exit {result.returncode}); inspect local service logs.')
    return result


def read_regular(path):
    try:
        item = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(item.st_mode):
        raise RuntimeError('Installer unit and ownership paths must be regular files, not links.')
    return path.read_bytes()


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Installer:
    def __init__(self, plan, runner=run):
        self.plan, self.run = plan, runner
        self.settings = {}
        for line in (plan.repo / '.env').read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, separator, value = line.partition('=')
            if not separator:
                raise RuntimeError('Invalid .env; expected KEY=VALUE.')
            self.settings[key.strip()] = value.strip()
        self.name = self.settings.get('STACK_NAME', '')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', self.name):
            raise RuntimeError('Invalid STACK_NAME in .env.')

    def ctl(self, *args):
        return self.run(['systemctl', *([] if self.plan.system else ['--user']), *args])

    def state(self):
        result = self.ctl('show', UNIT, '--no-pager', '--property=LoadState,FragmentPath,DropInPaths,UnitFileState,ActiveState')
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def container(self):
        exists = self.run(['podman', 'container', 'exists', self.name], allowed=(0, 1))
        if exists.returncode:
            return None
        try:
            rows = json.loads(self.run(['podman', 'inspect', self.name]).stdout)
            row = rows[0]
            mounts = [mount for mount in row['Mounts'] if mount.get('Destination') == '/state']
            valid = (len(rows) == 1 and row['Config'].get('Labels', {}).get('io.caveman-stack.managed') == 'true'
                     and len(mounts) == 1 and mounts[0].get('Type') == 'bind'
                     and Path(mounts[0]['Source']).resolve() == (self.plan.repo / 'data/state').resolve())
            if not valid:
                raise ValueError()
            return {'running': bool(row['State']['Running']), 'id': row['Id']}
        except (ValueError, KeyError, TypeError, IndexError):
            raise RuntimeError('The existing container is not owned by this checkout (label and state mount must match).') from None

    def verify(self, state, unit, record, adopt_existing=False):
        if state.get('DropInPaths'):
            raise RuntimeError('The stack service has external overrides; inspect them before installing.')
        if not unit:
            if state.get('FragmentPath') or state.get('LoadState') not in ('not-found', ''):
                raise RuntimeError('A stack service from another location already exists.')
            if record:
                raise RuntimeError('The ownership record exists but its service is missing; inspect the installation.')
            return False
        try:
            manifest = json.loads(record or b'null')
            valid = (isinstance(manifest, dict) and manifest.get('managedBy') == OWNER
                     and manifest.get('repo') == str(self.plan.repo)
                     and manifest.get('uid') == self.plan.uid
                     and manifest.get('scope') == ('system' if self.plan.system else 'user')
                     and manifest.get('unitPath') == str(self.plan.unit_path)
                     and manifest.get('unitSha256') == digest(unit)
                     and state.get('FragmentPath') == str(self.plan.unit_path))
        except (ValueError, TypeError):
            valid = False
        if not valid:
            if not (adopt_existing and record is None and state.get('FragmentPath') == str(self.plan.unit_path) and adoptable_unit(self.plan, unit)):
                raise RuntimeError('The existing stack service is not owned by this installer; it will not be overwritten. --adopt-existing accepts only a verified minimal same-checkout unit.')
        if state.get('UnitFileState') not in ('enabled', 'disabled') or state.get('ActiveState') not in ('active', 'inactive', 'failed'):
            raise RuntimeError('The existing service is transitioning or has an unsupported enablement state.')
        return True

    def linger(self):
        if self.plan.system:
            return None
        try:
            value = self.run(['loginctl', 'show-user', self.plan.username, '--property=Linger', '--value']).stdout.strip()
            return {'yes': True, 'no': False}.get(value)
        except RuntimeError:
            return None

    def summary(self, state, container, owned):
        linger = self.linger()
        warnings = []
        if not self.plan.system and linger is not True:
            warnings.append('User services may stop at logout and start only at login. Choose --enable-linger to allow boot/logout persistence.')
        if 'microsoft' in os.uname().release.lower():
            warnings.append('WSL services start when this distribution starts; Windows boot does not automatically launch WSL.')
        return {'ok': True, 'service': UNIT, 'scope': 'system' if self.plan.system else 'user',
                'repo': str(self.plan.repo), 'owned': owned, 'active': state.get('ActiveState') == 'active',
                'enabled': state.get('UnitFileState') == 'enabled', 'containerRunning': bool(container and container['running']),
                'linger': linger, 'warnings': warnings}

    def stack(self, action):
        # Fixed operations only; no shell, .env sourcing, or secret arguments.
        return self.run([self.plan.python, str(self.plan.repo / 'stack'), action])

    def execute(self, action, dry_run=False, enable_linger=False, adopt_existing=False):
        state = self.state()
        unit = read_regular(self.plan.unit_path)
        record = read_regular(self.plan.manifest_path)
        for path in (self.plan.unit_path, self.plan.manifest_path):
            if path.exists() and (path.stat().st_uid != self.plan.uid or path.stat().st_mode & (0o022 if self.plan.system else 0o002)):
                raise RuntimeError('Service installation files must be owned by the service user and not writable by others.')
        ownership_error = None
        adoptable = False
        try:
            owned = self.verify(state, unit, record, adopt_existing)
        except RuntimeError as error:
            if action != 'status':
                raise
            # Reading a manually installed unit must remain possible so the
            # wizard can ask whether to adopt it before any mutation occurs.
            owned = False
            ownership_error = str(error)
            try:
                adoptable = record is None and self.verify(state, unit, record, adopt_existing=True)
            except RuntimeError:
                pass
        container = self.container()
        if action == 'status':
            return {**self.summary(state, container, owned), 'installed': bool(unit or state.get('FragmentPath')),
                    'adoptable': bool(adoptable), 'ownershipError': ownership_error}
        if action == 'restart' and not owned:
            raise RuntimeError('Install this checkout\'s owned service before restarting it.')
        if enable_linger and self.plan.system:
            raise RuntimeError('--enable-linger only applies to --user installations.')
        if dry_run:
            return {**self.summary(state, container, owned), 'dryRun': True, 'action': action,
                    'unitPath': str(self.plan.unit_path), 'unit': render_unit(self.plan).decode(),
                    'willEnableLinger': enable_linger}
        image_file = self.plan.repo / 'data/active-image'
        image = image_file.read_text().strip() if image_file.exists() else self.settings.get('IMAGE', '')
        if not image:
            raise RuntimeError('Build the stack image before installing its service.')
        self.run(['podman', 'image', 'exists', image])
        previous_linger = self.linger()
        if enable_linger and previous_linger is None:
            raise RuntimeError('Cannot determine the existing linger setting; no service changes were made.')
        backup = self.plan.repo / 'data/stack-service-backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
        backup.mkdir(parents=True, mode=0o700)
        before = [(self.plan.unit_path, unit), (self.plan.manifest_path, record)]
        modes = {path: stat.S_IMODE(path.stat().st_mode) if data is not None else 0o600 for path, data in before}
        for path, data in before:
            if data is not None:
                atomic_write(backup / path.name, data, 0o600)
        atomic_write(backup / 'service-state.json', json.dumps(state).encode(), 0o600)
        touched = False
        unit_written = False
        linger_attempted = False
        try:
            touched = True
            if owned:
                self.ctl('stop', UNIT)
            # A manually launched container may exist even with an inactive service.
            if self.container():
                self.stack('down')
            if action == 'install':
                new_unit = render_unit(self.plan)
                manifest = {'version': 1, 'managedBy': OWNER, 'repo': str(self.plan.repo), 'uid': self.plan.uid,
                            'scope': 'system' if self.plan.system else 'user', 'unitPath': str(self.plan.unit_path),
                            'unitSha256': digest(new_unit)}
                atomic_write(self.plan.unit_path, new_unit, 0o644)
                unit_written = True
                atomic_write(self.plan.manifest_path, (json.dumps(manifest, indent=2) + '\n').encode(), 0o600)
                self.ctl('daemon-reload')
                self.ctl('enable', UNIT)
            self.ctl('start', UNIT)
            current = self.container()
            fresh = self.state()
            if (fresh.get('ActiveState') != 'active' or not current or not current['running'] or
                    (action == 'install' and fresh.get('UnitFileState') != 'enabled')):
                raise RuntimeError('The service did not start a running container.')
            self.run(['podman', 'exec', self.name, 'node', '/app/scripts/health.mjs'], timeout=30)
            if enable_linger and previous_linger is False:
                linger_attempted = True
                self.run(['sudo', '-n', '--', 'loginctl', 'enable-linger', self.plan.username])
                if self.linger() is not True:
                    raise RuntimeError('Linger did not become enabled.')
            return {**self.summary(fresh, current, True), 'backup': str(backup)}
        except BaseException as error:
            failures = []
            def restore(operation):
                try:
                    operation()
                except BaseException:
                    failures.append(True)
            if touched:
                if owned or unit_written:
                    restore(lambda: self.ctl('stop', UNIT))
                # Recheck ownership before every direct container removal.
                def remove_candidate():
                    if self.container():
                        self.stack('down')
                restore(remove_candidate)
                if (owned or unit_written) and (not owned or state.get('UnitFileState') != 'enabled'):
                    restore(lambda: self.ctl('disable', UNIT))
                for path, data in before:
                    restore(lambda path=path, data=data: atomic_write(path, data, modes[path]) if data is not None else path.unlink(missing_ok=True))
                restore(lambda: self.ctl('daemon-reload'))
                if owned and state.get('UnitFileState') == 'enabled':
                    restore(lambda: self.ctl('enable', UNIT))
                if owned and state.get('ActiveState') == 'active':
                    restore(lambda: self.ctl('start', UNIT))
                elif container:
                    restore(lambda: self.stack('up'))
                    if not container['running']:
                        restore(lambda: self.run(['podman', 'stop', '--time', '30', self.name]))
            if linger_attempted:
                restore(lambda: self.run(['sudo', '-n', '--', 'loginctl', 'disable-linger', self.plan.username]))
            message = 'Automatic restoration was incomplete' if failures else 'Previous service and container state restored'
            raise RuntimeError(f'{error}. {message}; backup: {backup}') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'status', 'restart'])
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--system', dest='system', action='store_true')
    scope.add_argument('--user', dest='system', action='store_false')
    parser.set_defaults(system=None)
    parser.add_argument('--enable-linger', action='store_true')
    parser.add_argument('--adopt-existing', action='store_true', help='install: take ownership only of a verified minimal same-checkout unit')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if args.enable_linger and args.action != 'install':
        parser.error('--enable-linger is only valid with install')
    if args.adopt_existing and args.action != 'install':
        parser.error('--adopt-existing is only valid with install')
    if sys.platform != 'linux':
        raise RuntimeError('Linux with systemd is required.')
    os.umask(0o077)
    plan = make_plan(args.system)
    manager = Installer(plan)
    if args.dry_run or args.action == 'status':
        return manager.execute(args.action, args.dry_run, args.enable_linger, args.adopt_existing)
    # Kernel locks release on interruption; never delete the shared lock inode.
    lock_path = plan.repo / 'data/stack-service-install.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return manager.execute(args.action, args.dry_run, args.enable_linger, args.adopt_existing)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), indent=2))
    except (RuntimeError, OSError, ValueError) as failure:
        message = str(failure) if isinstance(failure, RuntimeError) else 'Service installation failed; inspect local state and installer lock.'
        print(json.dumps({'ok': False, 'error': message}), file=sys.stderr)
        sys.exit(1)
