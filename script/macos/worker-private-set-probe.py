#!/usr/bin/env python3
"""Fixed private-set observations, under the existing root Supervisor.

Default --plan-out NEW.json reads exported evidence only. Stage this script,
recover-device-preflight.py and plan.json as protected root files. The existing
Supervisor invokes /usr/bin/python3 SCRIPT --phase execute --spec PLAN --scope
SCOPE --generation N and retains responsibility for stopping Worker UID420.
Default mode observes an empty set without mutation. The explicit
live-default-bypass-v1 plan creates one new UID422 device, probes UID420 default
lookup/rename, and cleans up only that observed device. Neither mode grants an
autonomous capability, installs an app or changes the original goal device.
"""
import argparse
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

HELPER_DIGEST = "sha256:93c0c38c732ef0bc752878cf3cd3220f76eb6209bbffdbe6c452ec6ce57d5831"
PRIOR_DIGEST = "sha256:4aa0318b09ccfd912ef93aeec4a9ff2ed40b677cab357c4589dc9e7aedec8c09"
EXPORT = Path("/Users/buyi/Documents/bench/.bench/m0-fixes/device-private-set-actual-v2/result.json")
STATE = Path("/private/var/loopit/supervisor")
ATTEMPT = "worker-private-path-20261009a"
LIVE_MODE = "live-default-bypass-v1"
LIVE_ATTEMPT = "worker-live-device-bypass-20261009a"
FORBIDDEN_EXISTING_UDID = "62F1C107-7480-41BD-B2E2-6C3323B8ECDA"


def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def load_helper(protected=False):
    path = Path(__file__).absolute().with_name("recover-device-preflight.py")
    if path.resolve() != path:
        raise RuntimeError("Helper alias rejected")
    if protected:
        for ancestor in path.parents:
            info = ancestor.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise RuntimeError("Helper ancestor is not protected")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024 or (protected and (info.st_uid != 0 or info.st_mode & 0o022)):
            raise RuntimeError("Helper is not a bounded protected regular file")
        raw = os.read(fd, 1024 * 1024 + 1)
        if len(raw) != info.st_size or digest(raw) != HELPER_DIGEST:
            raise RuntimeError("Fixed recovery helper bytes changed")
    finally:
        os.close(fd)
    module = types.ModuleType("pinned_device_recovery")
    module.__file__ = str(path)
    exec(compile(raw, str(path), "exec"), module.__dict__)
    return module


def validate_prior(raw):
    if digest(raw) != PRIOR_DIGEST:
        raise RuntimeError("Exact reviewed recovery report required")
    value = json.loads(raw)
    if value.get("status") != "blocked" or value.get("phase") != "maintenance" or value.get("error") != "Operator private-set IPC denial not established":
        raise RuntimeError("Prior attempt differs from the reviewed partial observation")
    if value.get("experimentDeviceDeleted") is not True or value.get("priorArtifactsUnchanged") is not True:
        raise RuntimeError("Prior device cleanup/evidence is unknown")
    proof = value.get("stopProof", {})
    if proof.get("uid") != 422 or proof.get("userDomainAbsent") is not True or proof.get("noLiveProcesses") is not True:
        raise RuntimeError("Prior UID422 stop proof missing")
    rows = proof.get("observations", [])[-3:]
    if len(rows) != 3 or any(row.get("processes") != [] or row.get("userDomainPresent") is not False for row in rows):
        raise RuntimeError("Prior final empty observations missing")
    return value


