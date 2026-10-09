import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


supervisor, launcher = module("worker-supervisor"), module("worker-exec")


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.identities = {
            "loopit-worker": SimpleNamespace(pw_uid=420, pw_gid=420, pw_shell="/usr/bin/false"),
            "loopit-signer": SimpleNamespace(pw_uid=421, pw_gid=420, pw_shell="/usr/bin/false"),
        }
        patcher = patch.object(supervisor.pwd, "getpwnam", side_effect=lambda name: self.identities[name])
        patcher.start()
        self.addCleanup(patcher.stop)

    def scope(self):
        return {"scopeId": "scope-test", "generation": 2, "workerUid": 420, "workerGid": 420,
                "signerUid": 421, "signerGid": 420, "phase": "running", "admissionDeadline": time.time() + 60}

    def test_reaper_never_signals_when_not_root(self):
        with patch.object(supervisor.os, "getuid", return_value=501), patch.object(supervisor.os, "kill") as kill:
            with self.assertRaises(RuntimeError):
                supervisor.reap_child(9, pids=[700])
            kill.assert_not_called()

    def test_reaper_checks_all_identities_after_drop(self):
        with patch.object(supervisor.os, "getuid", side_effect=[0, 420]), \
             patch.object(supervisor.os, "geteuid", side_effect=[0, 0]), \
             patch.object(supervisor.os, "setgroups"), patch.object(supervisor.os, "setgid"), \
             patch.object(supervisor.os, "setuid"), patch.object(supervisor.os, "kill") as kill:
            with self.assertRaises(RuntimeError):
                supervisor.reap_child(9, pids=[700])
            kill.assert_not_called()

    def test_root_and_operator_are_not_valid_launcher_targets(self):
        for uid, gid in [(0, 0), (501, 20), (420, 0)]:
            with patch.object(launcher.os, "setuid") as change:
                with self.assertRaises(RuntimeError):
                    launcher.drop_identity(uid, gid)
                change.assert_not_called()

    def test_atomic_record_keeps_previous_bytes_on_sync_failure(self):
        with tempfile.TemporaryDirectory(prefix="loopit-supervisor-test-") as directory:
            target = Path(directory) / "record.json"
            supervisor.durable_json(target, {"generation": 1})
            with patch.object(supervisor.os, "fsync", side_effect=OSError("injected disk failure")):
                with self.assertRaises(OSError):
                    supervisor.durable_json(target, {"generation": 2})
            self.assertEqual(json.loads(target.read_text()), {"generation": 1})

    def test_recover_cannot_clear_maintenance_even_with_empty_service_uids(self):
        with tempfile.TemporaryDirectory(prefix="loopit-maintenance-recovery-") as directory:
            root = Path(directory)
            active = {**self.scope(), "phase": "maintenance", "workerUid": None, "signerUid": None}
            before = json.dumps(active).encode()
            (root / "active.json").write_bytes(before)
            with patch.object(supervisor, "STATE", root), \
                 patch.object(supervisor, "require_root", return_value=self.identities["loopit-worker"]), \
                 patch.object(supervisor.sys, "argv", ["worker-supervisor.py", "recover"]), \
                 patch.object(supervisor, "processes", return_value=[]) as inventory, \
                 patch.object(supervisor, "durable_json") as persist, \
                 patch.object(supervisor, "close_admission_and_stop") as stop:
                with self.assertRaisesRegex(RuntimeError, "Maintenance quarantine.*ordinary recovery is forbidden"):
                    supervisor.main()
                self.assertEqual((root / "active.json").read_bytes(), before)
                inventory.assert_not_called()
                persist.assert_not_called()
                stop.assert_not_called()

    def test_stop_proof_requires_three_empty_observations(self):
        scope = self.scope()
        with patch.object(supervisor, "processes", return_value=[]) as inventory, \
             patch.object(supervisor, "root_service_account", side_effect=lambda name, expected=None: supervisor.service_identity(name, expected)), \
             patch.object(supervisor, "user_domain_present", return_value=False), \
             patch.object(supervisor.time, "sleep"):
            proof = supervisor.stop_uid(scope, "test only")
            self.assertEqual(inventory.call_count, 3)
            self.assertTrue(proof["noLiveWorkerProcesses"])
            self.assertTrue(proof["userDomainAbsent"])
            self.assertFalse(proof["externalActionsVerified"])

    def domain_output(self, entries):
        return "system = {\n\tsubdomains = {\n" + "".join("\t\t" + entry + "\n" for entry in entries) + "\t}\n}\n"

    def test_domain_inventory_only_reads_system_and_matches_exact_child(self):
        with patch.object(supervisor.os, "getuid", return_value=0), patch.object(supervisor.os, "geteuid", return_value=0), \
             patch.object(supervisor.sys, "platform", "darwin"):
            for entries, present in [(["user/420", "user/501", "pid/9"], True), (["user/4200", "gui/420", "user/501"], False), ([], False)]:
                result = SimpleNamespace(returncode=0, stdout=self.domain_output(entries), stderr="")
                with patch.object(supervisor.subprocess, "run", return_value=result) as call:
                    self.assertEqual(supervisor.user_domain_present("loopit-worker", (420, 420)), present)
                    self.assertEqual(call.call_args.args[0], ["/bin/launchctl", "print", "system"])
                    self.assertLessEqual(call.call_args.kwargs["timeout"], 2)
            malformed = ["", "system = {\n}", self.domain_output(["user/420?"]),
                         self.domain_output(["user/420", "user/420"]), self.domain_output(["user/420"]).replace("\n\t}", ""),
                         self.domain_output(["user/501"]) + self.domain_output(["user/420"])]
            for output in malformed:
                with patch.object(supervisor.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=output, stderr="")):
                    with self.assertRaises(RuntimeError):
                        supervisor.user_domain_present("loopit-worker", (420, 420))
            for result in [SimpleNamespace(returncode=1, stdout=self.domain_output([]), stderr=""),
                           SimpleNamespace(returncode=0, stdout=self.domain_output([]), stderr="unrecognized warning")]:
                with patch.object(supervisor.subprocess, "run", return_value=result):
                    with self.assertRaises(RuntimeError):
                        supervisor.user_domain_present("loopit-worker", (420, 420))

    def test_domain_control_refuses_unregistered_identity_and_nonroot_before_any_command(self):
        for name, expected in [("root", (0, 0)), ("loopit-worker", (501, 20)), ("loopit-signer", (421, 421))]:
            with patch.object(supervisor.subprocess, "run") as call:
                with self.assertRaises(RuntimeError):
                    supervisor.bootout_user_domain(name, expected, time.monotonic() + 3)
                call.assert_not_called()
        with patch.object(supervisor.os, "getuid", return_value=501), patch.object(supervisor.subprocess, "run") as call:
            with self.assertRaises(RuntimeError):
                supervisor.stop_uid(self.scope(), "ordinary user forbidden")
            call.assert_not_called()

    def test_bootout_is_fixed_to_registered_domain_and_unknown_errors_or_timeout_block(self):
        with patch.object(supervisor.os, "getuid", return_value=0), patch.object(supervisor.os, "geteuid", return_value=0), \
             patch.object(supervisor.sys, "platform", "darwin"):
            with patch.object(supervisor.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as call:
                receipt = supervisor.bootout_user_domain("loopit-signer", (421, 420), time.monotonic() + 3)
                self.assertEqual(call.call_args.args[0], ["/bin/launchctl", "bootout", "user/421"])
                self.assertEqual(receipt["exitCode"], 0)
            with patch.object(supervisor.subprocess, "run", return_value=SimpleNamespace(returncode=3)):
                with self.assertRaisesRegex(RuntimeError, "bootout failed"):
                    supervisor.bootout_user_domain("loopit-worker", (420, 420), time.monotonic() + 3)
            with patch.object(supervisor.subprocess, "run", side_effect=subprocess.TimeoutExpired("launchctl", 2)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    supervisor.user_domain_present("loopit-worker", (420, 420), time.monotonic() + 3)
            with patch.object(supervisor.subprocess, "run") as call:
                with self.assertRaisesRegex(RuntimeError, "deadline"):
                    supervisor.bootout_user_domain("loopit-worker", (420, 420), time.monotonic() - 1)
                call.assert_not_called()

    def test_stop_boots_out_domain_before_inventory_and_reappearance_forbids_proof(self):
        with patch.object(supervisor, "root_service_account", side_effect=lambda name, expected=None: supervisor.service_identity(name, expected)), \
             patch.object(supervisor.time, "sleep"), patch.object(supervisor.os, "fork", side_effect=AssertionError("no reaper")):
            order = []
            def bootout(*args):
                order.append("bootout")
                return {"domain": "user/420", "exitCode": 0}
            def inventory(uid):
                order.append("inventory")
                return []
            with patch.object(supervisor, "user_domain_present", side_effect=[True, True, True, False, False, False, False]) as domain, \
                 patch.object(supervisor, "bootout_user_domain", side_effect=bootout), \
                 patch.object(supervisor, "processes", side_effect=inventory):
                proof = supervisor.stop_uid(self.scope(), "domain present")
                self.assertEqual(order, ["bootout", "inventory", "inventory", "inventory"])
                self.assertEqual(domain.call_count, 7)
                self.assertTrue(proof["userDomainAbsent"])
                self.assertIn("absenceConfirmedAt", proof["domainBootouts"][0])
                self.assertTrue(all(not row["userDomainPresent"] for row in proof["observations"]))
            with patch.object(supervisor, "user_domain_present", side_effect=[False, False, False, True]), \
                 patch.object(supervisor, "processes", return_value=[]), patch.object(supervisor, "bootout_user_domain") as boot:
                with self.assertRaisesRegex(RuntimeError, "reappeared; stop proof forbidden"):
                    supervisor.stop_uid(self.scope(), "domain reappeared")
                boot.assert_not_called()
            with patch.object(supervisor, "user_domain_present", return_value=True), \
                 patch.object(supervisor, "bootout_user_domain", return_value={"domain": "user/420", "exitCode": 0}), \
                 patch.object(supervisor.time, "monotonic", side_effect=[0, 10]), \
                 patch.object(supervisor, "processes") as inventory:
                with self.assertRaisesRegex(RuntimeError, "did not disappear.*deadline"):
                    supervisor.stop_uid(self.scope(), "domain never disappears")
                inventory.assert_not_called()

    def test_new_run_rejects_existing_service_domain_before_generation_or_spawn(self):
        for present in ([True], [False, True]):
            with tempfile.TemporaryDirectory(prefix="loopit-domain-admission-") as directory:
                with patch.object(supervisor, "STATE", Path(directory)), \
                     patch.object(supervisor, "require_root", return_value=self.identities["loopit-worker"]), \
                     patch.object(supervisor.sys, "argv", ["worker-supervisor.py", "run"]), \
                     patch.object(supervisor, "processes", return_value=[]), \
                     patch.object(supervisor, "user_domain_present", side_effect=present), \
                     patch.object(supervisor, "durable_json") as persist, patch.object(supervisor.subprocess, "Popen") as spawn:
                    with self.assertRaisesRegex(RuntimeError, "user domain already exists"):
                        supervisor.main()
                    persist.assert_not_called()
                    spawn.assert_not_called()


    def test_identity_drop_uses_kernel_groups_not_directory_membership(self):
        for groups in ([420], [420, 0], [420, 80], []):
            with patch.object(launcher.os, "getuid", side_effect=[0, 420]), \
                 patch.object(launcher.os, "geteuid", side_effect=[0, 420]), \
                 patch.object(launcher.os, "getgid", return_value=420), patch.object(launcher.os, "getegid", return_value=420), \
                 patch.object(launcher.os, "setgroups"), patch.object(launcher.os, "setgid"), patch.object(launcher.os, "setuid"), \
                 patch.object(launcher, "kernel_groups", return_value=groups) as kernel, \
                 patch.object(launcher.os, "getgroups", return_value=[420, 12, 61, 701, 100]) as directory:
                if groups == [420]:
                    launcher.drop_identity(420, 420)
                else:
                    with self.assertRaisesRegex(RuntimeError, "supplementary groups"):
                        launcher.drop_identity(420, 420)
                kernel.assert_called_once()
                directory.assert_not_called()

    def test_reaper_checks_kernel_groups_before_signaling_explicit_pids(self):
        for groups in ([420], [420, 0], [420, 80]):
            with patch.object(supervisor.os, "getuid", side_effect=[0, 420]), \
                 patch.object(supervisor.os, "geteuid", side_effect=[0, 420]), \
                 patch.object(supervisor.os, "getgid", return_value=420), patch.object(supervisor.os, "getegid", return_value=420), \
                 patch.object(supervisor.os, "setgroups"), patch.object(supervisor.os, "setgid"), patch.object(supervisor.os, "setuid"), \
                 patch.object(supervisor, "kernel_groups", return_value=groups), patch.object(supervisor.os, "kill") as kill:
                if groups == [420]:
                    supervisor.reap_child(9, "loopit-worker", (420, 420), [700])
                    kill.assert_called_once_with(700, 9)
                else:
                    with self.assertRaisesRegex(RuntimeError, "identity did not drop"):
                        supervisor.reap_child(9, "loopit-worker", (420, 420), [700])
                    kill.assert_not_called()

    def test_reaper_rejects_broadcast_self_and_invalid_pid_lists_before_drop(self):
        with patch.object(supervisor.os, "getuid", return_value=0), patch.object(supervisor.os, "geteuid", return_value=0), \
             patch.object(supervisor.os, "setuid") as drop, patch.object(supervisor.os, "kill") as kill:
            for pids in (None, [], [-1], [0], [1], [True], ["700"], [700, os.getpid()]):
                with self.assertRaisesRegex(RuntimeError, "explicit non-self process IDs"):
                    supervisor.reap_child(9, "loopit-worker", (420, 420), pids)
            drop.assert_not_called()
            kill.assert_not_called()

    def test_reaper_handles_exited_pid_but_preserves_permission_failures(self):
        for error in (ProcessLookupError(3, "exited"), PermissionError(1, "denied")):
            with patch.object(supervisor.os, "getuid", side_effect=[0, 420]), \
                 patch.object(supervisor.os, "geteuid", side_effect=[0, 420]), \
                 patch.object(supervisor.os, "getgid", return_value=420), patch.object(supervisor.os, "getegid", return_value=420), \
                 patch.object(supervisor.os, "setgroups"), patch.object(supervisor.os, "setgid"), patch.object(supervisor.os, "setuid"), \
                 patch.object(supervisor, "kernel_groups", return_value=[420]), patch.object(supervisor.os, "kill", side_effect=error) as kill:
                if isinstance(error, ProcessLookupError):
                    supervisor.reap_child(9, "loopit-worker", (420, 420), [700])
                else:
                    with self.assertRaises(PermissionError):
                        supervisor.reap_child(9, "loopit-worker", (420, 420), [700])
                kill.assert_called_once_with(700, 9)

    def test_actual_nonprivileged_reaper_child_reports_error_and_signal_without_accepting_failure(self):
        # Only ordinary-UID child processes created by this test. Never enter
        # a service account or signal another process/broadcast target.
        with patch.object(supervisor, "reap_child", return_value=None):
            receipt = supervisor.run_reaper(9, [700], "loopit-worker", (420, 420), time.monotonic() + 2)
            self.assertEqual(receipt["exitCode"], 0)
            self.assertIsNone(receipt["signal"])
        with patch.object(supervisor, "reap_child", side_effect=PermissionError(1, "must not appear in diagnostics")):
            with self.assertRaisesRegex(RuntimeError, '"exitCode": 2') as failure:
                supervisor.run_reaper(9, [700], "loopit-worker", (420, 420), time.monotonic() + 2)
            self.assertIn('"errorType": "PermissionError"', str(failure.exception))
            self.assertIn('"errno": 1', str(failure.exception))
            self.assertNotIn("must not appear", str(failure.exception))
        with patch.object(supervisor, "reap_child", side_effect=lambda *args: os.kill(os.getpid(), signal.SIGKILL)):
            with self.assertRaisesRegex(RuntimeError, '"signal": 9') as failure:
                supervisor.run_reaper(9, [700], "loopit-worker", (420, 420), time.monotonic() + 2)
            self.assertIn('"exitCode": null', str(failure.exception))

    def test_stop_reaps_only_each_fresh_live_inventory_and_records_exit_status(self):
        inventories = [[{"pid": 700, "state": "S"}, {"pid": 701, "state": "Z"}], [{"pid": 702, "state": "S"}], [], [], []]
        receipt = {"waitStatus": 0, "exitCode": 0, "signal": None, "timedOut": False}
        with patch.object(supervisor, "root_service_account", side_effect=lambda name, expected=None: supervisor.service_identity(name, expected)), \
             patch.object(supervisor, "user_domain_present", return_value=False), \
             patch.object(supervisor, "processes", side_effect=inventories), patch.object(supervisor.time, "sleep"), \
             patch.object(supervisor, "run_reaper", return_value=receipt) as reaper:
            proof = supervisor.stop_uid(self.scope(), "fresh inventory test")
            self.assertEqual([call.args[1] for call in reaper.call_args_list], [[700], [702]])
            self.assertEqual([call.args[0] for call in reaper.call_args_list], [signal.SIGTERM, signal.SIGKILL])
            self.assertEqual([row["reaper"]["exitCode"] for row in proof["signals"]], [0, 0])

    def test_kernel_group_ffi_rejects_invalid_counts_and_read_failures(self):
        class Function:
            def __init__(self, values): self.values = list(values)
            def __call__(self, size, buffer): return self.values.pop(0)
        for target in (launcher, supervisor):
            for responses in ([-1], [1025], [1, -1], [1, 2]):
                with patch.object(target.ctypes, "CDLL", return_value=SimpleNamespace(getgroups=Function(responses))):
                    with self.assertRaisesRegex(RuntimeError, "Kernel group"):
                        target.kernel_groups()

    def test_changed_signer_uid_or_gid_blocks_before_inventory_or_signals(self):
        for key, value in [("signerUid", 422), ("signerGid", 421), ("workerGid", 421)]:
            scope = self.scope()
            scope[key] = value
            with patch.object(supervisor, "processes") as inventory, patch.object(supervisor.os, "fork") as fork:
                with self.assertRaisesRegex(RuntimeError, "UID/GID changed"):
                    supervisor.scope_identities(scope)
                inventory.assert_not_called()
                fork.assert_not_called()
        with patch.object(supervisor.os, "kill") as kill, patch.object(supervisor.os, "setuid") as change:
            with self.assertRaisesRegex(RuntimeError, "UID/GID changed"):
                supervisor.reap_child(9, "loopit-signer", (422, 420))
            change.assert_not_called()
            kill.assert_not_called()

    def test_launch_binding_rejects_old_scope_phase_identity_and_expiry(self):
        scope = self.scope()
        launcher.validate_admission(scope, "scope-test", 2, 420, 420)
        for changed, scope_id, generation, uid, gid in [
            (scope, "old-scope", 2, 420, 420), (scope, "scope-test", 1, 420, 420),
            ({**scope, "phase": "stopping"}, "scope-test", 2, 420, 420),
            ({**scope, "phase": "stopped"}, "scope-test", 2, 420, 420),
            ({**scope, "phase": "finalizing"}, "scope-test", 2, 420, 420),
            (scope, "scope-test", 2, 421, 420),
            ({**scope, "admissionDeadline": time.time() - 1}, "scope-test", 2, 420, 420),
        ]:
            with self.assertRaises(RuntimeError):
                launcher.validate_admission(changed, scope_id, generation, uid, gid)
        launcher.validate_admission({**scope, "phase": "finalizing"}, "scope-test", 2, 421, 420)

    def test_actual_high_inherited_descriptor_above_soft_limit_is_closed(self):
        # Ordinary UID subprocess only; no identity drop or privileged launch.
        source = str(Path(__file__).with_name("worker-exec.py"))
        code = """import importlib.util,fcntl,os,resource
spec=importlib.util.spec_from_file_location('launcher',SOURCE);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
fd=os.open('/dev/null',os.O_RDONLY); high=fcntl.fcntl(fd,fcntl.F_DUPFD,64)
soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE);resource.setrlimit(resource.RLIMIT_NOFILE,(32,hard))
m.close_inherited_descriptors()
try: os.fstat(high)
except OSError: print('closed')
else: raise RuntimeError('high inherited descriptor leaked')
""".replace("SOURCE", repr(source))
        result = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "closed")

    def test_exclusive_stop_gate_waits_for_delayed_drop_before_any_inventory(self):
        # Real cross-process flock timing, with ONLY the UID drop and inventory
        # mocked. No Worker account is entered and no signal/fork is permitted.
        source = str(Path(__file__).with_name("worker-exec.py"))
        with tempfile.TemporaryDirectory(prefix="loopit-launch-gate-") as directory:
            root = Path(directory)
            (root / "launch.lock").touch(mode=0o600)
            (root / "active.json").write_text(json.dumps(self.scope()))
            code = """import importlib.util,json,os,time,pathlib
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('launcher',SOURCE);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(ROOT)
m.pwd.getpwnam=lambda name:SimpleNamespace(pw_uid=420 if name=='loopit-worker' else 421,pw_gid=420,pw_shell='/usr/bin/false')
m.open_launch_gate=lambda:os.open(m.STATE/'launch.lock',os.O_RDWR)
def delayed(uid,gid):
 (m.STATE/'entered').write_text('shared gate held')
 time.sleep(.6)
 (m.STATE/'visible').write_text('mock dedicated UID reached')
m.drop_identity=delayed
m.admitted_drop(420,420,'scope-test',2)
""".replace("SOURCE", repr(source)).replace("ROOT", repr(directory))
            child = subprocess.Popen([sys.executable, "-B", "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 3
                while not (root / "entered").exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue((root / "entered").exists())
                observations = []
                def inventory(uid):
                    observations.append((root / "visible").exists())
                    return []
                began = time.monotonic()
                with patch.object(supervisor, "STATE", root), patch.object(supervisor, "processes", side_effect=inventory), \
                     patch.object(supervisor, "root_service_account", side_effect=lambda name, expected=None: supervisor.service_identity(name, expected)), \
                     patch.object(supervisor, "user_domain_present", return_value=False), \
                     patch.object(supervisor.os, "fork", side_effect=AssertionError("no real reaper allowed")):
                    proof, signer = supervisor.close_admission_and_stop(self.scope(), "fixture gate test", True)
                self.assertGreaterEqual(time.monotonic() - began, .5)
                self.assertTrue(observations and all(observations))
                self.assertTrue(proof["noLiveWorkerProcesses"])
                self.assertTrue(signer["noLiveWorkerProcesses"])
                closed = json.loads((root / "active.json").read_text())
                self.assertEqual(closed["phase"], "stopped")
                with self.assertRaises(RuntimeError):
                    launcher.validate_admission(closed, "scope-test", 2, 420, 420)
                # An old root launcher waking after the next scope is admitted
                # still fails, even though that new scope is running.
                renewed = {**self.scope(), "scopeId": "new-scope", "generation": 3}
                with self.assertRaises(RuntimeError):
                    launcher.validate_admission(renewed, "scope-test", 2, 420, 420)
                self.assertEqual(child.wait(timeout=3), 0)
            finally:
                if child.poll() is None:
                    child.kill(); child.wait(timeout=3)
                child.stdout.close(); child.stderr.close()

    def test_failed_admission_revocation_never_scans_or_claims_stopped(self):
        with tempfile.TemporaryDirectory(prefix="loopit-gate-write-failure-") as directory:
            root = Path(directory)
            (root / "launch.lock").touch(mode=0o600)
            (root / "active.json").write_text(json.dumps(self.scope()))
            with patch.object(supervisor, "STATE", root), patch.object(supervisor, "durable_json", side_effect=OSError("disk full")), \
                 patch.object(supervisor, "processes") as inventory:
                with self.assertRaises(OSError):
                    supervisor.close_admission_and_stop(self.scope(), "fixture failed revoke", True)
                inventory.assert_not_called()
                self.assertFalse((root / "scope-test.stop.json").exists())
                self.assertEqual(json.loads((root / "active.json").read_text())["phase"], "running")

    def test_inherited_flock_blocks_admission_after_parent_is_killed(self):
        # Real separate processes, ordinary UID. No Worker process or signal-all.
        with tempfile.TemporaryDirectory(prefix="loopit-flock-test-") as directory:
            root = Path(directory)
            child = root / "child.py"
            child.write_text("import os,time,pathlib\npathlib.Path('ready').write_text(str(os.getpid()))\ntime.sleep(20)\n")
            parent = root / "parent.py"
            parent.write_text("import os,fcntl,subprocess,sys,time\nfd=os.open('lock',os.O_CREAT|os.O_RDWR,0o600)\nfcntl.flock(fd,fcntl.LOCK_EX)\np=subprocess.Popen([sys.executable,'child.py'],pass_fds=(fd,))\nprint(p.pid,flush=True)\ntime.sleep(20)\n")
            owner = subprocess.Popen([sys.executable, str(parent)], cwd=root, stdout=subprocess.PIPE, text=True)
            pid = int(owner.stdout.readline())
            try:
                deadline = time.monotonic() + 3
                while not (root / "ready").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((root / "ready").exists())
                owner.kill(); owner.wait(timeout=3)
                probe = subprocess.run([sys.executable, "-c", "import os,fcntl;fd=os.open('lock',os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)"], cwd=root, capture_output=True)
                self.assertNotEqual(probe.returncode, 0)
                self.assertIn(b"BlockingIOError", probe.stderr)
            finally:
                if owner.poll() is None:
                    owner.kill(); owner.wait(timeout=3)
                owner.stdout.close()
                os.kill(pid, 9)  # Only the PID just created by this test, same UID.


if __name__ == "__main__":
    unittest.main()
