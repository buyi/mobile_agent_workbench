#!/usr/bin/env python3
"""Finite root Supervisor for one exclusive Loopit Worker UID.

No listener, daemon installation, sudo rule, or general process-killing API.
An interrupted run leaves a durable active scope. New runs refuse that scope;
explicit recovery must first stop the old controller and all Worker processes.
Only local process reuse is certified, never device/external side-effect recovery.
"""
import argparse
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

STATE = Path("/private/var/loopit/supervisor")
ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "LC_ALL": "C"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def durable_json(path, value):
    data = (json.dumps(value, indent=2) + "\n").encode()
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        written = 0
        while written < len(data):
            written += os.write(fd, data[written:])
        os.fsync(fd)
        if sys.platform == "darwin":
            fcntl.fcntl(fd, 51)  # F_FULLFSYNC; fail rather than claim durable when unavailable.
    finally:
        os.close(fd)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def trusted_file(raw):
    path = Path(raw)
    if not path.is_absolute() or str(path.resolve()) != str(path):
        raise RuntimeError("Trusted files must have canonical absolute paths")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Controller input must be a root-owned file without group/other write access")
    for parent in path.parents:
        info = parent.lstat()
        if info.st_uid != 0 or (info.st_mode & 0o022 and not (info.st_mode & stat.S_ISVTX)):
            raise RuntimeError("Controller input ancestor is not protected")
    return path


def processes(uid):
    output = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,uid=,ruid=,stat="], env=ENV, timeout=5)
    found = []
    for line in output.decode().splitlines():
        fields = line.split()
        if len(fields) != 5:
            raise RuntimeError("Unrecognized process inventory")
        pid, parent, effective, real = map(int, fields[:4])
        if uid in (effective, real):
            found.append({"pid": pid, "ppid": parent, "uid": effective, "ruid": real, "state": fields[4]})
    return found


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


def service_identity(name, expected=None):
    if name not in ("loopit-worker", "loopit-signer"):
        raise RuntimeError("Unregistered service identity")
    account = pwd.getpwnam(name)
    pair = (account.pw_uid, account.pw_gid)
    if not (400 <= pair[0] < 500 and 400 <= pair[1] < 500 and account.pw_shell == "/usr/bin/false"):
        raise RuntimeError("Dedicated service identity does not match policy")
    if expected is not None and pair != tuple(expected):
        raise RuntimeError("Recorded service UID/GID changed; scope remains quarantined")
    return account


def scope_identities(scope):
    worker = service_identity("loopit-worker", (scope.get("workerUid"), scope.get("workerGid")))
    signer = service_identity("loopit-signer", (scope.get("signerUid"), scope.get("signerGid")))
    if worker.pw_uid == signer.pw_uid:
        raise RuntimeError("Worker and Signer identities must differ")
    return worker, signer


def root_service_account(name, expected=None):
    account = service_identity(name, expected)
    if sys.platform != "darwin" or os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Service-domain control requires the macOS root Supervisor")
    return account


def domain_timeout(deadline):
    remaining = 2 if deadline is None else min(2, deadline - time.monotonic())
    if remaining <= 0:
        raise RuntimeError("Service-domain reconciliation exceeded its deadline")
    return remaining


def user_domain_present(account_name, expected=None, deadline=None):
    account = root_service_account(account_name, expected)
    # `print user/UID` CREATES that domain on this macOS. Inspect only the
    # system domain's existing direct children, never the target domain itself.
    result = subprocess.run(["/bin/launchctl", "print", "system"], env=ENV,
                            capture_output=True, text=True, timeout=domain_timeout(deadline))
    if result.returncode != 0 or result.stderr or len(result.stdout) > 8_388_608:
        raise RuntimeError("System service-domain inventory failed; scope remains quarantined")
    marker = "\n\tsubdomains = {\n"
    if not result.stdout.startswith("system = {\n") or result.stdout.count(marker) != 1:
        raise RuntimeError("Unrecognized system service-domain inventory")
    tail = result.stdout.split(marker, 1)[1].splitlines()
    if "\t}" not in tail:
        raise RuntimeError("Unterminated system service-domain inventory")
    lines = tail[:tail.index("\t}")]
    if any(not re.fullmatch(r"\t\t(?:pid|user|gui|login|session)/[0-9]+", line) for line in lines):
        raise RuntimeError("Unrecognized system service-domain entry")
    domains = [line[2:] for line in lines]
    if len(domains) != len(set(domains)):
        raise RuntimeError("Duplicate system service-domain entry")
    return "user/" + str(account.pw_uid) in domains


