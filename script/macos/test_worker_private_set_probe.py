"""Protocol-only checks; no accounts, administrator, devices or simctl invoked."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


p = load("worker_private_probe", "worker-private-set-probe.py")
h = p.load_helper()
fixtures = load("preflight_fixture", "test_prepare_device_preflight.py")
m = fixtures.m


class Provider:
    def __init__(self, worker_result=None, after_rows=None, wrong_access=None):
        self.calls = []
        self.worker_result = worker_result or fixtures.result(code=1, stderr="Provided set path does not exist: " + str(h.SET) + "\n")
        self.after_rows = after_rows or []
        self.owner_lists = 0
        self.wrong_access = wrong_access

    def __call__(self, argv, timeout=5, identity=None):
        self.calls.append((list(argv), timeout, identity))
        uid, gid, groups, _ = identity
        if argv == ["/usr/bin/python3", str(h.RUNNER), "--internal-access"]:
            v = {"uid": uid, "gid": gid, "kernelGroups": groups, "public": {"opened": True}}
            for k in ["directory", "canary"]:
                v[k] = {"opened": True} if uid == 422 else {"opened": False, "errno": 13}
            if uid == 420 and self.wrong_access: v.update(self.wrong_access)
            return fixtures.result(json.dumps(v))
        if argv == [m.XCRUN, "simctl", "help"]:
            assert uid == 420
            return fixtures.result("usage: simctl [--set <path>] ...")
        assert argv == h.LIST  # No other command is exposed by this experiment.
        if uid == 420:
            return copy.deepcopy(self.worker_result)
        assert identity[:3] == (422, 422, [422])
        self.owner_lists += 1
        return fixtures.result(json.dumps({"devices": {m.RUNTIME: self.after_rows if self.owner_lists > 1 else []}}))


class Tests(unittest.TestCase):
    def scenario(self, provider):
        state = {"commands": []}
        account = SimpleNamespace(pw_uid=420, pw_gid=420, pw_shell="/usr/bin/false", pw_dir="/worker-fixture")
        with patch.object(m, "run", side_effect=provider), patch.object(m, "assert_account"), patch.object(m, "tool_check"), \
             patch.object(m.pwd, "getpwnam", return_value=account):
            p.observe_path(m, h, state, lambda: None)
        return state

    def test_real_observed_error_shape_is_limited_to_path_denial(self):
        provider = Provider(); state = self.scenario(provider)
        result = state["pathObservation"]
        self.assertEqual(result["denialKind"], "fixed-private-path-not-visible")
        self.assertTrue(result["workerPrivatePathDenied"])
        for key in ["nativeIpcControlProven", "defaultSetControlProven", "productionBrokerProven"]:
            self.assertFalse(result[key])
        self.assertEqual([(c[2][0], c[1]) for c in provider.calls if c[0] == h.LIST], [(422, 60), (420, 15), (422, 15)])
        self.assertTrue(all(c[2][:3] == (420, 420, [420]) for c in provider.calls if c[2][0] == 420))

    def test_permission_error_with_owner_baselines_is_also_only_path_denial(self):
        state = self.scenario(Provider(fixtures.result(code=1, stderr="Permission denied")))
        self.assertEqual(state["pathObservation"]["denialKind"], "fixed-private-path-permission-denied")

    def test_timeout_tool_unavailability_and_wrong_path_are_not_denials(self):
        for result in [fixtures.result(code=-9, timeout=True), fixtures.result(code=1, stderr="CoreSimulator unavailable"),
                       fixtures.result(code=1, stderr="Provided set path does not exist: /other/path"),
                       fixtures.result(code=1, stderr="Permission denied", stdout="partial inventory")]:
            with self.assertRaises(RuntimeError): self.scenario(Provider(result))

    def test_worker_success_is_a_failed_negative_even_when_set_empty(self):
        result = fixtures.result(json.dumps({"devices": {}}))
        with self.assertRaisesRegex(RuntimeError, "successful or uncertain"):
            self.scenario(Provider(result))

    def test_owner_after_must_still_confirm_real_empty_path(self):
        with self.assertRaisesRegex(RuntimeError, "not observed empty"):
            self.scenario(Provider(after_rows=[{"udid": fixtures.NEW}]))

    def test_wrong_identity_public_failure_or_dac_success_blocks_before_list(self):
        for change in [{"uid": 501}, {"kernelGroups": [20]}, {"public": {"opened": False, "errno": 13}},
                       {"directory": {"opened": True}}, {"canary": {"opened": False, "errno": 2}}]:
            provider = Provider(wrong_access=change)
            with self.assertRaises(RuntimeError): self.scenario(provider)
            self.assertFalse(any(c[0] == h.LIST and c[2][0] == 420 for c in provider.calls))

    def test_account_mismatch_has_no_command(self):
        with patch.object(m.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=501, pw_gid=420, pw_shell="/usr/bin/false")), \
             patch.object(m, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "identity differs"):
                p.observe_path(m, h, {"commands": []}, lambda: None)
            command.assert_not_called()

    def test_failed_persistence_prevents_later_worker_command(self):
        provider = Provider()
        account = SimpleNamespace(pw_uid=420, pw_gid=420, pw_shell="/usr/bin/false", pw_dir="/worker-fixture")
        with patch.object(m, "run", side_effect=provider), patch.object(m, "assert_account"), patch.object(m, "tool_check"), \
             patch.object(m.pwd, "getpwnam", return_value=account):
            with self.assertRaisesRegex(RuntimeError, "disk fault"):
                p.observe_path(m, h, {"commands": []}, lambda: (_ for _ in ()).throw(RuntimeError("disk fault")))
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0][2][0], 422)

    def test_nonroot_execute_never_loads_privileged_helpers(self):
        with patch.object(p.os, "getuid", return_value=501), patch.object(p, "load_helper") as helper:
            with self.assertRaisesRegex(RuntimeError, "root Supervisor"):
                p.execute(SimpleNamespace())
            helper.assert_not_called()

    def test_prior_exact_bytes_cannot_be_changed_to_a_passed_report(self):
        raw = b'{"status":"passed"}'
        with self.assertRaisesRegex(RuntimeError, "Exact reviewed"):
            p.validate_prior(raw)
        with patch.object(p, "PRIOR_DIGEST", p.digest(raw)):
            with self.assertRaisesRegex(RuntimeError, "reviewed partial"):
                p.validate_prior(raw)

    def test_supervisor_admission_binds_scope_plan_and_inherited_lock_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); lock = root / "ownership.lock"; lock.touch(mode=0o600)
            with lock.open("rb") as owned:
                st = os.fstat(owned.fileno())
                # Actual open-file identity, with ownership supplied by the test
                # instead of creating root-owned files on the test host.
                protected = SimpleNamespace(st_dev=st.st_dev, st_ino=st.st_ino, st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1)
                plan_raw = b"{}"; self_raw = b"fixed controller fixture"
                base = {"scopeId": "scope-fixture", "generation": 9, "phase": "running", "workerUid": 420,
                        "workerGid": 420, "signerUid": 421, "controllerDigest": p.digest(self_raw),
                        "specDigest": p.digest(plan_raw), "admissionDeadline": time.time() + 60}
                def run(value, env_changes=None):
                    helper = SimpleNamespace(read_file=lambda path, **kw: plan_raw if path == root / "plan.json" else
                                             self_raw if path == Path(p.__file__) else json.dumps(value).encode())
                    env = {"LOOPIT_SCOPE_ID": "scope-fixture", "LOOPIT_GENERATION": "9", "LOOPIT_SUPERVISOR_LOCK_FD": str(owned.fileno())}
                    env.update(env_changes or {})
                    with patch.object(p, "STATE", root), patch.object(p.os, "fstat", return_value=protected), patch.dict(os.environ, env, clear=True):
                        return p.supervisor_admission(helper, str(root / "plan.json"), "scope-fixture", 9)
                self.assertEqual(run(base)[1]["generation"], 9)
                for change in [{"phase": "stopped"}, {"generation": 8}, {"workerUid": 501},
                               {"controllerDigest": "wrong"}, {"specDigest": "wrong"}, {"admissionDeadline": 0}]:
                    with self.assertRaises(RuntimeError): run({**base, **change})
                for change in [{"LOOPIT_SCOPE_ID": "other"}, {"LOOPIT_SUPERVISOR_LOCK_FD": ""}]:
                    with self.assertRaises(RuntimeError): run(base, change)


if __name__ == "__main__":
    unittest.main()