def make_plan(helper, prior_raw, mode="empty-private-path-v1"):
    prior = validate_prior(prior_raw)
    if mode == LIVE_MODE:
        return {"schemaVersion": "worker-live-device-bypass-plan/1", "mode": LIVE_MODE, "attemptId": LIVE_ATTEMPT,
                "scriptDigest": digest(Path(__file__).read_bytes()), "helperDigest": HELPER_DIGEST,
                "priorReportDigest": PRIOR_DIGEST, "originalRunnerDigest": helper.RUNNER_DIGEST,
                "privateSet": str(helper.SET), "deletedPriorUdid": prior["createdUdid"],
                "forbiddenExistingUdid": FORBIDDEN_EXISTING_UDID,
                "ownerUid": 422, "workerUid": 420, "workerGid": 420, "workerKernelGroups": [420],
                "maximumSeconds": 420, "reservedCleanupSeconds": 120,
                "steps": ["Audit fixed accounts/paths/runner and original reports under UID422 install.lock",
                          "Observe current UID422 processes/domain absent, then its fresh private set empty",
                          "Persist one create intent; create a unique new device and bind its returned UDID/name/type/runtime",
                          "Boot that device and observe it Booted; prove UID422 public/private access",
                          "UID420 public access and simctl help baseline; require private directory/canary DAC denial",
                          "UID420 default list must omit the live target; default rename must precisely reject its actual UDID",
                          "UID420 explicit private-set list must reject the fixed private path",
                          "UID422 re-observes the same live UDID/name after every probe; any bypass stays failed even if restored",
                          "Finally UID422 observes only the created device, restores a probe rename if observed, shuts down and deletes it, proves empty, then stops its identity",
                          "Existing Supervisor independently stops UID420 and UID421; correlate its final scope proofs"],
                "deviceMutationsAllowed": "one new private device lifecycle and reversible rename of that UDID only",
                "unknownCreateOrCleanupRetryAllowed": False, "operatorUid501Tested": False,
                "defaultSetCliTested": True, "completeNativeIpcControlProven": False,
                "autonomousDispatchAllowed": False, "existingGoalDeviceBindingChanged": False,
                "interpretation": "Prepared fixed live-device CLI experiment, not a production executor or proof covering all native IPC"}
    if mode != "empty-private-path-v1":
        raise RuntimeError("Unknown fixed probe mode")
    return {"schemaVersion": "worker-private-path-probe-plan/1", "attemptId": ATTEMPT,
            "scriptDigest": digest(Path(__file__).read_bytes()), "helperDigest": HELPER_DIGEST,
            "priorReportDigest": PRIOR_DIGEST, "originalRunnerDigest": helper.RUNNER_DIGEST,
            "privateSet": str(helper.SET), "deletedPriorUdid": prior["createdUdid"],
            "ownerUid": 422, "workerUid": 420, "workerGid": 420, "workerKernelGroups": [420],
            "maximumSeconds": 180, "reservedCleanupSeconds": 60,
            "steps": ["Audit fixed account/paths/runner and pin prior reports under UID422 install.lock",
                      "Observe UID422 processes and user domain absent three times",
                      "UID422 public/private access and explicit private-set list must succeed with an empty set",
                      "UID420 public access and simctl help baseline; private directory/canary denial; fixed private-set list denial",
                      "UID422 same-path empty list and access baseline again, then UID422 cleanup",
                      "Existing Supervisor independently stops UID420 after controller exit; correlate its final scope proof"],
            "deviceMutationsAllowed": False, "defaultSetTested": False, "nativeIpcControlTested": False,
            "autonomousDispatchAllowed": False, "existingGoalDeviceBindingChanged": False,
            "interpretation": "Only fixed private-path access; deleted UDIDs are never used as denial fixtures"}


def supervisor_admission(helper, plan_path, scope_id, generation):
    raw = helper.read_file(Path(plan_path), protected=True)
    self_raw = helper.read_file(Path(__file__), protected=True)
    scope_raw = helper.read_file(STATE / "active.json", protected=True, expected_mode=0o600)
    scope = json.loads(scope_raw)
    if (scope.get("scopeId"), scope.get("generation"), scope.get("phase")) != (scope_id, generation, "running"):
        raise RuntimeError("No matching active Supervisor scope")
    if (scope.get("workerUid"), scope.get("workerGid"), scope.get("signerUid")) != (420, 420, 421):
        raise RuntimeError("Supervisor identity differs")
    if scope.get("controllerDigest") != digest(self_raw) or scope.get("specDigest") != digest(raw):
        raise RuntimeError("Supervisor controller/plan binding differs")
    if os.environ.get("LOOPIT_SCOPE_ID") != scope_id or os.environ.get("LOOPIT_GENERATION") != str(generation):
        raise RuntimeError("Missing inherited Supervisor scope binding")
    raw_fd = os.environ.get("LOOPIT_SUPERVISOR_LOCK_FD", "")
    if not raw_fd.isdigit() or int(raw_fd) < 3:
        raise RuntimeError("Missing inherited ownership descriptor")
    fd = int(raw_fd)
    lock_info, expected = os.fstat(fd), (STATE / "ownership.lock").lstat()
    if (lock_info.st_dev, lock_info.st_ino) != (expected.st_dev, expected.st_ino) or not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != 0 or stat.S_IMODE(lock_info.st_mode) != 0o600 or lock_info.st_nlink != 1:
        raise RuntimeError("Ownership descriptor differs from the protected lock")
    # Do not close or replace the inherited open-file description. The parent
    # Supervisor and this controller hold it throughout all fixed operations.
    if scope.get("admissionDeadline", 0) <= time.time():
        raise RuntimeError("Supervisor scope deadline expired")
    return raw, scope


