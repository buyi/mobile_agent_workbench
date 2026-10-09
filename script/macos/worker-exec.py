#!/usr/bin/env python3
"""Root-installed finite-scope launcher; never a setuid/sudo entry point.

A shared launch gate covers admission validation through the complete UID drop.
The Supervisor takes the exclusive gate and revokes admission before UID scans.
"""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import time

STATE = Path("/private/var/loopit/supervisor")
SIGNER_JOB = Path("/private/var/loopit/m0-runs/m0-code-loop-20261009a")


def kernel_groups():
    # On modern macOS Python os.getgroups() selects getgroups$DARWIN_EXTSN,
    # which reads directory membership and ignores setgroups(). Explicit dlsym
    # of the traditional symbol reads this process's kernel credential groups.
    function = ctypes.CDLL(None, use_errno=True).getgroups
    function.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
    function.restype = ctypes.c_int
    count = function(0, None)
    if not 0 <= count <= 1024:
        raise RuntimeError("Kernel group count unavailable or out of bounds")
    values = (ctypes.c_uint32 * max(count, 1))()
    actual = function(count, values)
    if not 0 <= actual <= count:
        raise RuntimeError("Kernel group read failed")
    return list(values)[:actual]


def registered_identity(uid, gid):
    for name in ("loopit-worker", "loopit-signer"):
        account = pwd.getpwnam(name)
        if (uid, gid) == (account.pw_uid, account.pw_gid):
            if not (400 <= uid < 500 and 400 <= gid < 500 and account.pw_shell == "/usr/bin/false"):
                break
            return name
    raise RuntimeError("Only the installed, non-root dedicated Loopit identities are allowed")