def bootout_user_domain(account_name, expected, deadline):
    account = root_service_account(account_name, expected)
    # The target comes exclusively from registered, scope-bound service UIDs.
    # No system/gui/operator domain and no caller-supplied launchctl argument.
    domain = "user/" + str(account.pw_uid)
    result = subprocess.run(["/bin/launchctl", "bootout", domain], env=ENV,
                            capture_output=True, text=True, timeout=domain_timeout(deadline))
    if result.returncode != 0:
        raise RuntimeError("Dedicated user-domain bootout failed; scope remains quarantined")
    return {"domain": domain, "at": now(), "exitCode": 0}


def reap_child(signum, account_name="loopit-worker", expected=None, pids=None):
    """Signal only the fresh inventory's PIDs, after dropping every root ID.

    PID reuse into another UID is subject to the non-root kernel permission
    check. Never use a broadcast/group target, including from the service UID.
    """
    account = service_identity(account_name, expected)
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Reaper requires root and the dedicated service account")
    if signum not in (signal.SIGTERM, signal.SIGKILL):
        raise RuntimeError("Unsupported stop signal")
    if not isinstance(pids, (list, tuple)) or not pids or any(
            type(pid) is not int or pid <= 1 or pid == os.getpid() for pid in pids):
        raise RuntimeError("Reaper requires explicit non-self process IDs from a fresh inventory")
    os.setgroups([account.pw_gid])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if not (os.getuid() == os.geteuid() == account.pw_uid != 0 and
            os.getgid() == os.getegid() == account.pw_gid and set(kernel_groups()) == {account.pw_gid}):
        raise RuntimeError("Reaper identity did not drop completely")
    for pid in dict.fromkeys(pids):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass  # Exited since the fresh inventory; the next scan proves stop.


def run_reaper(signum, pids, account_name, expected, deadline):
    read_fd, write_fd = os.pipe()
    try:
        child = os.fork()
    except BaseException:
        os.close(read_fd)
        os.close(write_fd)
        raise
    if child == 0:
        os.close(read_fd)
        try:
            reap_child(signum, account_name, expected, pids)
            os._exit(0)
        except BaseException as error:
            # Only bounded metadata, never arbitrary exception text or child
            # environment. This private pipe is not accessible to Worker code.
            detail = {"errorType": type(error).__name__[:80], "errno": getattr(error, "errno", None)}
            try:
                os.write(write_fd, json.dumps(detail).encode()[:512])
            except BaseException:
                pass
            os._exit(2)
    os.close(write_fd)
    status, timed_out = None, False
    try:
        while True:
            waited, value = os.waitpid(child, os.WNOHANG)
            if waited == child:
                status = value
                break
            if time.monotonic() >= deadline:
                timed_out = True
                try:
                    os.kill(child, signal.SIGKILL)  # Only our still-unreaped child, never a stored PID.
                except ProcessLookupError:
                    pass
                waited, value = os.waitpid(child, os.WNOHANG)
                if waited == child:
                    status = value
                break
            time.sleep(0.01)
        os.set_blocking(read_fd, False)
        try:
            raw = os.read(read_fd, 512)
        except BlockingIOError:
            raw = b""
    finally:
        os.close(read_fd)
    detail = {"waitStatus": status, "exitCode": os.WEXITSTATUS(status) if status is not None and os.WIFEXITED(status) else None,
              "signal": os.WTERMSIG(status) if status is not None and os.WIFSIGNALED(status) else None,
              "timedOut": timed_out}
    if raw:
        detail["childError"] = json.loads(raw)
    if timed_out or detail["exitCode"] != 0:
        raise RuntimeError("Dedicated-UID reaper failed; scope remains quarantined: " + json.dumps(detail, sort_keys=True))
    return detail