def observe_path(module, helper, state, save):
    owner = (422, 422, [422], str(helper.HOME))
    worker_account = module.pwd.getpwnam("loopit-worker")
    if (worker_account.pw_uid, worker_account.pw_gid, worker_account.pw_shell) != (420, 420, "/usr/bin/false"):
        raise RuntimeError("Worker account identity differs")
    worker = (420, 420, [420], worker_account.pw_dir)

    def call(argv, identity, timeout=5):
        module.assert_account(); module.tool_check()
        value = module.run(argv, timeout, identity)
        state["commands"].append({"uid": identity[0], "argv": argv, "result": value})
        save()
        return value

    def access(identity, own):
        value = json.loads(module.successful(call(["/usr/bin/python3", str(helper.RUNNER), "--internal-access"], identity)))
        if (value.get("uid"), value.get("gid"), set(value.get("kernelGroups", []))) != (identity[0], identity[1], set(identity[2])) or value.get("public", {}).get("opened") is not True:
            raise RuntimeError("Identity or public access baseline failed")
        for key in ("directory", "canary"):
            if own and value.get(key, {}).get("opened") is not True:
                raise RuntimeError("Owner private access baseline failed")
            if not own and (value.get(key, {}).get("opened") is not False or value.get(key, {}).get("errno") not in (13, 1)):
                raise RuntimeError("Worker private DAC access was not denied")
        return value

    state["ownerBefore"] = access(owner, True)
    helper.empty_devices(module.successful(call(helper.LIST, owner, 60)))
    state["workerAccess"] = access(worker, False)
    help_text = module.successful(call([module.XCRUN, "simctl", "help"], worker, 15))
    if "simctl [--set <path>]" not in help_text:
        raise RuntimeError("Worker tool baseline unavailable")
    result = call(helper.LIST, worker, 15)
    if result["timedOut"] or result["overflow"] or result["exitCode"] in (None, 0) or result["stdout"]:
        raise RuntimeError("Worker private-set observation is successful or uncertain")
    exact = "Provided set path does not exist: " + str(helper.SET)
    if result["stderr"].strip() == exact:
        reason = "fixed-private-path-not-visible"
    elif module.re.search(r"permission|not permitted|not accessible|access denied", result["stderr"], module.re.I):
        reason = "fixed-private-path-permission-denied"
    else:
        raise RuntimeError("Tool failure is not a private-path denial")
    helper.empty_devices(module.successful(call(helper.LIST, owner, 15)))
    state["ownerAfter"] = access(owner, True)
    state["pathObservation"] = {"workerPrivatePathDenied": True, "denialKind": reason,
                                "ownerBeforeAndAfterEmpty": True, "nativeIpcControlProven": False,
                                "defaultSetControlProven": False, "productionBrokerProven": False}
    save()


