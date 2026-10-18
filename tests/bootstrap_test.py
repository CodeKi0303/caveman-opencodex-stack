"""Bootstrap tests do not download runtimes or install npm packages."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("bootstrap", Path(__file__).resolve().parents[1] / "scripts/bootstrap.py")
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="caveman-bootstrap-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, entries):
        target = self.root / "node.tar.xz"
        with tarfile.open(target, "w:xz") as tar:
            for name, kind, value in entries:
                member = tarfile.TarInfo(name)
                if kind == "file":
                    value = value.encode()
                    member.size = len(value)
                    member.mode = 0o7777
                    tar.addfile(member, io.BytesIO(value))
                elif kind == "symlink":
                    member.type = tarfile.SYMTYPE
                    member.linkname = value
                    tar.addfile(member)
                elif kind == "hardlink":
                    member.type = tarfile.LNKTYPE
                    member.linkname = value
                    tar.addfile(member)
                elif kind == "device":
                    member.type = tarfile.CHRTYPE
                    tar.addfile(member)
        return target

    def fake_elf(self, name="node"):
        node = self.root / name
        node.write_bytes(b"\x7fELFfake")
        return node.resolve()

    def test_rejects_windows_before_execution_and_validates_linux_runtime(self):
        windows = self.root / "node.exe"
        windows.write_bytes(b"MZ Windows binary")
        with patch.object(b, "run_capture") as run:
            self.assertIsNone(b.probe_node(windows))
            run.assert_not_called()
        node = self.fake_elf()
        valid = {"platform": "linux", "version": "24.14.1", "execPath": str(node)}
        with patch.object(b, "run_capture", return_value=json.dumps(valid)):
            self.assertEqual(b.probe_node(node), node)
        for changed in [{"platform": "win32"}, {"version": "22.12.9"}, {"execPath": str(windows)}]:
            with patch.object(b, "run_capture", return_value=json.dumps(valid | changed)):
                self.assertIsNone(b.probe_node(node))

    def test_finds_native_candidate_after_old_or_windows_path(self):
        runtime = self.root / "runtime"
        chosen = runtime / "bin/node"
        with patch.object(b, "probe_node", side_effect=lambda candidate: chosen if candidate == chosen else None):
            self.assertEqual(b.find_node(runtime, {"PATH": os.pathsep.join(["/mnt/c/node", "/usr/bin"])}), chosen)

    def test_download_only_official_https_and_checksum_exact(self):
        b.download_url("https://nodejs.org/dist/v24.14.1/SHASUMS256.txt")
        for bad in ["http://nodejs.org/x", "https://example.org/x", "https://nodejs.org.evil/x",
                    "https://name:secret@nodejs.org/x", "https://nodejs.org:8443/x"]:
            with self.subTest(bad=bad), self.assertRaises(b.BootstrapError):
                b.download_url(bad)
        digest = "a" * 64
        self.assertEqual(b.expected_checksum(f"{digest}  node.tar.xz\n", "node.tar.xz"), digest)
        for text in ["", "nope node.tar.xz", f"{digest} node.tar.xz\n{digest} node.tar.xz\n"]:
            with self.assertRaises(b.BootstrapError):
                b.expected_checksum(text, "node.tar.xz")

    def test_tar_rejects_traversal_duplicates_links_and_special_files(self):
        cases = [
            [("../outside", "file", "bad")],
            [("/node/bin/node", "file", "bad")],
            [("wrong/bin/node", "file", "bad")],
            [("node/bin/node", "file", "a"), ("node/bin/node", "file", "b")],
            [("node/bin/npm", "symlink", "../../../../outside")],
            [("node/bin/npm", "symlink", "/outside")],
            [("node/bin/npm", "hardlink", "node/lib/npm")],
            [("node/dev", "device", "")],
            [("node/bin", "symlink", "lib"), ("node/bin/file", "file", "bad")],
        ]
        for index, entries in enumerate(cases):
            with self.subTest(entries=entries), self.assertRaises(b.BootstrapError):
                b.safe_extract(self.archive(entries), self.root / f"extract-{index}", "node")
        self.assertFalse((self.root.parent / "outside").exists())

    def test_tar_extracts_files_without_elevated_mode(self):
        archive = self.archive([("node/bin/node", "file", "binary"), ("node/lib/npm.js", "file", "npm")])
        extracted = b.safe_extract(archive, self.root / "extract", "node")
        self.assertEqual((extracted / "bin/node").read_text(), "binary")
        if os.name != "nt":
            self.assertEqual((extracted / "bin/node").stat().st_mode & 0o7777, 0o755)

    @unittest.skipIf(os.name == "nt", "Native Linux symlink extraction")
    def test_tar_allows_contained_npm_symlink(self):
        archive = self.archive([("node/lib/npm.js", "file", "npm"), ("node/bin/npm", "symlink", "../lib/npm.js")])
        extracted = b.safe_extract(archive, self.root / "extract", "node")
        self.assertEqual((extracted / "bin/npm").read_text(), "npm")

    def test_install_lock_is_exclusive_and_removed_on_failure(self):
        lock = self.root / "install.lock"
        with self.assertRaisesRegex(ValueError, "test failure"):
            with b.private_lock(lock):
                with self.assertRaises(b.BootstrapError):
                    with b.private_lock(lock):
                        pass
                raise ValueError("test failure")
        self.assertFalse(lock.exists())

    def test_unowned_runtime_is_not_replaced_or_downloaded(self):
        base = self.root / "base"
        runtime = base / "node-runtime"
        runtime.mkdir(parents=True)
        sentinel = runtime / "keep.txt"
        sentinel.write_text("mine")
        with patch.object(b, "require_private_directory"), patch.object(b, "download") as download, self.assertRaises(b.BootstrapError):
            b.install_runtime(base, "x86_64")
        download.assert_not_called()
        self.assertEqual(sentinel.read_text(), "mine")
        self.assertFalse((base / ".node-install.lock").exists())

    def test_checksum_failure_preserves_owned_runtime(self):
        base = self.root / "base"
        runtime = base / "node-runtime"
        runtime.mkdir(parents=True)
        (runtime / ".caveman-runtime.json").write_text(json.dumps({"managedBy": b.OWNER}))
        (runtime / "keep.txt").write_text("previous")
        def download(url, target, limit):
            if url.endswith("SHASUMS256.txt"):
                target.write_text("0" * 64 + f"  node-v{b.NODE_VERSION}-linux-x64.tar.xz\n")
            else:
                target.write_bytes(b"incorrect download")
        with patch.object(b, "require_private_directory"), patch.object(b, "runtime_owned", return_value=True), \
             patch.object(b, "download", side_effect=download), self.assertRaisesRegex(b.BootstrapError, "SHA-256"):
            b.install_runtime(base, "x86_64")
        self.assertEqual((runtime / "keep.txt").read_text(), "previous")

    def test_tar_size_limits_are_enforced(self):
        archive = self.archive([("node/bin/node", "file", "binary")])
        with patch.object(b, "MAX_UNPACKED", 1), self.assertRaises(b.BootstrapError):
            b.safe_extract(archive, self.root / "extract", "node")

    @unittest.skipIf(os.name == "nt", "Native Linux ownership modes")
    def test_owned_runtime_is_backed_up_then_replaced(self):
        base = self.root / "base"
        runtime = base / "node-runtime"
        runtime.mkdir(parents=True)
        (runtime / ".caveman-runtime.json").write_text(json.dumps({"managedBy": b.OWNER}))
        (runtime / "previous.txt").write_text("previous")
        top = f"node-v{b.NODE_VERSION}-linux-x64"
        archive = self.archive([(f"{top}/bin/node", "file", "new-runtime")])
        digest = b.sha256_file(archive)
        def download(url, target, limit):
            if url.endswith("SHASUMS256.txt"):
                target.write_text(f"{digest}  {top}.tar.xz\n")
            else:
                target.write_bytes(archive.read_bytes())
        with patch.object(b, "download", side_effect=download), \
             patch.object(b, "probe_node", side_effect=lambda p: p), patch.object(b, "find_npm", return_value=Path("/npm")), \
             patch("sys.stdout", new_callable=io.StringIO):
            node = b.install_runtime(base, "x86_64")
        self.assertEqual(node.read_text(), "new-runtime")
        backups = list((base / "node-runtime-backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "previous.txt").read_text(), "previous")
        self.assertTrue(b.runtime_owned(runtime))

    @unittest.skipIf(os.name == "nt", "Native Linux ownership modes")
    def test_failed_runtime_swap_restores_previous_installation(self):
        base = self.root / "base"
        runtime = base / "node-runtime"
        runtime.mkdir(parents=True)
        (runtime / ".caveman-runtime.json").write_text(json.dumps({"managedBy": b.OWNER}))
        (runtime / "previous.txt").write_text("previous")
        top = f"node-v{b.NODE_VERSION}-linux-x64"
        archive = self.archive([(f"{top}/bin/node", "file", "new-runtime")])
        digest = b.sha256_file(archive)
        original_rename = Path.rename
        def rename(source, destination):
            if source.name == top:
                raise OSError("simulated atomic move failure")
            return original_rename(source, destination)
        def download(url, target, limit):
            if url.endswith("SHASUMS256.txt"):
                target.write_text(f"{digest}  {top}.tar.xz\n")
            else:
                target.write_bytes(archive.read_bytes())
        with patch.object(b, "download", side_effect=download), patch.object(Path, "rename", rename), \
             patch.object(b, "probe_node", side_effect=lambda p: p), patch.object(b, "find_npm", return_value=Path("/npm")), \
             self.assertRaisesRegex(OSError, "atomic move failure"):
            b.install_runtime(base, "x86_64")
        self.assertEqual((runtime / "previous.txt").read_text(), "previous")
        self.assertTrue(b.runtime_owned(runtime))
        self.assertFalse((base / ".node-install.lock").exists())

    def test_fingerprint_and_module_check_both_required(self):
        repo = self.root / "repo"
        repo.mkdir()
        (repo / "package.json").write_text('{"dependencies":{}}')
        (repo / "package-lock.json").write_text('{"lockfileVersion":3}')
        state = b.dependency_state(self.root, repo)
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"managedBy": b.OWNER, "fingerprint": b.dependency_fingerprint(repo),
                                    "platform": "linux", "architecture": b.platform.machine()}))
        with patch.object(b, "modules_ready", return_value=True):
            self.assertTrue(b.dependencies_ready(self.root, repo, Path("/node")))
        with patch.object(b, "modules_ready", return_value=False):
            self.assertFalse(b.dependencies_ready(self.root, repo, Path("/node")))
        (repo / "package.json").write_text('{"changed":true}')
        with patch.object(b, "modules_ready", return_value=True):
            self.assertFalse(b.dependencies_ready(self.root, repo, Path("/node")))

    def test_readonly_without_runtime_never_installs(self):
        with patch.object(b.sys, "platform", "linux"), patch.object(b, "find_node", return_value=None), \
             patch.object(b, "install_runtime") as install, patch.object(b, "install_dependencies") as npm, \
             patch.object(b, "confirm") as confirm, patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(b.main(["--status"]), 1)
            self.assertEqual(b.main(["--help"]), 0)
            self.assertEqual(b.main(["--status", "--codex-home", "/custom", "--user"]), 1)
            self.assertEqual(b.main(["--codex-home", "/custom", "--help", "--user"]), 0)
            install.assert_not_called()
            npm.assert_not_called()
            confirm.assert_not_called()

    def test_unknown_or_conflicting_arguments_cannot_trigger_install(self):
        with patch.object(b.sys, "platform", "linux"), patch.object(b, "find_node") as find:
            for args in [["status"], ["--wrong"], ["--status", "--setup"], ["--repair", "--status"],
                         ["--repair", "--setup"], ["--user", "--system"], ["--codex-home"],
                         ["--status", "--status"], ["--codex-home", "--status"]]:
                with self.subTest(args=args), self.assertRaises(b.BootstrapError):
                    b.main(args)
            find.assert_not_called()
        self.assertEqual(b.parse_options(["--repair", "--user", "--codex-home", "/custom"]),
                         {"repair": True, "scope": "user", "codexHome": "/custom"})

    def test_readonly_prepared_modules_executes_without_state_writes(self):
        node = Path("/native/bin/node")
        with patch.object(b.sys, "platform", "linux"), patch.object(b, "find_node", return_value=node), \
             patch.object(b, "dependencies_ready", return_value=False), patch.object(b, "modules_ready", return_value=True), \
             patch.object(b.Path, "is_file", return_value=True), patch.object(b.os, "execve") as execute, \
             patch.object(b, "install_dependencies") as npm:
            b.main(["--status"])
            npm.assert_not_called()
            actual_node, args, env = execute.call_args.args
            self.assertEqual(actual_node, str(node))
            self.assertEqual(args[-1], "--status")
            self.assertEqual(env["CAVEMAN_NODE_PATH"], str(node))
            self.assertTrue(env["PATH"].startswith(str(node.parent) + os.pathsep))

    def test_default_noninteractive_never_prepares(self):
        with patch.object(b.sys, "platform", "linux"), patch.object(b.sys.stdin, "isatty", return_value=False), \
             patch.object(b, "find_node") as find, self.assertRaises(b.BootstrapError):
            b.main([])
        find.assert_not_called()


if __name__ == "__main__":
    unittest.main()