def stop_uid(scope, reason, account_name="loopit-worker"):
    prefix = "worker" if account_name == "loopit-worker" else "signer"
    expected = (scope.get(prefix + "Uid"), scope.get(prefix + "Gid"))
    account = root_service_account(account_name, expected)
    uid = account.pw_uid
    observations, signals, bootouts = [], [], []
    deadline = time.monotonic() + 10
    if user_domain_present(account_name, expected, deadline):
        bootouts.append(bootout_user_domain(account_name, expected, deadline))
        # bootout acknowledges removal but does not wait for a whole user
        # domain to disappear. Spend only the existing stop budget waiting for
        # its first absence; any later reappearance still forbids a proof.
        while user_domain_present(account_name, expected, deadline):
            if time.monotonic() >= deadline:
                raise RuntimeError("Dedicated user domain did not disappear before the stop deadline")
            time.sleep(0.1)
        bootouts[-1]["absenceConfirmedAt"] = now()
    empty = 0
    while time.monotonic() < deadline:
        observed = processes(uid)
        live = [p for p in observed if not p["state"].startswith("Z")]
        domain_present = user_domain_present(account_name, expected, deadline)
        observations.append({"at": now(), "processes": observed, "userDomainPresent": domain_present,
                             "domainObservationMethod": "launchctl-print-system/subdomains"})
        if domain_present:
            raise RuntimeError("Dedicated user domain remains or reappeared; stop proof forbidden")
        if not live:
            empty += 1
            if empty == 3:
                return {"schemaVersion": "worker-stop-proof/1", "scopeId": scope["scopeId"],
                        "generation": scope["generation"], "workerUid": scope["workerUid"],
                        "serviceAccount": account_name, "observedUid": uid, "observedGid": account.pw_gid,
                        "reason": reason, "observedAt": now(), "noLiveWorkerProcesses": True,
                        "userDomainAbsent": True, "userDomain": "user/" + str(uid),
                        "domainObservationMethod": "launchctl-print-system/subdomains", "domainBootouts": bootouts,
                        "scope": "exclusive-local-Worker-UID-only", "externalActionsVerified": False,
                        "signals": signals, "observations": observations}
        else:
            empty = 0
            signum = signal.SIGTERM if not signals else signal.SIGKILL
            pids = [process["pid"] for process in live]
            receipt = run_reaper(signum, pids, account_name, expected, deadline)
            signals.append({"signal": int(signum), "pids": pids, "at": now(), "reaper": receipt})
        time.sleep(0.2)
    raise RuntimeError("Worker processes remain; scope stays quarantined")


