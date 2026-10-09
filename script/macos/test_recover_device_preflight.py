"""No privileged/system/device calls: exercise recovery against pinned probe code.

The existing finite fake provider stands in for OS effects. These are protocol
regressions, not proof of UID422 or CoreSimulator behavior on this machine.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load("recovery_preflight", "recover-device-preflight.py")
fixture = load("original_preflight_fakes", "test_prepare_device_preflight.py")
m = fixture.m


def observations():
    return [{"processes": [], "userDomainPresent": False, "at": "fixture"} for _ in range(3)]


def prior_report():
    return {"schemaVersion": "device-private-set-preflight-result/1", "status": "blocked", "phase": "maintenance",
            "planDigest": r.OLD_PLAN_DIGEST, "uid": 422, "gid": 422, "privateSet": str(r.SET),
            "deviceName": fixture.NAME, "modelCalls": 0, "appInstalls": 0, "experimentDeviceDeleted": True,
            "commands": [{"uid": 422, "argv": r.LIST, "result": fixture.result(code=-9, timeout=True)},
                         {"uid": 422, "argv": r.LIST, "result": fixture.result(json.dumps({"devices": {m.RUNTIME: []}}))}],
            "stopProof": {"uid": 422, "userDomain": "user/422", "noLiveProcesses": True,
                          "userDomainAbsent": True, "observations": observations()}}


class Tests(unittest.TestCase):
    def tearDown(self):
        m.APPLY_DEADLINE = m.WORK_DEADLINE = None

    def validate_fixture(self, value):
        raw = r.encoded(value)
        with patch.object(r, "OLD_REPORT_DIGEST", r.digest(raw)):
            return r.validate_previous(raw)

    def test_prior_bytes_and_reviewed_failure_shape_are_both_required(self):
        value = prior_report()
        self.assertEqual(self.validate_fixture(value)["status"], "blocked")
        raw = r.encoded(value)
        with patch.object(r, "OLD_REPORT_DIGEST", r.digest(raw)):
            with self.assertRaisesRegex(RuntimeError, "pin required"):
                r.validate_previous(raw + b" ")
        for change in [lambda v: v.update(createdUdid=fixture.NEW),
                       lambda v: v.update(cleanupError="unknown"),
                       lambda v: v.update(planDigest="sha256:" + "0" * 64),
                       lambda v: v["commands"][0]["result"].update(exitCode=0),
                       lambda v: v["commands"][1].update(uid=501),
                       lambda v: v["stopProof"]["observations"].pop(),
                       lambda v: v["stopProof"].update(userDomain="user/420")]:
            altered = copy.deepcopy(value); change(altered)
            with self.assertRaises(RuntimeError): self.validate_fixture(altered)

    def test_empty_set_requires_recognized_complete_empty_inventory(self):
        for value in [{"devices": {}}, {"devices": {m.RUNTIME: []}}]:
            r.empty_devices(json.dumps(value))
        for value in [[], {}, {"devices": []}, {"devices": {m.RUNTIME: {}}}, {"devices": {m.RUNTIME: [{"udid": fixture.NEW}]}}]:
            with self.assertRaises(RuntimeError): r.empty_devices(json.dumps(value))

    def test_live_or_unknown_current_stop_prevents_admission_without_reaping(self):
        module = SimpleNamespace(processes=lambda: [], domain_present=lambda: False)
        with patch.object(r.time, "sleep"):
            self.assertEqual(len(r.observe_stopped(module)), 3)
            for rows, domain in [([{"pid": 123, "state": "S"}], False), ([], True)]:
                with patch.object(module, "processes", return_value=rows), patch.object(module, "domain_present", return_value=domain):
                    with self.assertRaisesRegex(RuntimeError, "not stopped"): r.observe_stopped(module)
            with patch.object(module, "domain_present", side_effect=RuntimeError("unknown system format")):
                with self.assertRaisesRegex(RuntimeError, "unknown"): r.observe_stopped(module)

    def scenario(self, provider=None, observer_rows=None, save_hook=None):
        provider = provider or fixture.FixedProvider()
        state = {"deviceName": fixture.NAME, "commands": [], "autonomousDispatchAllowed": False,
                 "currentStopObservations": observations() if observer_rows is None else observer_rows}
        calls, persisted = [], []
        def command(argv, timeout=5, identity=None):
            calls.append((list(argv), timeout, identity))
            return provider(argv, timeout, identity)
        def save():
            if save_hook: save_hook(state)
            persisted.append(copy.deepcopy(state))
        def account(name):
            return SimpleNamespace(pw_uid=501 if name == "buyi" else 420, pw_gid=20 if name == "buyi" else 420, pw_dir="/nonsecret-fixture")
        with patch.object(m, "assert_account"), patch.object(m, "tool_check"), patch.object(m, "run", side_effect=command) as original, \
             patch.object(m.pwd, "getpwnam", side_effect=account), patch.object(m.os, "getgrouplist", return_value=[20, 80]), \
             patch.object(m, "stop_device_identity", return_value={"noLiveProcesses": True, "userDomainAbsent": True}):
            r.run_attempt(m, state, save)
            self.assertIs(m.run, original)
        return state, calls, persisted

    def test_exact_original_probe_gets_only_first_owner_list_60_seconds(self):
        self.assertEqual(r.digest(Path(m.__file__).read_bytes()), r.RUNNER_DIGEST)
        state, calls, saved = self.scenario()
        self.assertEqual(state["status"], "private-device-preflight-passed")
        self.assertFalse(state["autonomousDispatchAllowed"])
        owner_lists = [c for c in calls if c[0] == r.LIST and c[2][0] == 422]
        self.assertEqual(owner_lists[0][1], 60)
        self.assertTrue(all(c[1] == 15 for c in owner_lists[1:]))
        self.assertEqual([c[1] for c in calls if c[0] == r.LIST and c[2][0] == 501], [15])
        admitted = next(s for s in saved if "admissionProof" in s)
        self.assertEqual(admitted["phase"], "creating")
        self.assertEqual(len(admitted["commands"]), 1)
        self.assertEqual(admitted["admissionProof"]["freshEmptySetCommandDigest"], r.digest(r.encoded(admitted["commands"][0])))
        self.assertTrue(state["experimentDeviceDeleted"])
        self.assertTrue(all(c[0][0] != "/usr/bin/dscl" for c in calls))

    def test_current_stop_evidence_is_required_before_any_probe_command(self):
        for rows in [[], observations()[:2], [{"processes": [], "userDomainPresent": True}] * 3]:
            with patch.object(m, "probe") as probe:
                with self.assertRaisesRegex(RuntimeError, "stop observations"):
                    r.run_attempt(m, {"currentStopObservations": rows}, lambda: None)
                probe.assert_not_called()

    def test_repeat_timeout_cleans_and_stops_but_does_not_create_or_retry_probe(self):
        provider = fixture.FixedProvider()
        first = True
        def timeout_first(argv, timeout=5, identity=None):
            nonlocal first
            if argv == r.LIST and first:
                first = False
                return fixture.result(code=-9, timeout=True)
            return provider(argv, timeout, identity)
        state, calls, _ = self.scenario(timeout_first)
        self.assertEqual(state["phase"], "maintenance")
        self.assertEqual(state["status"], "blocked")
        self.assertEqual([(c[0], c[1]) for c in calls], [(r.LIST, 60), (r.LIST, 15)])
        self.assertNotIn("admissionProof", state)
        self.assertNotIn("createdUdid", state)
        self.assertTrue(state["experimentDeviceDeleted"])

    def test_nonempty_fresh_set_is_never_deleted_or_used(self):
        provider = fixture.FixedProvider()
        provider.rows = [{"udid": fixture.NEW, "name": "unexpected-device"}]
        state, _, _ = self.scenario(provider)
        self.assertEqual(provider.actions, ["list", "list"])
        self.assertEqual(state["status"], "blocked")
        self.assertFalse(state["experimentDeviceDeleted"])

    def test_admission_persistence_failure_prevents_create_and_still_cleans(self):
        provider = fixture.FixedProvider()
        def fail_admission(state):
            if state.get("phase") == "creating": raise RuntimeError("admission fsync failed")
        state, _, _ = self.scenario(provider, save_hook=fail_admission)
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(provider.actions, ["list", "list"])
        self.assertTrue(state["experimentDeviceDeleted"])

    def test_diagnostics_cannot_be_silently_promoted_to_empty_set_authority(self):
        provider = fixture.FixedProvider()
        def diagnostics(argv, timeout=5, identity=None):
            value = provider(argv, timeout, identity)
            if argv == r.LIST: value["stderr"] = "partial inventory"
            return value
        state, _, _ = self.scenario(diagnostics)
        self.assertNotIn("create", provider.actions)
        self.assertEqual(state["status"], "blocked")

    def test_provisioning_is_rejected_and_original_function_restored(self):
        def malicious_probe(state, persist):
            m.run(["/usr/bin/dscl", ".", "-create", "/Users/loopit-device-probe"])
        with patch.object(m, "probe", side_effect=malicious_probe), patch.object(m, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "never provisions"):
                r.run_attempt(m, {"currentStopObservations": observations()}, lambda: None)
            self.assertIs(m.run, command)
            command.assert_not_called()

    def test_nonroot_apply_does_not_read_plan_or_original_runner(self):
        with patch.object(r.os, "getuid", return_value=501), patch.object(r, "read_file") as read:
            with self.assertRaisesRegex(RuntimeError, "root apply"): r.apply("/missing", "bad")
            read.assert_not_called()

    def test_input_reader_rejects_alias_hardlink_and_oversized_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            value = root / "input"; value.write_bytes(b"ordinary nonsecret")
            self.assertEqual(r.read_file(value), value.read_bytes())
            with self.assertRaisesRegex(RuntimeError, "bounded"): r.read_file(value, limit=2)
            link = root / "symbolic"; link.symlink_to(value)
            with self.assertRaisesRegex(RuntimeError, "canonical"): r.read_file(link)
            hard = root / "hard"; os.link(value, hard)
            with self.assertRaisesRegex(RuntimeError, "single-link"): r.read_file(hard)


if __name__ == "__main__":
    unittest.main()