def drop_identity(uid, gid):
    registered_identity(uid, gid)
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Launcher requires a trusted root parent; it does not acquire privilege")
    os.setgroups([gid])
    os.setgid(gid)
    os.setuid(uid)
    if (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (uid, uid, gid, gid):
        raise RuntimeError("Identity drop was incomplete")
    if set(kernel_groups()) != {gid}:
        raise RuntimeError("Unexpected supplementary groups")


def close_inherited_descriptors():
    # The soft RLIMIT is not an upper bound on already-open descriptors. Inventory
    # actual descriptors so a high inherited ownership lock cannot survive.
    descriptors = [int(name) for name in os.listdir("/dev/fd") if name.isdigit()]
    for fd in descriptors:
        if fd > 2:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise


def open_launch_gate():
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Launch admission requires a root parent")
    if STATE.resolve() != STATE:
        raise RuntimeError("Supervisor state must be canonical")
    for path in [STATE, *STATE.parents]:
        info = path.lstat()
        if info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise RuntimeError("Supervisor state ancestor is unprotected")
    if stat.S_IMODE(STATE.stat().st_mode) != 0o700:
        raise RuntimeError("Supervisor state must be private")
    fd = os.open(STATE / "launch.lock", os.O_RDWR | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        os.close(fd)
        raise RuntimeError("Launch gate is unprotected")
    return fd


def acquire_shared_gate(fd, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Launch admission is closed or busy")
            time.sleep(0.02)


def validate_admission(active, scope_id, generation, uid, gid):
    name = registered_identity(uid, gid)
    if not scope_id or not isinstance(generation, int) or generation < 1 or active.get("scopeId") != scope_id or active.get("generation") != generation:
        raise RuntimeError("Stale or missing launch scope/generation")
    prefix, phase = ("worker", "running") if name == "loopit-worker" else ("signer", "finalizing")
    if active.get("phase") != phase or (active.get(prefix + "Uid"), active.get(prefix + "Gid")) != (uid, gid):
        raise RuntimeError("Launch phase or registered identity does not match")
    deadline = active.get("admissionDeadline")
    if not isinstance(deadline, (int, float)) or not time.time() < deadline <= time.time() + 3600:
        raise RuntimeError("Launch deadline is expired or invalid")
    return deadline


def admitted_drop(uid, gid, scope_id, generation):
    fd = open_launch_gate()
    try:
        acquire_shared_gate(fd)
        # The fixed root-private file is read only while holding the shared gate.
        active = json.loads((STATE / "active.json").read_text())
        deadline = validate_admission(active, scope_id, generation, uid, gid)
        drop_identity(uid, gid)
        # A delayed root launcher remains in the gate until it is visible to the
        # dedicated-UID inventory. Only then may the Supervisor acquire exclusive.
        if time.time() >= deadline:
            raise RuntimeError("Launch expired during identity drop")
    finally:
        os.close(fd)


def root_file_bytes(path, limit):
    """Read fixed installed code/spec only; no user-selected path or symlink."""
    if not path.is_absolute() or path.resolve() != path:
        raise RuntimeError("Signer input must be canonical")
    for part in (path, *path.parents):
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Signer code/spec must be root protected")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise RuntimeError("Invalid signer code/spec file")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk); size += len(chunk)
            if size > limit:
                raise RuntimeError("Signer code/spec exceeds bound")
        after = os.fstat(fd)
        if size != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise RuntimeError("Signer code/spec changed while reading")
        return b"".join(chunks)
    finally:
        os.close(fd)


def signer_verifier_command(uid, gid, command):
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Signer launcher requires a trusted root parent")
    if (uid, gid) != (421, 420) or command or registered_identity(uid, gid) != "loopit-signer":
        raise RuntimeError("Only the fixed Signer verifier may bypass the outer sandbox")
    spec_path = SIGNER_JOB / "control/spec.json"
    spec = json.loads(root_file_bytes(spec_path, 1024 * 1024))
    if spec.get("schemaVersion") != "m0-control-loop/1" or spec.get("jobId") != SIGNER_JOB.name or spec.get("controlDirectory") != str(SIGNER_JOB / "control"):
        raise RuntimeError("Unexpected fixed Signer job spec")
    result = []
    for field, relative, limit in [("bun", "bin/bun", 512 * 1024 * 1024), ("verifierCli", "bin/verifier.mjs", 64 * 1024 * 1024)]:
        path = SIGNER_JOB / relative
        pinned = spec.get(field, {})
        if set(pinned) != {"path", "digest"} or pinned.get("path") != str(path):
            raise RuntimeError("Signer executable path is not fixed")
        data = root_file_bytes(path, limit)
        if pinned.get("digest") != "sha256:" + hashlib.sha256(data).hexdigest():
            raise RuntimeError("Signer executable pin changed")
        result.append(str(path))
    # This trusted parent must apply its own strict Seatbelt to each candidate
    # child. macOS rejects sandbox_apply from an already sandboxed process.
    return result


def signer_environment():
    # Do not inherit BUN_OPTIONS, NODE_OPTIONS, DYLD_* or caller credentials into
    # the trusted parent. Candidate children receive a separate clean sandbox env.
    return {"PATH": "/usr/bin:/bin", "HOME": "/private/var/loopit/signer", "LANG": "en_US.UTF-8",
            "TMPDIR": "/private/var/loopit/signer/m0-verifier/work", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uid", required=True, type=int)
    parser.add_argument("--gid", required=True, type=int)
    parser.add_argument("--signer-verifier", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not args.signer_verifier and (not command or command[0] != "/usr/bin/sandbox-exec"):
        parser.error("Only a sandbox-exec command may be launched")
    scope_id = os.environ.get("LOOPIT_SCOPE_ID")
    try:
        generation = int(os.environ.get("LOOPIT_GENERATION", ""))
    except ValueError:
        raise RuntimeError("Explicit launch generation is required")
    close_inherited_descriptors()
    if args.signer_verifier:
        command = signer_verifier_command(args.uid, args.gid, command)
    admitted_drop(args.uid, args.gid, scope_id, generation)
    env = signer_environment() if args.signer_verifier else {key: value for key, value in os.environ.items() if key not in ("LOOPIT_SCOPE_ID", "LOOPIT_GENERATION", "LOOPIT_SUPERVISOR_LOCK_FD")}
    os.execve(command[0], command, env)


if __name__ == "__main__":
    main()