def require_root():
    if sys.platform != "darwin" or os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Explicit macOS administrator execution is required")
    worker = service_identity("loopit-worker")
    signer = service_identity("loopit-signer")
    if signer.pw_uid == worker.pw_uid:
        raise RuntimeError("Worker and Signer identities must differ")
    STATE.mkdir(mode=0o700, exist_ok=True)
    info = STATE.lstat()
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or STATE.is_symlink():
        raise RuntimeError("Supervisor state must be root-owned 0700")
    for part in ("home", "config", "data", "cache", "state", "tmp"):
        (STATE / part).mkdir(mode=0o700, exist_ok=True)
    for parent in STATE.parents:
        info = parent.lstat()
        if info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise RuntimeError("Supervisor state ancestor is unprotected")
    gate = os.open(STATE / "launch.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(gate)
    os.close(gate)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise RuntimeError("Launch gate must be root-owned private regular file")
    return worker


def close_admission_and_stop(scope, reason, write_initial_proof=False):
    # Delayed root launchers either complete their UID drop before this gate, or
    # see revoked admission afterward. A stuck launcher means no stop proof.
    gate = os.open(STATE / "launch.lock", os.O_RDWR | os.O_NOFOLLOW)
    try:
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("A launcher has not finished dropping identity; stop proof forbidden")
                time.sleep(0.02)
        scope_identities(scope)
        current = json.loads((STATE / "active.json").read_text())
        if (current.get("scopeId"), current.get("generation")) != (scope["scopeId"], scope["generation"]):
            raise RuntimeError("Stale Supervisor scope cannot revoke another generation")
        scope.update({"phase": "stopping", "admissionDeadline": 0})
        durable_json(STATE / "active.json", scope)
        proof = stop_uid(scope, reason)
        signer_proof = stop_uid(scope, reason, "loopit-signer")
        if write_initial_proof:
            durable_json(STATE / (scope["scopeId"] + ".stop.json"), proof)
        scope.update({"phase": "stopped", "stopProof": proof, "signerStopProof": signer_proof})
        durable_json(STATE / "active.json", scope)
        return proof, signer_proof
    finally:
        os.close(gate)


def open_admission(scope, phase, deadline):
    scope_identities(scope)
    if phase not in ("running", "finalizing") or deadline <= time.time():
        raise RuntimeError("Cannot open an expired or unregistered launch phase")
    gate = os.open(STATE / "launch.lock", os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
        scope.update({"phase": phase, "admissionDeadline": deadline})
        durable_json(STATE / "active.json", scope)
    finally:
        os.close(gate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["run", "recover", "inspect"])
    parser.add_argument("--bun")
    parser.add_argument("--controller")
    parser.add_argument("--spec")
    parser.add_argument("--finalize", action="store_true", help="Call the same trusted controller after the stop proof")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    args = parser.parse_args()
    worker = require_root()
    if not 1 <= args.timeout_seconds <= 3600:
        raise RuntimeError("Deadline must be within the authorized 60-minute bound")
    lock = os.open(STATE / "ownership.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("A Supervisor owns the Worker; concurrent admission is forbidden")
    active_path, generation_path = STATE / "active.json", STATE / "generation.json"
    active = json.loads(active_path.read_text()) if active_path.exists() else None
    if args.mode == "inspect":
        print(json.dumps({"active": active, "workerProcesses": processes(worker.pw_uid)}))
        return
    if args.mode == "recover":
        if not active:
            raise RuntimeError("No recorded scope; unknown processes will not be adopted or killed")
        if active.get("phase") == "maintenance":
            raise RuntimeError("Maintenance quarantine requires explicit update repair/reconciliation; ordinary recovery is forbidden")
        scope_identities(active)
        # A live root controller could start new children. Do not signal a stored
        # PID or infer ownership across restarts; require its exit before recovery.
        pid = active.get("controllerPid")
        if pid:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError("Recorded controller PID is present; reconcile its identity/exit first")
        proof, signer_proof = close_admission_and_stop(active, "explicit recovery of interrupted scope", write_initial_proof=True)
        print(json.dumps({"status": "recovered", "scopeId": active["scopeId"], "proof": str(STATE / (active["scopeId"] + ".stop.json"))}))
        return
    if active and active.get("phase") != "stopped":
        raise RuntimeError("Old scope has no stop proof; recover before admitting another run")
    if processes(worker.pw_uid):
        raise RuntimeError("Worker UID already has processes; no new run admitted")
    signer = service_identity("loopit-signer")
    if not 400 <= signer.pw_uid < 500 or signer.pw_uid == worker.pw_uid or processes(signer.pw_uid):
        raise RuntimeError("Signer identity is unavailable or already executing")
    for name, account in (("loopit-worker", worker), ("loopit-signer", signer)):
        if user_domain_present(name, (account.pw_uid, account.pw_gid)):
            raise RuntimeError("Dedicated user domain already exists; no new run admitted")
    binary, controller, spec = [trusted_file(p) for p in (args.bun, args.controller, args.spec)]
    generation = (json.loads(generation_path.read_text())["generation"] if generation_path.exists() else 0) + 1
    durable_json(generation_path, {"generation": generation})
    scope = {"schemaVersion": "worker-scope/1", "scopeId": str(uuid.uuid4()), "generation": generation,
             "workerUid": worker.pw_uid, "workerGid": worker.pw_gid, "signerUid": signer.pw_uid, "signerGid": signer.pw_gid,
             "startedAt": now(), "phase": "reserved",
             "controllerDigest": "sha256:" + hashlib.sha256(controller.read_bytes()).hexdigest(),
             "specDigest": "sha256:" + hashlib.sha256(spec.read_bytes()).hexdigest()}
    if active:
        # Carry the prior durable local proof into the new protected scope.
        # The controller must still verify its fields before authorizing recovery.
        scope["priorStopProofs"] = {"scopeId": active["scopeId"], "generation": active["generation"],
                                    "worker": active.get("stopProof"), "signer": active.get("signerStopProof")}
    durable_json(active_path, scope)
    absolute_deadline = time.time() + args.timeout_seconds
    open_admission(scope, "running", absolute_deadline)
    log = STATE / (scope["scopeId"] + ".controller.log")
    timed_out = False
    with log.open("xb", buffering=0) as output:
        os.chmod(log, 0o600)
        # Inherit the actual flock open-file description. If the Supervisor is
        # killed between spawn and PID persistence, the trusted controller still
        # holds admission closed. The controller must preserve this descriptor.
        child_env = {**ENV, "LOOPIT_SUPERVISOR_LOCK_FD": str(lock), "LOOPIT_SCOPE_ID": scope["scopeId"],
                     "LOOPIT_GENERATION": str(generation), "HOME": str(STATE / "home"),
                     "XDG_CONFIG_HOME": str(STATE / "config"), "XDG_DATA_HOME": str(STATE / "data"),
                     "XDG_CACHE_HOME": str(STATE / "cache"), "XDG_STATE_HOME": str(STATE / "state"),
                     "TMPDIR": str(STATE / "tmp")}
        child = subprocess.Popen([str(binary), str(controller), "--phase", "execute", "--spec", str(spec), "--scope", scope["scopeId"],
                                  "--generation", str(generation)], cwd=str(spec.parent), env=child_env,
                                 stdout=output, stderr=output, start_new_session=True, pass_fds=(lock,))
        scope.update({"controllerPid": child.pid, "phase": "running"})
        durable_json(active_path, scope)
        deadline = time.monotonic() + max(0, absolute_deadline - time.time())
        while child.poll() is None:
            if time.monotonic() >= deadline or log.stat().st_size > 4_194_304:
                timed_out = True
                child.kill()  # live Popen ownership, never a persisted PID.
                break
            time.sleep(0.1)
        code = child.wait(timeout=10)
    scope.update({"controllerExitCode": code, "timedOut": timed_out})
    proof, signer_proof = close_admission_and_stop(scope, "controller timeout" if timed_out else "controller exit", write_initial_proof=True)
    finalizer_code = None
    if args.finalize and code == 0 and not timed_out:
        # The UID remains exclusively owned while the immutable candidate is
        # collected and independently verified. No new Worker admission occurs.
        open_admission(scope, "finalizing", min(absolute_deadline, time.time() + 120))
        with log.open("ab", buffering=0) as output:
            finalizer = subprocess.Popen([str(binary), str(controller), "--phase", "finalize", "--spec", str(spec),
                                          "--scope", scope["scopeId"], "--generation", str(generation),
                                          "--stop-proof", str(STATE / (scope["scopeId"] + ".stop.json"))],
                                         cwd=str(spec.parent), env=child_env, stdout=output, stderr=output,
                                         start_new_session=True, pass_fds=(lock,))
            try:
                finalizer_code = finalizer.wait(timeout=max(0.01, min(120, absolute_deadline - time.time())))
            except subprocess.TimeoutExpired:
                finalizer.kill()
                finalizer_code = finalizer.wait(timeout=10)
        scope["finalizerExitCode"] = finalizer_code
        _, signer_proof = close_admission_and_stop(scope, "independent verifier finished")
    print(json.dumps({"status": "controller-finished" if code == 0 and not timed_out and finalizer_code in (None, 0) else "controller-failed",
                      "scopeId": scope["scopeId"], "generation": generation, "controllerExitCode": code,
                      "stopProof": str(STATE / (scope["scopeId"] + ".stop.json")), "log": str(log),
                      "finalizerExitCode": finalizer_code}))
    if code != 0 or timed_out or finalizer_code not in (None, 0):
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "blocked", "error": str(error)}))
        sys.exit(2)