def observe_live_device(module, helper, state, save):
    """One live-device experiment. No OS operation occurs outside fixed commands.

    A create with a lost/invalid receipt is never retried or guessed from a name.
    Cleanup may reconcile a known returned UDID, but cannot adopt another device.
    A successful negative probe remains a bypass even if the owner restores it.
    """
    owner = (422, 422, [422], str(helper.HOME))
    account = module.pwd.getpwnam("loopit-worker")
    if (account.pw_uid, account.pw_gid, account.pw_shell) != (420, 420, "/usr/bin/false"):
        raise RuntimeError("Worker account identity differs")
    worker = (420, 420, [420], account.pw_dir)
    name = "Loopit UID422 Preflight " + str(uuid.uuid4())
    renamed = name + " BYPASS"
    state.update(deviceName=name, probeRename=renamed, bypasses=[], ownerLiveObservations=[],
                 deviceMutationCommandsAttempted=0, createdUdid=None)
    save()
    cleaning = False

    def persist():
        try:
            save()
        except BaseException as error:
            state["persistenceError"] = str(error)
            if not cleaning:
                raise

    def call(argv, identity, timeout=15, mutation=False):
        module.assert_account(); module.tool_check()
        command = {"uid": identity[0], "argv": list(argv), "phase": "intent", "at": helper.now()}
        state["commands"].append(command)
        if mutation:
            state["deviceMutationCommandsAttempted"] += 1
        persist()  # No normal dispatch before its intent is durable.
        result = module.run(argv, timeout, identity)
        command.update(phase="observed", result=result, observedAt=helper.now())
        persist()
        return result

    def owner_call(action, udid=None, timeout=15):
        return call(module.tool_argv(action, udid, name), owner, timeout, action not in ("list", "bootstatus"))

    def listing(timeout=15):
        return module.devices(module.successful(owner_call("list", timeout=timeout)))

    def access(identity, own):
        value = json.loads(module.successful(call(["/usr/bin/python3", str(helper.RUNNER), "--internal-access"], identity)))
        if (value.get("uid"), value.get("gid"), set(value.get("kernelGroups", []))) != (identity[0], identity[1], set(identity[2])) or value.get("public", {}).get("opened") is not True:
            raise RuntimeError("Identity or public access baseline failed")
        for key in ("directory", "canary"):
            if own and value.get(key, {}).get("opened") is not True:
                raise RuntimeError("Owner private access baseline failed")
            if not own and (value.get(key, {}).get("opened") is not False or value.get(key, {}).get("errno") not in (13, 1)):
                raise RuntimeError("Worker private DAC access was not denied")
        return value

    def bound_row(rows, udid):
        # Only the original and this probe's exact alternate name are admissible.
        if len(rows) != 1 or rows[0].get("name") not in (name, renamed):
            raise RuntimeError("Owned experiment name or exclusive set binding changed")
        return module.owned_device(rows, udid, rows[0]["name"])

    def owner_observe(label):
        row = bound_row(listing(), state["createdUdid"])
        state["ownerLiveObservations"].append({"label": label, "at": helper.now(), "device": row})
        if row["state"] != "Booted":
            raise RuntimeError("Experiment device is no longer observed Booted")
        if row["name"] != name:
            state["bypasses"].append({"kind": "owner-observed-name-change", "label": label, "udid": row["udid"]})
        persist()
        return row

    problem = None
    try:
        if listing(60):
            raise RuntimeError("Fresh private set is not empty")
        state["freshEmptySetObserved"] = True
        state["phase"] = "creating"; persist()
        result = owner_call("create", timeout=30)
        # Capture the received identity before any later query/persistence failure.
        created = module.successful(result).strip()
        if created == FORBIDDEN_EXISTING_UDID:
            raise RuntimeError("Original Goal device is forbidden; do not adopt or clean it up")
        module.validate_udid(created)
        if created == state.get("deletedPriorUdid"):
            raise RuntimeError("Historical experiment UDID cannot be reused")
        state["createdUdid"] = created; persist()
        module.owned_device(listing(), created, name)
        module.successful(owner_call("boot", created, 30))
        module.successful(owner_call("bootstatus", created, 120))
        owner_observe("before-worker-probes")
        state["ownerAccess"] = access(owner, True)
        state["workerAccess"] = access(worker, False)
        help_text = module.successful(call([module.XCRUN, "simctl", "help"], worker, 15))
        if "simctl [--set <path>]" not in help_text:
            raise RuntimeError("Worker tool baseline unavailable")
        state["workerToolBaseline"] = True

        default_result = call([module.XCRUN, "simctl", "list", "devices", "-j"], worker, 30)
        default = json.loads(module.successful(default_result))
        if default_result["stderr"] or not isinstance(default, dict) or not isinstance(default.get("devices"), dict):
            raise RuntimeError("Default-set list baseline is unknown")
        rows = []
        for values in default["devices"].values():
            if not isinstance(values, list) or any(not isinstance(row, dict) or not isinstance(row.get("udid"), str) for row in values):
                raise RuntimeError("Default-set inventory shape is unknown")
            rows.extend(values)
        if any(row["udid"].upper() == created for row in rows):
            state["bypasses"].append({"kind": "default-list-visible", "udid": created})
        state["defaultListTargetAbsent"] = not state["bypasses"]
        owner_observe("after-default-list")

        denied = call([module.XCRUN, "simctl", "rename", created, renamed], worker, 15, True)
        if denied["timedOut"] or denied["overflow"] or denied["exitCode"] is None:
            raise RuntimeError("Default rename outcome unknown; no retry")
        if denied["exitCode"] == 0:
            state["bypasses"].append({"kind": "default-rename-succeeded", "udid": created})
            state["defaultRenameDenied"] = False
        elif denied["stdout"] or denied["stderr"].strip() != "Invalid device: " + created:
            raise RuntimeError("Default rename failed without the exact live-UDID rejection")
        else:
            state["defaultRenameDenied"] = True
        owner_observe("after-default-rename")

        private = call(helper.LIST, worker, 15)
        if private["timedOut"] or private["overflow"] or private["exitCode"] is None:
            raise RuntimeError("Private-path list outcome unknown")
        if private["exitCode"] == 0:
            state["bypasses"].append({"kind": "private-path-list-succeeded", "udid": created})
            state["privatePathDenied"] = False
        elif private["stdout"] or private["stderr"].strip() != "Provided set path does not exist: " + str(helper.SET):
            raise RuntimeError("Private-path list failed without the exact fixed-path rejection")
        else:
            state["privatePathDenied"] = True
        owner_observe("after-private-path-list")
        state["liveCliObservation"] = {
            "targetUdid": created, "defaultListTargetAbsent": state["defaultListTargetAbsent"],
            "defaultRenameDenied": state["defaultRenameDenied"], "privatePathDenied": state["privatePathDenied"],
            "bypassObserved": bool(state["bypasses"]), "completeNativeIpcControlProven": False,
            "productionBrokerProven": False, "autonomousDispatchAllowed": False,
        }
        if state["bypasses"]:
            raise RuntimeError("Live device CLI bypass observed; restoration does not make the experiment pass")
    except BaseException as error:
        problem = str(error)
    finally:
        cleaning = True
        module.WORK_DEADLINE = None
        state["phase"] = "maintenance"; persist()
        try:
            current = listing()
            created = state.get("createdUdid")
            if created:
                row = bound_row(current, created)
                if row["name"] == renamed:
                    module.successful(call([module.XCRUN, "simctl", "--set", str(helper.SET), "rename", created, name], owner, 15, True))
                    module.owned_device(listing(), created, name)
                    state["ownerRestoredProbeRename"] = True
                if row["state"] != "Shutdown":
                    module.successful(owner_call("shutdown", created, 30))
                if module.owned_device(listing(), created, name)["state"] != "Shutdown":
                    raise RuntimeError("Shutdown not observed; delete not admitted")
                module.successful(owner_call("delete", created, 30))
                if listing():
                    raise RuntimeError("Experiment device still present; no repeated delete")
                state["experimentDeviceDeleted"] = True
            elif current:
                raise RuntimeError("Create identity unknown; no adoption or repeated create/delete")
            else:
                state["experimentDeviceDeleted"] = True
        except BaseException as error:
            state["cleanupError"] = str(error)
        state["error"] = problem
        persist()


