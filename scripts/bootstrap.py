#!/usr/bin/env python3
"""Prepare the explicit, per-user Linux runtime used by ./manage.

No sudo, package-manager changes, login data, or automatic background work.
Read-only commands never download or modify bootstrap state.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

NODE_VERSION = "24.21.0"
MIN_NODE = (22, 13, 0)
OWNER = "caveman-opencodex-stack/bootstrap-v1"
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_UNPACKED = 768 * 1024 * 1024


class BootstrapError(Exception):
    pass


def parse_options(args: list[str]) -> dict:
    """Validate the manager contract before any dependency preparation."""
    options, index = {}, 0
    while index < len(args):
        arg = args[index]
        if arg in {"--help", "-h", "--status", "--setup", "--repair"}:
            key = "help" if arg == "-h" else arg[2:]
            if key in options:
                raise BootstrapError("중복 옵션입니다. ./manage --help를 확인하세요.")
            options[key] = True
        elif arg in {"--system", "--user"}:
            if "scope" in options:
                raise BootstrapError("--system 또는 --user 중 하나만 지정하세요.")
            options["scope"] = arg[2:]
        elif arg == "--codex-home":
            if "codexHome" in options or index + 1 >= len(args) or not args[index + 1] or args[index + 1].startswith("--"):
                raise BootstrapError("--codex-home 뒤에 경로를 한 번만 지정하세요.")
            index += 1
            options["codexHome"] = args[index]
        else:
            raise BootstrapError("지원하지 않는 옵션입니다. ./manage --help를 확인하세요.")
        index += 1
    if sum(bool(options.get(key)) for key in ("status", "setup", "repair")) > 1:
        raise BootstrapError("--status, --setup, --repair는 함께 사용할 수 없습니다.")
    return options


def native_env(node: Path | None = None) -> dict[str, str]:
    env = dict(os.environ)
    # npm and runtime probes must not inherit arbitrary Node startup hooks.
    env.pop("NODE_OPTIONS", None)
    if node:
        env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
        env["CAVEMAN_NODE_PATH"] = str(node)
    return env


def run_capture(args: list[str], *, timeout: int = 15, env=None) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                            env=env or native_env(), check=True)
    return result.stdout.strip()


def probe_node(candidate: Path) -> Path | None:
    """Reject Windows executables before execution, including WSL interop paths."""
    try:
        candidate = candidate.resolve(strict=True)
        with candidate.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                return None
        data = json.loads(run_capture([str(candidate), "-p",
            "JSON.stringify({platform:process.platform,version:process.versions.node,execPath:process.execPath})"]))
        version = tuple(int(x) for x in data["version"].split("."))
        actual = Path(data["execPath"]).resolve(strict=True)
        if data["platform"] != "linux" or len(version) != 3 or version < MIN_NODE or actual != candidate:
            return None
        return actual
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def find_node(runtime: Path, env=None) -> Path | None:
    search = env or os.environ
    candidates = []
    if search.get("CAVEMAN_NODE_PATH"):
        candidates.append(Path(search["CAVEMAN_NODE_PATH"]))
    candidates += [Path(folder) / "node" for folder in search.get("PATH", "").split(os.pathsep) if folder]
    candidates.append(runtime / "bin/node")
    seen = set()
    for candidate in candidates:
        if str(candidate) in seen:
            continue
        seen.add(str(candidate))
        usable = probe_node(candidate)
        if usable:
            return usable
    return None


def find_npm(node: Path) -> Path | None:
    candidates = [node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"]
    npm_path = shutil.which("npm", path=native_env(node)["PATH"])
    if npm_path:
        candidates.append(Path(npm_path))
    candidates.append(Path("/usr/share/nodejs/npm/bin/npm-cli.js"))
    for candidate in candidates:
        try:
            candidate = candidate.resolve(strict=True)
            if candidate.name != "npm-cli.js" or not candidate.is_file():
                continue
            version = run_capture([str(node), str(candidate), "--version"], env=native_env(node))
            if re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.-]+)?", version):
                return candidate
        except (OSError, subprocess.SubprocessError):
            pass
    return None


def require_private_directory(path: Path) -> None:
    if path.is_symlink():
        raise BootstrapError(f"설치 경로가 심볼릭 링크입니다. 기존 경로를 확인하세요: {path}")
    if path.exists():
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode) or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
            raise BootstrapError(f"설치 경로의 소유자가 현재 사용자와 다릅니다: {path}")
        if info.st_mode & 0o022:
            raise BootstrapError(f"다른 사용자가 쓸 수 있는 설치 경로는 사용하지 않습니다: {path}")
    else:
        path.mkdir(mode=0o700, parents=True)


@contextlib.contextmanager
def private_lock(path: Path):
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError as error:
        raise BootstrapError(f"다른 설치가 진행 중이거나 이전 잠금이 남아 있습니다. 실행 상태를 확인하세요: {path}") from error
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump({"pid": os.getpid(), "created": int(time.time()), "owner": OWNER}, stream)
        yield
    finally:
        path.unlink(missing_ok=True)


def download_url(url: str) -> None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "nodejs.org" or parts.port not in (None, 443) or parts.username or parts.password or parts.query or parts.fragment:
        raise BootstrapError("Node.js 다운로드 주소는 공식 HTTPS 배포 주소여야 합니다.")


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        download_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download(url: str, destination: Path, limit: int) -> None:
    download_url(url)
    opener = urllib.request.build_opener(OfficialRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "caveman-stack-bootstrap/1"})
    try:
        with opener.open(request, timeout=60) as response, destination.open("xb") as target:
            download_url(response.geturl())
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > limit:
                    raise BootstrapError("Node.js 다운로드가 허용 크기를 초과했습니다.")
                target.write(chunk)
    except (OSError, urllib.error.URLError) as error:
        raise BootstrapError("공식 Node.js 다운로드에 실패했습니다. 인터넷 연결과 HTTPS 인증서를 확인하세요.") from error


def expected_checksum(text: str, archive_name: str) -> str:
    matches = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].lstrip("*") == archive_name:
            if not re.fullmatch(r"[a-fA-F0-9]{64}", fields[0]):
                raise BootstrapError("Node.js 체크섬 형식이 올바르지 않습니다.")
            matches.append(fields[0].lower())
    if len(matches) != 1:
        raise BootstrapError("공식 체크섬 목록에서 정확한 Node.js 파일을 찾지 못했습니다.")
    return matches[0]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extract(archive: Path, destination: Path, top_level: str) -> Path:
    """Only bounded directories, ordinary files, and contained relative symlinks."""
    if destination.exists():
        raise BootstrapError("압축 해제 경로가 이미 있습니다.")
    destination.mkdir(mode=0o700)
    root = destination.resolve()
    with tarfile.open(archive, "r:xz") as tar:
        members, names, total = [], set(), 0
        for member in tar:
            name = PurePosixPath(member.name)
            if (name.is_absolute() or ".." in name.parts or "\\" in member.name or
                    not name.parts or name.parts[0] != top_level or str(name) in names):
                raise BootstrapError("안전하지 않거나 중복된 Node.js 압축 경로입니다.")
            names.add(str(name))
            if not (member.isdir() or member.isfile() or member.issym()):
                raise BootstrapError("지원하지 않는 Node.js 압축 항목입니다.")
            total += member.size
            if len(names) > 30000 or member.size > 256 * 1024 * 1024 or total > MAX_UNPACKED:
                raise BootstrapError("Node.js 압축 해제 크기 제한을 초과했습니다.")
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or "\\" in member.linkname:
                    raise BootstrapError("안전하지 않은 Node.js 심볼릭 링크입니다.")
                resolved = (root / name.parent / member.linkname).resolve()
                if not resolved.is_relative_to(root / top_level):
                    raise BootstrapError("Node.js 링크가 설치 경로 밖을 가리킵니다.")
            members.append((member, name))
        # Reject entries beneath a symlink before writing anything.
        links = {name for member, name in members if member.issym()}
        if any(any(parent in links for parent in name.parents) for _, name in members):
            raise BootstrapError("Node.js 압축 항목이 심볼릭 링크 안에 있습니다.")
        for member, name in members:
            if member.issym():
                continue
            target = root / name
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(mode=0o755, exist_ok=True)
            else:
                with tar.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        for member, name in members:
            if member.issym():
                target = root / name
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
    return root / top_level


def runtime_owned(runtime: Path) -> bool:
    try:
        marker = runtime / ".caveman-runtime.json"
        info = runtime.stat()
        return (not runtime.is_symlink() and not marker.is_symlink() and
                (not hasattr(os, "getuid") or info.st_uid == os.getuid()) and not info.st_mode & 0o022 and
                json.loads(marker.read_text())["managedBy"] == OWNER)
    except (OSError, ValueError, KeyError):
        return False


def install_runtime(base: Path, machine: str | None = None) -> Path:
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine or platform.machine().lower())
    if not arch:
        raise BootstrapError("자동 Node.js 설치는 Linux x64와 arm64에서 지원합니다. Node.js 22.13 이상을 직접 설치하세요.")
    require_private_directory(base)
    runtime = base / "node-runtime"
    with private_lock(base / ".node-install.lock"):
        if runtime.exists() or runtime.is_symlink():
            if not runtime_owned(runtime):
                raise BootstrapError(f"기존 Node.js 경로를 자동으로 덮어쓰지 않습니다. 소유자와 설치 상태를 확인하세요: {runtime}")
        name = f"node-v{NODE_VERSION}-linux-{arch}"
        archive_name = name + ".tar.xz"
        with tempfile.TemporaryDirectory(prefix=".node-install-", dir=base) as temporary:
            temp = Path(temporary)
            sums, archive = temp / "SHASUMS256.txt", temp / archive_name
            origin = f"https://nodejs.org/dist/v{NODE_VERSION}/"
            download(origin + "SHASUMS256.txt", sums, 256 * 1024)
            expected = expected_checksum(sums.read_text(encoding="utf-8"), archive_name)
            download(origin + archive_name, archive, MAX_ARCHIVE)
            if sha256_file(archive) != expected:
                raise BootstrapError("Node.js 다운로드의 SHA-256 검증에 실패했습니다. 설치를 중단합니다.")
            extracted = safe_extract(archive, temp / "unpacked", name)
            node = probe_node(extracted / "bin/node")
            if not node or not find_npm(node):
                raise BootstrapError("다운로드한 Node.js/npm을 실행할 수 없습니다. Linux 배포판의 glibc 호환성을 확인하세요.")
            (extracted / ".caveman-runtime.json").write_text(json.dumps({"managedBy": OWNER,
                "version": NODE_VERSION, "archiveSha256": expected}, indent=2) + "\n", encoding="utf-8")
            (extracted / ".caveman-runtime.json").chmod(0o600)
            backup = None
            if runtime.exists():
                backups = base / "node-runtime-backups"
                require_private_directory(backups)
                backup = backups / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
                runtime.rename(backup)
            try:
                extracted.rename(runtime)
            except BaseException:
                if backup:
                    backup.rename(runtime)
                raise
            if backup:
                print(f"이전 Node.js 런타임 백업: {backup}")
    return runtime / "bin/node"


def dependency_fingerprint(repo: Path) -> str:
    # Include both inputs: package.json changes must not reuse a previous lock state.
    digest = hashlib.sha256()
    for name in ("package.json", "package-lock.json"):
        path = repo / name
        if path.is_symlink() or not path.is_file():
            raise BootstrapError(f"저장소의 {name} 파일을 확인하세요.")
        digest.update(name.encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def modules_ready(repo: Path, node: Path) -> bool:
    probe = r"""
