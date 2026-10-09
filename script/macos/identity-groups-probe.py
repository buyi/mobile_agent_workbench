#!/usr/bin/env python3
"""Finite diagnostic: compare macOS directory groups with kernel process groups.
No network, model, file mutation, account change, or broadcast signals.
"""
import ctypes
import json
import os
import pwd
import signal
import subprocess
import sys
import sysconfig


def groups(symbol):
    library = ctypes.CDLL(None, use_errno=True)
    function = getattr(library, symbol)
    function.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
    function.restype = ctypes.c_int
    count = function(0, None)
    if not 0 <= count <= 1024:
        raise RuntimeError("invalid group count")
    values = (ctypes.c_uint32 * max(count, 1))()
    actual = function(count, values)
    if not 0 <= actual <= count:
        raise RuntimeError("group read failed")
    return list(values)[:actual]


def main():
    if sys.platform != "darwin" or os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Explicit macOS root diagnostic required")
    worker = pwd.getpwnam("loopit-worker")
    if (worker.pw_uid, worker.pw_gid, worker.pw_shell) != (420, 420, "/usr/bin/false"):
        raise RuntimeError("Fixed Worker identity does not match")
    child = os.fork()
    if child == 0:
        try:
            signal.alarm(5)
            os.setgroups([420]); os.setgid(420); os.setuid(420)
            native = subprocess.run(["/usr/bin/id", "-G"], env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, timeout=2)
            report = {"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "egid": os.getegid(),
                      "deploymentTarget": sysconfig.get_config_var("MACOSX_DEPLOYMENT_TARGET"),
                      "pythonGroups": os.getgroups(), "libcGetgroups": groups("getgroups"),
                      "darwinExtendedGroups": groups("getgroups$DARWIN_EXTSN"),
                      "idGroups": {"code": native.returncode, "stdout": native.stdout.strip(), "stderr": native.stderr[-512:]}}
            os.write(1, (json.dumps(report) + "\n").encode())
            os._exit(0)
        except BaseException as error:
            os.write(2, (type(error).__name__ + ": " + str(error) + "\n").encode()); os._exit(2)
    _, status = os.waitpid(child, 0)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise RuntimeError("Diagnostic child failed")


if __name__ == "__main__":
    main()