def execute(args):
    if sys.platform != "darwin" or os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError("Existing macOS root Supervisor required")
    helper = load_helper(True)
    plan_raw, scope = supervisor_admission(helper, args.spec, args.scope, args.generation)
    prior_path = helper.ATTEMPT_ROOT / "result.json"
    prior_raw = helper.read_file(prior_path, protected=True, expected_mode=0o600)
    plan = json.loads(plan_raw)
    mode = plan.get("mode", "empty-private-path-v1")
    if plan != make_plan(helper, prior_raw, mode):
        raise RuntimeError("Reviewed plan or prior bytes changed")
    module = helper.load_original()
    module.APPLY_DEADLINE = time.monotonic() + min(plan["maximumSeconds"], scope["admissionDeadline"] - time.time())
    module.WORK_DEADLINE = module.APPLY_DEADLINE - plan["reservedCleanupSeconds"]
    lock = os.open(helper.CONTROL / "install.lock", os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o600):
            raise RuntimeError("UID422 installation lock changed")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        helper.audit_installed(module)
        observed = helper.observe_stopped(module)
        output = helper.CONTROL / plan["attemptId"]
        output.mkdir(mode=0o700)  # Fixed, exclusive attempt; no implicit retry.
        state = {"schemaVersion": "worker-live-device-bypass-result/1" if mode == LIVE_MODE else "worker-private-path-probe-result/1", "attemptId": plan["attemptId"],
                 "scopeId": args.scope, "generation": args.generation, "controllerDigest": digest(Path(__file__).read_bytes()),
                 "planDigest": digest(plan_raw), "priorReportDigest": PRIOR_DIGEST, "currentOwnerStopObservations": observed,
                 "phase": "maintenance", "status": "pending", "commands": [], "deviceMutations": 0,
                 "modelCalls": 0, "appInstalls": 0, "autonomousDispatchAllowed": False,
                 "workerCleanup": "requires matching outer Supervisor final stop proof", "milestonePassed": False}
        if mode == LIVE_MODE:
            del state["deviceMutations"]  # Count attempted commands, never claim zero live mutations.
            state.update(mode=mode, deletedPriorUdid=plan["deletedPriorUdid"], privateSet=str(helper.SET),
                         defaultSetCliTested=True, completeNativeIpcControlProven=False, startedAt=helper.now())
        save = lambda: module.atomic(output / "result.json", state)
        module.atomic(output / "plan.json", json.loads(plan_raw)); save()
        try:
            if mode == LIVE_MODE:
                observe_live_device(module, helper, state, save)
            else:
                observe_path(module, helper, state, save)
        except BaseException as error:
            state["error"] = str(error)
        finally:
            module.WORK_DEADLINE = None
            try:
                state["ownerStopProof"] = module.stop_device_identity()
            except BaseException as error:
                state["ownerStopError"] = str(error)
            try:
                state["priorReportUnchanged"] = digest(helper.read_file(prior_path, protected=True)) == PRIOR_DIGEST
            except BaseException:
                state["priorReportUnchanged"] = False
            observed_ok = state.get("pathObservation") if mode != LIVE_MODE else state.get("liveCliObservation") and state.get("experimentDeviceDeleted") and not state.get("bypasses")
            ok = observed_ok and state.get("ownerStopProof") and state["priorReportUnchanged"] and not any(state.get(key) for key in ("error", "ownerStopError", "cleanupError", "persistenceError"))
            good_status = "live-cli-observed-worker-stop-pending" if mode == LIVE_MODE else "private-path-observed-worker-stop-pending"
            state["status"] = good_status if ok else "blocked"
            state["finishedAt"] = helper.now(); save()
        return state, output / "result.json"
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-out"); parser.add_argument("--phase", choices=["execute"])
    parser.add_argument("--mode", choices=["empty-private-path-v1", LIVE_MODE])
    parser.add_argument("--spec"); parser.add_argument("--scope"); parser.add_argument("--generation", type=int)
    args = parser.parse_args()
    if args.phase:
        if args.plan_out or args.mode or not args.spec or not args.scope or not args.generation:
            raise RuntimeError("Only the complete Supervisor invocation is accepted")
        result, path = execute(args)
        print(json.dumps({"status": result["status"], "report": str(path), "autonomousDispatchAllowed": False}))
        return 0 if result["status"] in ("private-path-observed-worker-stop-pending", "live-cli-observed-worker-stop-pending") else 2
    if args.spec or args.scope or args.generation:
        raise RuntimeError("Scope arguments require the existing Supervisor")
    helper = load_helper()
    plan = make_plan(helper, helper.read_file(EXPORT), args.mode or "empty-private-path-v1"); raw = helper.encoded(plan)
    if args.plan_out:
        fd = os.open(args.plan_out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(raw); output.flush(); os.fsync(output.fileno())
    print(json.dumps({"status": "plan-only-no-live-actions", "planDigest": digest(raw), "plan": plan}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "blocked", "error": str(error)}), file=sys.stderr)
        sys.exit(2)
