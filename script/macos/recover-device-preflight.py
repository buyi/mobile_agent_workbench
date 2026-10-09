#!/usr/bin/env python3
"""One reviewed UID422 recovery attempt; never reprovisions or edits old evidence.

Default: --plan-out NEW.json (reads only the exported prior report).
Root: --apply --plan PLAN --expected-plan sha256:... (after protected staging).
Live account/path/runner and current stop/empty-set checks happen during apply.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import types
import uuid

ROOT = Path("/private/var/loopit/device-probe-20261009a")
CONTROL = ROOT / "control"
RUNNER = ROOT / "bin/device-preflight.py"
HOME = ROOT / "home"
SET = HOME / "private-device-set"
OLD_EXPORT = Path("/private/tmp/loopit-device-preflight-stage-20261009a/result.json")
OLD_REPORT_DIGEST = "sha256:7d87e1561c0df7eb82826db936d20b8380a65316524509823d972649957ebe2d"
OLD_PLAN_DIGEST = "sha256:11bca1f222ba576eef3a1bbb17b58bc44f605da7bdba3d99cb35f12b9b278a65"
RUNNER_DIGEST = "sha256:885b016c7bd97c7e41d97370034a99f2fbcd8aa16613dea3633cf4d6a26024cc"
ATTEMPT = "device-private-set-recovery-20261009b"
RECOVERIES = CONTROL / "recoveries"
ATTEMPT_ROOT = RECOVERIES / ATTEMPT
LIST = ["/usr/bin/xcrun", "simctl", "--set", str(SET), "list", "devices", "-j"]


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_file(path, protected=False, expected_mode=None, expected_uid=0, limit=1024 * 1024):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise RuntimeError("Expected a canonical non-symbolic path")
    if protected:
        for parent in path.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise RuntimeError("Unprotected file ancestor")
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise RuntimeError("Expected a bounded single-link regular file")
        if protected and (before.st_uid != expected_uid or before.st_mode & 0o022):
            raise RuntimeError("Unexpected protected file ownership or write permission")
        if expected_mode is not None and stat.S_IMODE(before.st_mode) != expected_mode:
            raise RuntimeError("Unexpected protected file mode")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise RuntimeError("Input grew beyond limit")
            chunks.append(chunk)
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != before.st_size:
            raise RuntimeError("Input changed while reading")
        return b"".join(chunks)
    finally:
        os.close(fd)


def validate_previous(raw):
    if digest(raw) != OLD_REPORT_DIGEST:
        raise RuntimeError("Exact prior failure report pin required")
    report = json.loads(raw)
    if report.get("schemaVersion") != "device-private-set-preflight-result/1" or report.get("status") != "blocked" or report.get("phase") != "maintenance" or report.get("planDigest") != OLD_PLAN_DIGEST:
        raise RuntimeError("Prior attempt is not the reviewed stopped failure")
    if (report.get("uid"), report.get("gid"), report.get("privateSet")) != (422, 422, str(SET)) or report.get("createdUdid") or report.get("modelCalls") != 0 or report.get("appInstalls") != 0:
        raise RuntimeError("Prior attempt may have created an effect outside this recovery")
    if report.get("experimentDeviceDeleted") is not True or report.get("cleanupError") or report.get("stopError"):
        raise RuntimeError("Prior cleanup/stop remains unknown")
    commands = report.get("commands", [])
    if len(commands) != 2 or any(command.get("uid") != 422 or command.get("argv") != LIST for command in commands):
        raise RuntimeError("Prior attempt must contain only the two reviewed list commands")
    first, last = [command["result"] for command in commands]
    if first != {"exitCode": -9, "timedOut": True, "overflow": False, "stdout": "", "stderr": ""}:
        raise RuntimeError("Prior failure is not the reviewed cold-start timeout")
    if last.get("exitCode") != 0 or last.get("timedOut") or last.get("overflow") or last.get("stderr"):
        raise RuntimeError("Prior private-set observation is uncertain")
    empty_devices(last["stdout"])
    stop = report.get("stopProof", {})
    if stop.get("uid") != 422 or stop.get("userDomain") != "user/422" or stop.get("noLiveProcesses") is not True or stop.get("userDomainAbsent") is not True:
        raise RuntimeError("Prior fixed-identity stop proof is missing")
    observations = stop.get("observations", [])
    if len(observations) != 3 or any(row.get("processes") != [] or row.get("userDomainPresent") is not False for row in observations):
        raise RuntimeError("Prior three empty observations are missing")
    return report


def empty_devices(text):
    value = json.loads(text)
    if not isinstance(value, dict) or not isinstance(value.get("devices"), dict) or any(not isinstance(rows, list) or rows for rows in value["devices"].values()):
        raise RuntimeError("Private device set is not observed empty")


def make_plan():
    old = validate_previous(read_file(OLD_EXPORT))
    return {"schemaVersion": "device-preflight-recovery-plan/1", "attemptId": ATTEMPT,
            "fixedRoot": str(ROOT), "attemptRoot": str(ATTEMPT_ROOT), "uid": 422, "gid": 422,
            "priorReportDigest": OLD_REPORT_DIGEST, "priorPlanDigest": OLD_PLAN_DIGEST,
            "priorDeviceName": old["deviceName"], "installedRunnerDigest": RUNNER_DIGEST,
            "recoveryScriptDigest": digest(Path(__file__).read_bytes()),
            "firstListSeconds": 60, "maximumSeconds": 360, "reservedCleanupSeconds": 60,
            "currentStopObservationsRequired": 3, "freshEmptySetRequiredBeforeCreate": True,
            "provisioningAllowed": False, "operatorFallbackAllowed": False,
            "autonomousDispatchAllowed": False, "existingGoalDeviceBindingChanged": False,
            "liveAudit": "pending root apply; old evidence alone does not authorize another probe",
            "interpretation": "One initial list timeout does not establish that this OS lacks private-set support"}


def load_original():
    source = read_file(RUNNER, protected=True, expected_mode=0o555)
    if digest(source) != RUNNER_DIGEST:
        raise RuntimeError("Installed original runner changed")
    module = types.ModuleType("loopit_pinned_original_device_preflight")
    module.__file__ = str(RUNNER)
    exec(compile(source, str(RUNNER), "exec"), module.__dict__)
    return module


def audit_installed(module):
    for path, mode in [(ROOT, 0o755), (CONTROL, 0o700), (ROOT / "bin", 0o755)]:
        module.root_directory(path, mode)
    module.assert_account()
    module.tool_check()
    for path in [HOME, HOME / "tmp", SET]:
        if path.resolve() != path:
            raise RuntimeError("Private path is symbolic")
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (422, 422, 0o700):
            raise RuntimeError("Private directory ownership/mode changed")
        if len(module.successful(module.run(["/bin/ls", "-lde", str(path)])).splitlines()) != 1:
            raise RuntimeError("Private path ACL changed")
    # These nonsecret fixture files are private-owner/public respectively. Their
    # modes are checked without reading any user credentials or key material.
    for path, uid, mode in [(HOME / "nonsecret-canary", 422, 0o400), (ROOT / "public-nonsecret-canary", 0, 0o444)]:
        info = path.lstat()
        if path.resolve() != path or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode:
            raise RuntimeError("Fixed canary metadata changed")
        if len(module.successful(module.run(["/bin/ls", "-le", str(path)])).splitlines()) != 1:
            raise RuntimeError("Fixed canary ACL changed")
    current = read_file(CONTROL / "result.json", protected=True, expected_mode=0o600)
    validate_previous(current)
    if digest(read_file(CONTROL / "plan.json", protected=True, expected_mode=0o600)) != OLD_PLAN_DIGEST:
        raise RuntimeError("Installed original plan changed")
    if digest(read_file(RUNNER, protected=True, expected_mode=0o555)) != RUNNER_DIGEST:
        raise RuntimeError("Original runner changed during audit")


def observe_stopped(module):
    observations = []
    for _ in range(3):
        processes, domain = module.processes(), module.domain_present()
        observations.append({"at": now(), "processes": processes, "userDomainPresent": domain})
        if processes or domain:
            raise RuntimeError("Current UID422 is not stopped; no probe admission")
        time.sleep(.1)
    return observations


def require_stopped_observations(observations):
    if len(observations) != 3 or any(row.get("processes") != [] or row.get("userDomainPresent") is not False for row in observations):
        raise RuntimeError("Current stop observations are required before probe admission")


def run_attempt(module, state, save):
    """Reuse the exact installed probe; extend only its first UID422 list bound.

    The empty-set admission is persisted by the original probe's pre-create
    transition. No second cold startup is introduced between that observation
    and create, and neither old observations nor a successful cleanup list can
    stand in for it.
    """
    require_stopped_observations(state.get("currentStopObservations", []))
    original_run = module.run
    first = True

    def bounded(argv, timeout=5, identity=None):
        nonlocal first
        if argv and argv[0] == "/usr/bin/dscl" and "-create" in argv:
            raise RuntimeError("Recovery never provisions or repairs an account")
        if argv == LIST and identity and identity[0] == 422 and first:
            first = False
            state["firstListBudgetSeconds"] = 60
            return original_run(argv, 60, identity)
        return original_run(argv, timeout, identity)

    def persist():
        if state.get("phase") == "creating" and "admissionProof" not in state:
            observations = state.get("currentStopObservations", [])
            commands = state.get("commands", [])
            require_stopped_observations(observations)
            if len(commands) != 1 or commands[0].get("uid") != 422 or commands[0].get("argv") != LIST:
                raise RuntimeError("A fresh, first private-set observation is required")
            observation = module.successful(commands[0]["result"])
            if commands[0]["result"].get("stderr"):
                raise RuntimeError("Private-set admission has unexpected diagnostics")
            empty_devices(observation)
            state["admissionProof"] = {"at": now(), "priorReportDigest": OLD_REPORT_DIGEST,
                                       "currentStopDigest": digest(encoded(observations)),
                                       "freshEmptySetCommandDigest": digest(encoded(commands[0])),
                                       "privateSetEmpty": True}
        save()

    module.run = bounded
    try:
        module.probe(state, persist)
    finally:
        module.run = original_run


def apply(plan_path, expected):
    if sys.platform != "darwin" or os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Explicit macOS root apply required")
    raw = read_file(Path(plan_path), protected=True)
    source = read_file(Path(__file__), protected=True)
    if digest(raw) != expected or json.loads(raw) != make_plan() or json.loads(raw)["recoveryScriptDigest"] != digest(source):
        raise RuntimeError("Reviewed recovery plan/script changed")
    module = load_original()
    module.APPLY_DEADLINE = time.monotonic() + 360
    module.WORK_DEADLINE = module.APPLY_DEADLINE - 60
    lock = os.open(CONTROL / "install.lock", os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o600):
            raise RuntimeError("Original UID422 lock changed")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        audit_installed(module)
        if RECOVERIES.exists():
            module.root_directory(RECOVERIES, 0o700)
            if list(RECOVERIES.iterdir()):
                raise RuntimeError("A recovery attempt already exists; never retry it implicitly")
        else:
            RECOVERIES.mkdir(mode=0o700)
        ATTEMPT_ROOT.mkdir(mode=0o700)
        state = {"schemaVersion": "device-private-set-recovery-result/1", "attemptId": ATTEMPT,
                 "recoveryPlanDigest": expected, "priorReportDigest": OLD_REPORT_DIGEST, "priorPlanDigest": OLD_PLAN_DIGEST,
                 "installedRunnerDigest": RUNNER_DIGEST, "startedAt": now(),
                 "phase": "admission-pending", "status": "preparing", "uid": 422, "gid": 422, "privateSet": str(SET),
                 "deviceName": "Loopit UID422 Preflight " + str(uuid.uuid4()), "commands": [],
                 "provisioningPerformed": False, "autonomousDispatchAllowed": False, "existingGoalDeviceBindingChanged": False,
                 "modelCalls": 0, "appInstalls": 0, "workerIpcDenialTested": False, "milestonePassed": False}
        save = lambda: module.atomic(ATTEMPT_ROOT / "result.json", state)
        module.atomic(ATTEMPT_ROOT / "plan.json", json.loads(raw))
        save()
        try:
            state["currentStopObservations"] = observe_stopped(module)
            save()
            run_attempt(module, state, save)
        except BaseException as error:
            state.update(phase="maintenance", status="blocked", error=str(error))
        finally:
            # If admission failed, no UID422 command was started by this attempt;
            # it must not kill an unknown pre-existing owner to manufacture proof.
            try:
                unchanged = (digest(read_file(CONTROL / "result.json", protected=True)) == OLD_REPORT_DIGEST and
                             digest(read_file(CONTROL / "plan.json", protected=True)) == OLD_PLAN_DIGEST and
                             digest(read_file(RUNNER, protected=True)) == RUNNER_DIGEST)
            except BaseException as error:
                unchanged = False
                state["priorArtifactsCheckError"] = str(error)
            state["priorArtifactsUnchanged"] = unchanged
            if not unchanged:
                state.update(phase="maintenance", status="blocked", error="Prior evidence or runner changed")
            state["finishedAt"] = now(); save()
        return state
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-out"); parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan"); parser.add_argument("--expected-plan")
    args = parser.parse_args()
    if args.apply:
        if args.plan_out or not args.plan or not args.expected_plan:
            raise RuntimeError("Apply requires only --plan and --expected-plan")
        result = apply(args.plan, args.expected_plan)
        print(json.dumps({"status": result["status"], "phase": result["phase"], "report": str(ATTEMPT_ROOT / "result.json"), "autonomousDispatchAllowed": False}))
        return 0 if result["status"] == "private-device-preflight-passed" else 2
    if args.plan or args.expected_plan:
        raise RuntimeError("Plan pins are apply-only")
    plan = make_plan(); data = encoded(plan)
    if args.plan_out:
        fd = os.open(args.plan_out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(data); output.flush(); os.fsync(output.fileno())
        except BaseException:
            raise
    print(json.dumps({"status": "plan-only-live-audit-pending", "planDigest": digest(data), "plan": plan}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "blocked", "error": str(error), "autonomousDispatchAllowed": False}), file=sys.stderr)
        sys.exit(2)
