#!/usr/bin/env python3
"""Install one reviewed no-model control-matrix payload, without running it.

The supplied digest is the operator's reviewed manifest pin. Default is a
read-only staging audit. Installation requires root, an idle Supervisor, and a
new fixed-prefix destination. Existing files, accounts and Runs are untouched.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def sha(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def read(path, limit=256 * 1024 * 1024):
    require(str(path.resolve()) == str(path), "noncanonical_input")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit, "invalid_source_file")
        chunks, remaining = [], before.st_size + 1
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        result, after = b"".join(chunks), os.fstat(fd)
        require(len(result) == before.st_size == after.st_size and before.st_ino == after.st_ino and before.st_mtime_ns == after.st_mtime_ns, "source_changed")
        return result
    finally:
        os.close(fd)


def relative(value, directory=False):
    require(isinstance(value, str) and (value or directory), "invalid_relative_path")
    if not value:
        return value
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value and ".." not in path.parts and "\\" not in value and "\x00" not in value, "unsafe_relative_path")
    require(path.parts[0] in ("bin", "public", "control", "workspace", "runtime"), "unexpected_install_area")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--manifest-digest", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    stage = Path(args.stage)
    require(stage.is_absolute(), "absolute_stage_required")
    raw = read(stage / "manifest.json", 1024 * 1024)
    require(sha(raw) == args.manifest_digest, "manifest_pin_mismatch")
    manifest = json.loads(raw)
    require(manifest["schemaVersion"] == "m0-control-matrix-install/1" and re.fullmatch(r"m0-control-matrix-[a-z0-9-]{1,70}", manifest["id"]), "invalid_matrix_manifest")
    root = Path("/private/var/loopit/m0-runs") / manifest["id"]
    require(manifest["finalRoot"] == str(root) and not root.exists() and not root.is_symlink(), "existing_or_wrong_destination")
    directories, contents, seen = [], [], set()
    for entry in manifest["directories"]:
        path = relative(entry["path"], True)
        require(path not in seen, "duplicate_directory")
        seen.add(path)
        worker = path == "workspace" or path.startswith("workspace/") or path == "runtime" or path.startswith("runtime/")
        require((entry["uid"], entry["gid"]) == ((420, 420) if worker else (0, 0)), "unexpected_directory_identity")
        require(entry["mode"] == (0o700 if worker or path.startswith("control") else 0o755), "unexpected_directory_mode")
        directories.append(entry)
    require("" in seen and "control" in seen and "workspace" in seen and "runtime" in seen, "missing_directory")
    for entry in manifest["files"]:
        path = relative(entry["path"])
        require(path not in seen and str(PurePosixPath(path).parent) in seen, "duplicate_file_or_missing_parent")
        seen.add(path)
        worker = path.startswith("workspace/")
        require((entry["uid"], entry["gid"]) == ((420, 420) if worker else (0, 0)), "unexpected_file_identity")
        require(entry["mode"] == 0o600 if worker else entry["mode"] in (0o444, 0o555), "unexpected_file_mode")
        data = read(stage / path)
        require(sha(data) == entry["digest"], "asset_pin_mismatch")
        contents.append((entry, data))
    require(manifest["spec"]["controlDirectory"] == str(root / "control") and manifest["spec"]["workspace"] == str(root / "workspace"), "spec_destination_mismatch")
    if not args.apply:
        print(json.dumps({"status": "audited-not-installed", "manifestDigest": sha(raw), "root": str(root), "files": len(contents), "modelCalls": 0}))
        return
    require(os.getuid() == 0 and os.geteuid() == 0, "root_required")
    for parent in [root.parent, *root.parent.parents]:
        item = parent.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022, "unprotected_destination_parent")
    lock_path = Path("/private/var/loopit/supervisor/ownership.lock")
    lock = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        active = json.loads(read(lock_path.parent / "active.json"))
        require(active["phase"] == "stopped", "supervisor_not_stopped")
        for pin in manifest["spec"]["protectedRunFiles"]:
            require(pin["path"].startswith("/private/var/loopit/m0-runs/m0-code-loop-20261009a/control/"), "prior_run_path_not_fixed")
            require(sha(read(Path(pin["path"]))) == pin["digest"], "prior_run_changed")
        for entry in sorted(directories, key=lambda e: len(PurePosixPath(e["path"]).parts)):
            path = root / entry["path"]
            path.mkdir(mode=entry["mode"])
            os.chown(path, entry["uid"], entry["gid"])
            os.chmod(path, entry["mode"])
        for entry, data in contents:
            fd = os.open(root / entry["path"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, entry["mode"])
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                os.fchown(stream.fileno(), entry["uid"], entry["gid"])
                os.fchmod(stream.fileno(), entry["mode"])
                stream.flush()
                os.fsync(stream.fileno())
        with (root / "control/install-manifest.json").open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(root / "control/install-manifest.json", 0o400)
        print(json.dumps({"status": "installed-not-executed", "root": str(root), "manifestDigest": sha(raw), "files": len(contents), "modelCalls": 0}))
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "blocked", "error": str(error), "retryAllowed": False}))
        raise SystemExit(2)
