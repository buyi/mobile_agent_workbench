#!/usr/bin/env python3
"""Install a new read-only acceptance bundle. Never replace an existing run."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def read_regular(path, limit=128 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= limit:
            raise RuntimeError("Invalid source file")
        with os.fdopen(os.dup(fd), "rb") as handle:
            raw = handle.read(limit + 1)
        after = os.fstat(fd)
        if len(raw) != before.st_size or (before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("Source file changed")
        return raw
    finally:
        os.close(fd)


def protected(path):
    path = Path(path)
    if str(path.resolve(strict=True)) != str(path):
        raise RuntimeError("Noncanonical protected path")
    for item in (path, *path.parents):
        meta = item.lstat()
        if meta.st_uid != 0 or meta.st_mode & 0o022 or stat.S_ISLNK(meta.st_mode):
            raise RuntimeError("Unprotected destination or input")


def write_once(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    try:
        with os.fdopen(os.dup(fd), "wb") as handle:
            handle.write(raw)
            handle.flush()
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--plan-digest", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    stage = Path(args.stage).resolve(strict=True)
    plan_bytes = read_regular(stage / "plan.json")
    if digest(plan_bytes) != args.plan_digest:
        raise RuntimeError("Plan digest changed")
    plan = json.loads(plan_bytes)
    if plan.get("schemaVersion") != "m0-readonly-acceptance/1" or not re.fullmatch(r"/private/var/loopit/readonly-acceptance-[a-z0-9-]+", plan.get("installRoot", "")):
        raise RuntimeError("Invalid read-only installation scope")
    code = read_regular(stage / "controller.mjs")
    if digest(code) != plan["controllerDigest"] or digest(read_regular(Path(__file__).resolve())) != plan["installerDigest"]:
        raise RuntimeError("Reviewed bundle/installer changed")
    target = Path(plan["installRoot"])
    if target.exists() or target.is_symlink():
        raise RuntimeError("Destination already exists; no replacement permitted")
    if not args.apply:
        print(json.dumps({"status": "verified-not-installed", "planDigest": args.plan_digest, "installRoot": str(target)}))
        return
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Root installation required")
    protected(target.parent)
    for pin in [*plan["inputs"].values(), plan["bun"], {"path": "/private/var/loopit/m0-runs/m0-code-loop-20261009a/bin/controller.mjs", "digest": plan["untouchedUpdate9ControllerDigest"]}]:
        protected(pin["path"])
        if digest(read_regular(pin["path"])) != pin["digest"]:
            raise RuntimeError("Protected input differs from reviewed pin")
    target.mkdir(mode=0o755)
    write_once(target / "controller.mjs", code)
    write_once(target / "plan.json", plan_bytes)
    fd = os.open(target, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps({"status": "installed-not-executed", "installRoot": str(target), "planDigest": args.plan_digest,
                      "controllerDigest": plan["controllerDigest"], "existingDeploymentModified": False, "modelCalls": 0, "signingCalls": 0}))


if __name__ == "__main__":
    main()