const fs = require('node:fs'), path = require('node:path');
const repo = process.argv[1], lock = JSON.parse(fs.readFileSync(path.join(repo,'package-lock.json')));
for (const name of Object.keys(JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).dependencies || {})) {
  const base = path.join(repo,'node_modules',name), pkg = JSON.parse(fs.readFileSync(path.join(base,'package.json')));
  if (pkg.version !== lock.packages['node_modules/'+name]?.version) process.exit(1);
  for (const bin of Object.values(typeof pkg.bin === 'string' ? {bin:pkg.bin} : pkg.bin || {})) {
    if (!fs.statSync(path.join(base,bin)).isFile()) process.exit(1);
  }
}
const {createRequire} = require('node:module'), req=createRequire(path.join(repo,'package.json'));
req('@iarna/toml');
import(require('node:url').pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
  .catch(() => {process.exitCode=1;});
"""
    try:
        run_capture([str(node), "-e", probe, str(repo)], env=native_env(node))
        # The Codex JS entry alone is insufficient: npm must also install its
        # Linux architecture package (a common WSL/Windows node_modules mix-up).
        run_capture([str(node), str(repo / "node_modules/@openai/codex/bin/codex.js"), "--version"], env=native_env(node))
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def dependency_state(base: Path, repo: Path) -> Path:
    key = hashlib.sha256(str(repo.resolve()).encode()).hexdigest()[:24]
    return base / "bootstrap" / key / "dependencies.json"


def dependencies_ready(base: Path, repo: Path, node: Path) -> bool:
    state = dependency_state(base, repo)
    try:
        record = json.loads(state.read_text(encoding="utf-8"))
        return (record.get("managedBy") == OWNER and record.get("fingerprint") == dependency_fingerprint(repo)
                and record.get("platform") == "linux" and record.get("architecture") == platform.machine()
                and modules_ready(repo, node))
    except (OSError, ValueError):
        return False


def install_dependencies(base: Path, repo: Path, node: Path, npm: Path) -> None:
    if (repo / "node_modules").is_symlink():
        raise BootstrapError("node_modules가 심볼릭 링크입니다. 외부 의존성 폴더를 자동으로 변경하지 않습니다.")
    require_private_directory(base)
    state = dependency_state(base, repo)
    require_private_directory(base / "bootstrap")
    require_private_directory(state.parent)
    with private_lock(state.parent / "install.lock"):
        fingerprint = dependency_fingerprint(repo)
        print("저장소에 고정된 의존성을 설치합니다. 기존 node_modules는 npm ci로 다시 구성됩니다.", flush=True)
        result = subprocess.run([str(node), str(npm), "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                                cwd=repo, env=native_env(node), check=False)
        if result.returncode != 0:
            raise BootstrapError(f"npm ci가 종료 코드 {result.returncode}로 실패했습니다. 위의 연결·권한·lockfile 오류를 확인한 뒤 ./manage를 다시 실행하세요.")
        if fingerprint != dependency_fingerprint(repo):
            raise BootstrapError("설치 중 package.json 또는 package-lock.json이 변경됐습니다. ./manage를 다시 실행하세요.")
        if not modules_ready(repo, node):
            raise BootstrapError("필수 Node.js 모듈 또는 CLI 파일이 누락되었습니다. npm 설정과 설치 결과를 확인하세요.")
        record = {"managedBy": OWNER, "fingerprint": fingerprint, "platform": "linux", "architecture": platform.machine()}
        temporary = state.parent / (".dependencies-" + uuid.uuid4().hex + ".json")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(record, stream)
                stream.write("\n")
            temporary.chmod(0o600)
            temporary.replace(state)
        finally:
            temporary.unlink(missing_ok=True)


def confirm(message: str) -> bool:
    if not sys.stdin.isatty():
        raise BootstrapError("처음 설치에는 대화형 터미널이 필요합니다. Linux/WSL 터미널에서 ./manage를 실행하세요.")
    return input(message + " [y/N]: ").strip().lower() in {"y", "yes"}


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if sys.version_info < (3, 11):
        raise BootstrapError("Python 3.11 이상이 필요합니다.")
    if sys.platform != "linux":
        raise BootstrapError("./manage는 Linux 또는 WSL 터미널에서 실행하세요. Windows Node.js는 사용하지 않습니다.")
    options = parse_options(args)
    readonly = bool(options.get("help") or options.get("status"))
    if not args and not sys.stdin.isatty():
        raise BootstrapError("올인원 메뉴는 대화형 터미널에서 ./manage로 실행하세요. 상태 조회는 ./manage --status를 사용하세요.")
    repo = Path(__file__).resolve().parent.parent
    base = Path.home() / ".local/share/caveman-client"
    node = find_node(base / "node-runtime")
    if not node:
        if readonly:
            print("Linux용 Node.js 22.13 이상이 없습니다. 터미널에서 ./manage를 실행하면 공식 Node.js 설치를 안내합니다.")
            return 0 if options.get("help") else 1
        if not confirm(f"공식 Node.js {NODE_VERSION}를 {base / 'node-runtime'}에 설치할까요? 시스템 Node.js는 변경하지 않습니다."):
            raise BootstrapError("Node.js 설치를 취소했습니다.")
        node = install_runtime(base)
    if not dependencies_ready(base, repo, node):
        if readonly:
            # Existing manually installed modules can service read-only calls without writing a cache.
            if not modules_ready(repo, node):
                print("필수 의존성이 준비되지 않았습니다. Linux/WSL 터미널에서 ./manage를 한 번 실행하세요.")
                return 0 if options.get("help") else 1
        else:
            npm = find_npm(node)
            if not npm:
                if not confirm(f"선택한 Node.js에 npm이 없습니다. npm이 포함된 공식 Node.js {NODE_VERSION}를 사용자 폴더에 설치할까요?"):
                    raise BootstrapError("npm이 필요합니다. Node.js와 npm 설치를 확인하세요.")
                node = install_runtime(base)
                npm = find_npm(node)
                if not npm:
                    raise BootstrapError("설치된 Node.js에서 npm을 찾을 수 없습니다.")
            if not confirm("프로젝트의 고정된 npm 의존성을 준비할까요? 설치 스크립트는 실행하지 않습니다."):
                raise BootstrapError("의존성 준비를 취소했습니다.")
            install_dependencies(base, repo, node, npm)
    entry = repo / "scripts/manage.mjs"
    if not entry.is_file():
        raise BootstrapError("scripts/manage.mjs가 없습니다. 올인원 기능이 포함된 Git 버전을 확인하세요.")
    os.execve(str(node), [str(node), str(entry), *args], native_env(node))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BootstrapError, OSError, tarfile.TarError) as error:
        print(f"설치 준비 실패: {error}", file=sys.stderr)
        raise SystemExit(1)
    except (KeyboardInterrupt, EOFError):
        print("\n설치 준비를 취소했습니다.", file=sys.stderr)
        raise SystemExit(130)
