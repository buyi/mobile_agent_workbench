#!/usr/bin/env python3
"""Fixed UID422/private-set preflight. Default mode only reads and prints a plan.

Plan:  python3 prepare-device-preflight.py [--plan-out NEW.json]
Apply: sudo python3 prepare-device-preflight.py --apply --plan PLAN --expected-plan sha256:...
Only the root operator runs apply after reviewing the exact plan/script bytes.
No account reuse/repair, credentials, app installation, default device set or
arbitrary command is supported. A partial apply remains maintenance, not retryable.
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
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

NAME = "loopit-device-probe"
UID = GID = 422
OPERATOR = ("buyi", 501)
WORKER = ("loopit-worker", 420, 420)
PARENT = Path("/private/var/loopit")
ROOT = PARENT / "device-probe-20261009a"
CONTROL, BIN, HOME = ROOT / "control", ROOT / "bin", ROOT / "home"
SET, CANARY = HOME / "private-device-set", HOME / "nonsecret-canary"
PUBLIC_CANARY = ROOT / "public-nonsecret-canary"
RUNNER = BIN / "device-preflight.py"
DEVELOPER = "/Applications/Xcode.app/Contents/Developer"
SIMCTL = Path(DEVELOPER) / "usr/bin/simctl"
SIMCTL_DIGEST = "sha256:1e431a7a51f49e995130e32a3a2164da3e01458ca2672253515250e34ab052df"
XCRUN = "/usr/bin/xcrun"
FORBIDDEN_UDID = "62F1C107-7480-41BD-B2E2-6C3323B8ECDA"
RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-0"
DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8", "DEVELOPER_DIR": DEVELOPER}
APPLY_DEADLINE = None
WORK_DEADLINE = None


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def kernel_groups():
    function = ctypes.CDLL(None, use_errno=True).getgroups
    function.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
    function.restype = ctypes.c_int
    count = function(0, None)
    if not 0 <= count <= 1024:
        raise RuntimeError("Invalid kernel group count")
    values = (ctypes.c_uint32 * max(1, count))()
    actual = function(count, values)
    if not 0 <= actual <= count:
        raise RuntimeError("Kernel group read failed")
    return list(values)[:actual]


def drop(uid, gid, groups):
    if os.getuid() != 0 or os.geteuid() != 0 or uid not in (UID, OPERATOR[1], WORKER[1]):
        raise RuntimeError("Only fixed non-root identities may be selected")
    os.setgroups(groups)
    os.setgid(gid)
    os.setuid(uid)
    if (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (uid, uid, gid, gid) or set(kernel_groups()) != set(groups):
        raise RuntimeError("Incomplete identity drop")


def run(argv, timeout=5, identity=None):
    """Finite fixed commands only at callers; never shell, broadcast or killpg.

    A timeout kills only our still-unreaped direct child. Pipes are bounded even
    when descendants retain them. UID422 descendants are reconciled separately.
    """
    for deadline in (APPLY_DEADLINE, WORK_DEADLINE):
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
    if timeout <= 0:
        raise RuntimeError("Preflight deadline exhausted")
    env = dict(ENV)
    before_exec = None
    if identity:
        uid, gid, groups, home = identity
        env.update(HOME=home, CFFIXED_USER_HOME=home, TMPDIR=str(HOME / "tmp") if uid == UID else "/tmp")
        before_exec = lambda: drop(uid, gid, groups)
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env, close_fds=True, start_new_session=True, preexec_fn=before_exec)
    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    for name in buffers:
        pipe = getattr(process, name)
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, name)
    end, timed_out, overflow = time.monotonic() + timeout, False, False
    try:
        while selector.get_map():
            if time.monotonic() >= end:
                timed_out = True
                break
            for key, _ in selector.select(min(.1, max(0, end - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffers[key.data].extend(chunk)
                if sum(map(len, buffers.values())) > 2 * 1024 ** 2:
                    overflow = True
                    break
            if overflow:
                break
        if process.poll() is None:
            remaining = end - time.monotonic()
            if not timed_out and not overflow and remaining > 0:
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    timed_out = True
            if process.poll() is None:
                process.kill()  # Only this direct, still-unreaped child PID.
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    timed_out = True
        return {"exitCode": process.returncode, "timedOut": timed_out, "overflow": overflow,
                **{name: bytes(value[:2 * 1024 ** 2]).decode("utf8", "replace") for name, value in buffers.items()}}
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def successful(result):
    if result["exitCode"] != 0 or result["timedOut"] or result["overflow"]:
        raise RuntimeError("Fixed command failed or outcome unknown")
    return result["stdout"]


def directory_rows(text):
    rows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r"-?[0-9]+", parts[1]):
            raise RuntimeError("Unrecognized directory enumeration; absence unproven")
        rows.append((parts[0], int(parts[1])))
    if not rows:
        raise RuntimeError("Empty directory enumeration; absence unproven")
    return rows


def assert_unused(rows, kind):
    if any(name == NAME or number == UID for name, number in rows):
        raise RuntimeError("Fixed %s name/ID already occupied; no account reuse or repair" % kind)


def root_directory(path, mode=None):
    if path.resolve() != path:
        raise RuntimeError("Noncanonical root path")
    for part in [path, *path.parents]:
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Unprotected root directory")
    info = path.stat()
    if mode is not None and (stat.S_IMODE(info.st_mode) != mode or info.st_gid != 0):
        raise RuntimeError("Unexpected root directory mode/group")
    if len(successful(run(["/bin/ls", "-lde", str(path)])).splitlines()) != 1:
        raise RuntimeError("Root directory has an ACL")


def processes():
    rows = []
    for line in successful(run(["/bin/ps", "-axo", "pid=,uid=,stat="])).splitlines():
        parts = line.split()
        if len(parts) != 3 or not all(part.isdigit() for part in parts[:2]):
            raise RuntimeError("Unrecognized process inventory")
        if int(parts[1]) == UID:
            rows.append({"pid": int(parts[0]), "uid": UID, "state": parts[2]})
    return rows


def domain_present(text=None):
    if text is None:
        result = run(["/bin/launchctl", "print", "system"], timeout=2)
        text = successful(result)
        if result["stderr"]:
            raise RuntimeError("System domain inventory diagnostics")
    marker = "\n\tsubdomains = {\n"
    if not text.startswith("system = {\n") or text.count(marker) != 1:
        raise RuntimeError("Unrecognized system domain inventory")
    tail = text.split(marker, 1)[1].splitlines()
    if "\t}" not in tail:
        raise RuntimeError("Unterminated domain inventory")
    entries = tail[:tail.index("\t}")]
    if len(entries) != len(set(entries)) or any(not re.fullmatch(r"\t\t(?:pid|user|gui|login|session)/[0-9]+", line) for line in entries):
        raise RuntimeError("Unknown domain entry")
    # Never `print user/422`: that command can itself create a domain.
    return "\t\tuser/422" in entries


def tool_check():
    if successful(run([XCRUN, "--find", "simctl"])).strip() != str(SIMCTL) or digest(SIMCTL.read_bytes()) != SIMCTL_DIGEST:
        raise RuntimeError("Bundled simctl path or bytes changed")
    if "simctl [--set <path>]" not in successful(run([XCRUN, "simctl", "help"])):
        raise RuntimeError("Explicit private device set unsupported")
    for path in [SIMCTL, *list(SIMCTL.parents)[:5]]:
        info = path.lstat()
        if path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Bundled tool is not root protected")


def audit_available():
    if sys.platform != "darwin":
        raise RuntimeError("macOS only")
    for kind, attr in [("Users", "UniqueID"), ("Groups", "PrimaryGroupID")]:
        assert_unused(directory_rows(successful(run(["/usr/bin/dscl", ".", "-list", "/" + kind, attr]))), kind)
    root_directory(PARENT, 0o755)
    if ROOT.exists() or ROOT.is_symlink():
        raise RuntimeError("Preflight root already exists; partial installation cannot be replayed")
    if processes() or domain_present():
        raise RuntimeError("UID422 already has processes or a service domain")
    operator, worker = pwd.getpwnam(OPERATOR[0]), pwd.getpwnam(WORKER[0])
    if operator.pw_uid != OPERATOR[1] or (worker.pw_uid, worker.pw_gid) != WORKER[1:]:
        raise RuntimeError("Fixed observer identities changed")
    tool_check()


def make_plan():
    audit_available()
    return {"schemaVersion": "device-private-set-preflight/1", "root": str(ROOT), "name": NAME, "uid": UID, "gid": GID,
            "privateSet": str(SET), "simctl": str(SIMCTL), "simctlDigest": SIMCTL_DIGEST,
            "scriptDigest": digest(Path(__file__).read_bytes()), "runtime": RUNTIME, "deviceType": DEVICE_TYPE,
            "forbiddenExistingUdid": FORBIDDEN_UDID, "maximumSeconds": 360,
            "steps": ["Create only unused fixed service account/group 422 and protected fresh root",
                      "UID422 private-set list, create one new device, observe its generated UDID, boot, shutdown, delete, prove empty",
                      "UID501 private-set denial between successful UID422 lists; UID420 fixed private-directory/canary denial only",
                      "Bootout only user/422; non-root UID422 per-PID reaper; three empty process/domain observations"],
            "noAppInstall": True, "noModel": True, "autonomousDispatchAllowed": False,
            "existingGoalDeviceBindingChanged": False,
            "limitations": ["New experiment UDID is not the original frozen production device",
                            "Worker IPC denial and a protected production command proxy are not established here",
                            "Partial creation/unknown cleanup leaves maintenance; no automatic account deletion/retry"]}


def atomic(path, value):
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        write_all(fd, encoded(value)); os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_all(fd, value):
    view = memoryview(value)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise RuntimeError("Incomplete durable write")
        view = view[written:]


def assert_account():
    account = pwd.getpwnam(NAME)
    if (account.pw_uid, account.pw_gid, account.pw_dir, account.pw_shell) != (UID, GID, str(HOME), "/usr/bin/false"):
        raise RuntimeError("Dedicated device identity changed")
    group = successful(run(["/usr/bin/dscl", ".", "-read", "/Groups/" + NAME, "PrimaryGroupID"])).strip()
    if group != "PrimaryGroupID: 422":
        raise RuntimeError("Dedicated group identity changed")
    for kind, attr in [("Users", "UniqueID"), ("Groups", "PrimaryGroupID")]:
        rows = directory_rows(successful(run(["/usr/bin/dscl", ".", "-list", "/" + kind, attr])))
        if [row for row in rows if row[0] == NAME or row[1] == UID] != [(NAME, UID)]:
            raise RuntimeError("Dedicated directory identity is not unique")


def tool_argv(action, udid=None, name=None):
    prefix = [XCRUN, "simctl", "--set", str(SET)]
    if action == "list":
        return prefix + ["list", "devices", "-j"]
    if action == "create" and isinstance(name, str) and re.fullmatch(r"Loopit UID422 Preflight [0-9a-f-]{36}", name):
        return prefix + ["create", name, DEVICE_TYPE, RUNTIME]
    if action in ("boot", "bootstatus", "shutdown", "delete"):
        validate_udid(udid)
        return prefix + [action, udid] + (["-b"] if action == "bootstatus" else [])
    raise RuntimeError("Unapproved fixed device command")


def validate_udid(udid):
    if not isinstance(udid, str) or not re.fullmatch(r"[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}", udid) or udid == FORBIDDEN_UDID:
        raise RuntimeError("No observed new experiment UDID")


def devices(text):
    raw = json.loads(text)
    if not isinstance(raw.get("devices"), dict):
        raise RuntimeError("Unrecognized private device inventory")
    rows = []
    for runtime, values in raw["devices"].items():
        if not isinstance(values, list):
            raise RuntimeError("Unrecognized private runtime inventory")
        for value in values:
            validate_udid(value.get("udid"))
            rows.append(dict(value, runtime=runtime))
    return rows


def owned_device(rows, udid, name):
    validate_udid(udid)
    if len(rows) != 1:
        raise RuntimeError("Private set is not exclusively the new experiment device")
    row = rows[0]
    if row.get("udid") != udid or row.get("name") != name or row.get("runtime") != RUNTIME or row.get("deviceTypeIdentifier") != DEVICE_TYPE or row.get("isAvailable") is not True:
        raise RuntimeError("Observed private device binding changed")
    return row


def reap(signum, pids, deadline):
    if signum not in (signal.SIGTERM, signal.SIGKILL) or any(type(pid) is not int or pid <= 1 or pid == os.getpid() for pid in pids):
        raise RuntimeError("Invalid dedicated process reaper request")
    child = os.fork()
    if child == 0:
        try:
            drop(UID, GID, [GID])
            for pid in set(pids):
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    pass
            os._exit(0)
        except BaseException:
            os._exit(2)
    while time.monotonic() < deadline:
        waited, status = os.waitpid(child, os.WNOHANG)
        if waited == child:
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise RuntimeError("UID422 reaper did not complete successfully")
            return
        time.sleep(.01)
    os.kill(child, signal.SIGKILL)  # Only our still-unreaped direct child.
    os.waitpid(child, os.WNOHANG)
    raise RuntimeError("UID422 reaper timed out")


def stop_device_identity():
    assert_account()
    deadline = time.monotonic() + 20
    if domain_present():
        successful(run(["/bin/launchctl", "bootout", "user/422"], timeout=2))
        while domain_present():
            if time.monotonic() >= deadline:
                raise RuntimeError("Device domain did not disappear")
            time.sleep(.1)
    observations, signals, empty = [], [], 0
    while time.monotonic() < deadline:
        rows, domain = processes(), domain_present()
        observations.append({"processes": rows, "userDomainPresent": domain})
        if domain:
            raise RuntimeError("Device domain reappeared; stop proof unavailable")
        live = [row for row in rows if not row["state"].startswith("Z")]
        if not live:
            empty += 1
            if empty == 3:
                return {"uid": UID, "userDomain": "user/422", "noLiveProcesses": True, "userDomainAbsent": True, "observations": observations, "signals": signals}
        else:
            empty = 0
            signum = signal.SIGTERM if not signals else signal.SIGKILL
            pids = [row["pid"] for row in live]
            reap(signum, pids, deadline)
            signals.append({"signal": int(signum), "pids": pids})
        time.sleep(.1)
    raise RuntimeError("Dedicated UID still has live processes")


def private_access():
    if os.getuid() not in (UID, OPERATOR[1], WORKER[1]) or os.getuid() != os.geteuid():
        raise RuntimeError("Fixed non-root observation identity required")
    answer = {"uid": os.getuid(), "gid": os.getgid(), "kernelGroups": kernel_groups()}
    for label, path, flags in [("public", PUBLIC_CANARY, os.O_RDONLY), ("directory", SET, os.O_RDONLY | os.O_DIRECTORY), ("canary", CANARY, os.O_RDONLY)]:
        try:
            fd = os.open(path, flags | os.O_NOFOLLOW)
            os.close(fd)
            answer[label] = {"opened": True}
        except OSError as error:
            answer[label] = {"opened": False, "errno": error.errno}
    return answer


def probe(state, persist):
    global WORK_DEADLINE
    identity = (UID, GID, [GID], str(HOME))
    def device(action, udid=None, timeout=15, as_identity=identity):
        assert_account(); tool_check()
        argv = tool_argv(action, udid, state["deviceName"])
        result = run(argv, timeout, as_identity)
        state["commands"].append({"uid": as_identity[0], "argv": argv, "result": result})
        persist()
        return result
    def listing():
        return devices(successful(device("list")))
    problem = None
    try:
        if listing():
            raise RuntimeError("Fresh private set is not empty")
        state["phase"] = "creating"; persist()
        created = successful(device("create", timeout=30)).strip()
        validate_udid(created)
        owned_device(listing(), created, state["deviceName"])
        state["createdUdid"] = created; state["phase"] = "created-observed"; persist()
        successful(device("boot", created, 30))
        successful(device("bootstatus", created, 120))
        if owned_device(listing(), created, state["deviceName"])["state"] != "Booted":
            raise RuntimeError("New private simulator boot not observed")
        owner = json.loads(successful(run(["/usr/bin/python3", str(RUNNER), "--internal-access"], identity=identity)))
        if owner["uid"] != UID or owner["gid"] != GID or not all(owner[k]["opened"] for k in ("public", "directory", "canary")):
            raise RuntimeError("Owner-side private access baseline failed")
        state["ownerAccessBaseline"] = owner
        state["accessNegatives"] = []
        for account_name, expected_uid in [OPERATOR, WORKER[:2]]:
            account = pwd.getpwnam(account_name)
            if account.pw_uid != expected_uid:
                raise RuntimeError("Negative observer identity changed")
            groups = os.getgrouplist(account_name, account.pw_gid) if expected_uid == OPERATOR[1] else [WORKER[2]]
            observer = (expected_uid, account.pw_gid, groups, account.pw_dir)
            access = json.loads(successful(run(["/usr/bin/python3", str(RUNNER), "--internal-access"], identity=observer)))
            if access["uid"] != expected_uid or access["gid"] != account.pw_gid or set(access["kernelGroups"]) != set(groups) or access["public"].get("opened") is not True:
                raise RuntimeError("Observer identity/public baseline failed")
            if any(access[k].get("opened") is not False or access[k].get("errno") not in (errno.EACCES, errno.EPERM) for k in ("directory", "canary")):
                raise RuntimeError("Private path access was not denied")
            state["accessNegatives"].append(access)
            if expected_uid == OPERATOR[1]:
                help_text = successful(run([XCRUN, "simctl", "help"], identity=observer))
                if "simctl [--set <path>]" not in help_text:
                    raise RuntimeError("Operator tool baseline unavailable")
                state["operatorToolHelpBaseline"] = True
                denied = device("list", as_identity=observer)
                if denied["timedOut"] or denied["overflow"] or denied["exitCode"] in (None, 0) or not re.search(r"permission|not permitted|not accessible|access denied", denied["stderr"], re.I):
                    raise RuntimeError("Operator private-set IPC denial not established")
                state["operatorPrivateSetDenied"] = True
                owned_device(listing(), created, state["deviceName"])
        state["positiveAndNegativeObserved"] = True; persist()
    except BaseException as error:
        problem = str(error)
    finally:
        WORK_DEADLINE = None  # Keep the final 60s reserved for owned-device/UID cleanup.
        state["phase"] = "maintenance"
        try:
            persist()
        except BaseException as error:
            state["persistenceError"] = str(error)
        try:
            udid = state.get("createdUdid")
            if udid:
                current = owned_device(listing(), udid, state["deviceName"])
                if current["state"] != "Shutdown":
                    successful(device("shutdown", udid, 30))
                if owned_device(listing(), udid, state["deviceName"])["state"] != "Shutdown":
                    raise RuntimeError("Shutdown not observed; delete not admitted")
                successful(device("delete", udid, 30))
                if listing():
                    raise RuntimeError("Experiment simulator still present")
                state["experimentDeviceDeleted"] = True
            else:
                state["experimentDeviceDeleted"] = not listing()
            if not state["experimentDeviceDeleted"]:
                raise RuntimeError("Unknown created device requires manual reconciliation")
        except BaseException as error:
            state["cleanupError"] = str(error)
        try:
            state["stopProof"] = stop_device_identity()
        except BaseException as error:
            state["stopError"] = str(error)
        state["error"] = problem
        passed = state.get("positiveAndNegativeObserved") and state.get("experimentDeviceDeleted") and state.get("stopProof") and not any(state.get(k) for k in ("error", "cleanupError", "stopError", "persistenceError"))
        state["phase"] = "stopped" if passed else "maintenance"
        state["status"] = "private-device-preflight-passed" if passed else "blocked"
        persist()


def apply(plan_path, expected):
    global APPLY_DEADLINE, WORK_DEADLINE
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Explicit root apply required")
    raw = Path(plan_path).read_bytes()
    if digest(raw) != expected or json.loads(raw) != make_plan():
        raise RuntimeError("Reviewed plan or current fixed inputs changed")
    APPLY_DEADLINE = time.monotonic() + 360
    WORK_DEADLINE = APPLY_DEADLINE - 60
    ROOT.mkdir(mode=0o755)
    CONTROL.mkdir(mode=0o700); BIN.mkdir(mode=0o755)
    for path, mode in [(ROOT, 0o755), (CONTROL, 0o700), (BIN, 0o755)]:
        os.chmod(path, mode)  # Only newly created, exclusive paths.
    lock = os.open(CONTROL / "install.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = {"schemaVersion": "device-private-set-preflight-result/1", "planDigest": expected,
             "phase": "maintenance", "status": "preparing", "uid": UID, "gid": GID, "privateSet": str(SET),
             "deviceName": "Loopit UID422 Preflight " + str(uuid.uuid4()), "provisioning": [], "commands": [],
             "autonomousDispatchAllowed": False, "existingGoalDeviceBindingChanged": False,
             "modelCalls": 0, "appInstalls": 0, "workerIpcDenialTested": False, "milestonePassed": False}
    persist = lambda: atomic(CONTROL / "result.json", state)
    try:
        persist(); atomic(CONTROL / "plan.json", json.loads(raw))
        source = Path(__file__).read_bytes()
        if digest(source) != json.loads(raw)["scriptDigest"]:
            raise RuntimeError("Installer bytes changed")
        fd = os.open(RUNNER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o555)
        try:
            write_all(fd, source); os.fchmod(fd, 0o555); os.fsync(fd)
        finally:
            os.close(fd)
        changes = [("/Groups/" + NAME, None, None), ("/Groups/" + NAME, "PrimaryGroupID", str(GID)),
                   ("/Groups/" + NAME, "RealName", "Loopit Device Preflight"),
                   ("/Users/" + NAME, None, None), ("/Users/" + NAME, "UniqueID", str(UID)),
                   ("/Users/" + NAME, "PrimaryGroupID", str(GID)), ("/Users/" + NAME, "NFSHomeDirectory", str(HOME)),
                   ("/Users/" + NAME, "UserShell", "/usr/bin/false"), ("/Users/" + NAME, "Password", "*"),
                   ("/Users/" + NAME, "IsHidden", "1")]
        for record, key, value in changes:
            argv = ["/usr/bin/dscl", ".", "-create", record] + ([key, value] if key else [])
            successful(run(argv))
            state["provisioning"].append({"record": record, "attribute": key, "completed": True}); persist()
            if record == "/Groups/" + NAME and key == "PrimaryGroupID":
                if successful(run(["/usr/bin/dscl", ".", "-read", record, key])).strip() != "PrimaryGroupID: 422":
                    raise RuntimeError("Created group ID differs; maintenance, no user creation")
        assert_account()
        for directory in [HOME, HOME / "tmp", SET]:
            directory.mkdir(mode=0o700); os.chown(directory, UID, GID)
            os.chmod(directory, 0o700)
        fd = os.open(CANARY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        try:
            write_all(fd, b"nonsecret-device-preflight\n"); os.fchown(fd, UID, GID); os.fchmod(fd, 0o400); os.fsync(fd)
        finally:
            os.close(fd)
        fd = os.open(PUBLIC_CANARY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        try:
            write_all(fd, b"public-nonsecret-device-preflight\n"); os.fchmod(fd, 0o444); os.fsync(fd)
        finally:
            os.close(fd)
        state["phase"] = "prepared"; persist()
        probe(state, persist)
    except BaseException as error:
        state.update(phase="maintenance", status="blocked", error=str(error)); persist()
    finally:
        os.close(lock)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-out"); parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan"); parser.add_argument("--expected-plan")
    parser.add_argument("--internal-access", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.internal_access:
        if len(sys.argv) != 2:
            raise RuntimeError("Internal access observer accepts no arguments")
        print(json.dumps(private_access())); return 0
    if args.apply:
        if args.plan_out or not args.plan or not args.expected_plan:
            raise RuntimeError("Apply requires only --plan and --expected-plan")
        result = apply(args.plan, args.expected_plan)
        print(json.dumps({"status": result["status"], "phase": result["phase"], "report": str(CONTROL / "result.json"), "autonomousDispatchAllowed": False}))
        return 0 if result["status"] == "private-device-preflight-passed" else 2
    if args.plan or args.expected_plan:
        raise RuntimeError("Plan pins are apply-only")
    plan = make_plan(); data = encoded(plan)
    if args.plan_out:
        fd = os.open(args.plan_out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            write_all(fd, data); os.fsync(fd)
        finally:
            os.close(fd)
    print(json.dumps({"status": "plan-only", "planDigest": digest(data), "plan": plan}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "blocked", "error": str(error), "autonomousDispatchAllowed": False}), file=sys.stderr)
        sys.exit(2)
