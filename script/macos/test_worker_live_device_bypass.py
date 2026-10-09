"""Protocol fixtures only: no administrator, identity changes or simctl calls."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


p = load("live_worker_probe", "worker-private-set-probe.py")
h = p.load_helper()
fixtures = load("live_preflight_fixture", "test_prepare_device_preflight.py")
m = fixtures.m
NEW = fixtures.NEW
ACCOUNT = SimpleNamespace(pw_uid=420, pw_gid=420, pw_shell="/usr/bin/false", pw_dir="/worker-fixture")


class Provider:
    def __init__(self, fault=None):
        self.fault = fault
        self.calls = []
        self.row = None
        self.owner_rename_count = 0

    def result(self, text="", code=0, stderr="", timeout=False):
        return fixtures.result(text, code=code, stderr=stderr, timeout=timeout)

    def __call__(self, argv, timeout=5, identity=None):
        self.calls.append((list(argv), timeout, identity))
        uid, gid, groups, _ = identity
        if argv == ["/usr/bin/python3", str(h.RUNNER), "--internal-access"]:
            access = {"uid": uid, "gid": gid, "kernelGroups": groups, "public": {"opened": True}}
            for key in ("directory", "canary"):
                access[key] = {"opened": True} if uid == 422 else {"opened": False, "errno": 13}
            if self.fault == "wrong-worker-identity" and uid == 420:
                access["uid"] = 501
            return self.result(json.dumps(access))
        if argv == [m.XCRUN, "simctl", "help"]:
            assert uid == 420
            return self.result("usage: simctl [--set <path>] ...")
        if argv == [m.XCRUN, "simctl", "list", "devices", "-j"]:
            assert uid == 420
            if self.fault == "default-unavailable":
                return self.result(code=1, stderr="CoreSimulator service unavailable")
            # The unrelated real Goal UDID may appear in the default inventory;
            # reading it must not admit any mutation targeting it.
            rows = [{"udid": m.FORBIDDEN_UDID}]
            if self.fault == "default-visible":
                rows.append(copy.deepcopy(self.row))
            return self.result(json.dumps({"devices": {m.RUNTIME: rows}}))
        if argv[:3] == [m.XCRUN, "simctl", "rename"]:
            assert uid == 420 and argv[3] == NEW and self.row["state"] == "Booted"
            if self.fault in ("rename-success", "rename-success-no-change"):
                if self.fault == "rename-success":
                    self.row["name"] = argv[4]
                return self.result()
            if self.fault == "rename-unknown":
                self.row["name"] = argv[4]
                return self.result(code=-9, timeout=True)
            if self.fault == "rename-wrong-id":
                return self.result(code=1, stderr="Invalid device: " + m.FORBIDDEN_UDID)
            return self.result(code=1, stderr="Invalid device: " + NEW + "\n")
        assert argv[:4] == [m.XCRUN, "simctl", "--set", str(h.SET)]
        action = argv[4]
        if uid == 420:
            assert argv == h.LIST
            if self.fault == "private-success":
                return self.result(json.dumps({"devices": {m.RUNTIME: [self.row]}}))
            return self.result(code=1, stderr="Provided set path does not exist: " + str(h.SET) + "\n")
        assert uid == 422 and identity[:3] == (422, 422, [422])
        if action == "list":
            return self.result(json.dumps({"devices": {m.RUNTIME: [self.row] if self.row else []}}))
        if action == "create":
            assert self.row is None
            self.row = {"udid": NEW, "name": argv[5], "deviceTypeIdentifier": m.DEVICE_TYPE,
                        "isAvailable": True, "state": "Shutdown"}
            if self.fault == "create-unknown":
                return self.result(code=-9, timeout=True)
            if self.fault == "create-forbidden":
                return self.result(m.FORBIDDEN_UDID + "\n")
            return self.result(NEW + "\n")
        assert argv[5] == NEW and self.row is not None
        if action == "boot":
            self.row["state"] = "Booted"
        elif action == "bootstatus":
            assert argv[6:] == ["-b"]
        elif action == "rename":
            assert self.row["name"] == argv[6] + " BYPASS"
            self.owner_rename_count += 1
            self.row["name"] = argv[6]
        elif action == "shutdown":
            if self.fault == "shutdown-unknown":
                return self.result(code=-9, timeout=True)
            self.row["state"] = "Shutdown"
        elif action == "delete":
            assert self.row["state"] == "Shutdown"
            if self.fault == "delete-unknown":
                return self.result(code=-9, timeout=True)
            self.row = None
        else:
            raise AssertionError("Unapproved command: " + repr(argv))
        return self.result()


class Tests(unittest.TestCase):
    def scenario(self, provider, save=None):
        state = {"commands": [], "deletedPriorUdid": "8C48B494-D182-4788-A4F9-B53F97CA69D0"}
        with patch.object(m, "run", side_effect=provider), patch.object(m, "assert_account"), patch.object(m, "tool_check"), \
             patch.object(m.pwd, "getpwnam", return_value=ACCOUNT):
            p.observe_live_device(m, h, state, (lambda: save(state)) if save else lambda: None)
        return state

    def test_live_target_is_bound_before_and_after_all_three_negatives_then_deleted(self):
        provider = Provider()
        state = self.scenario(provider)
        self.assertIsNone(state["error"])
        self.assertTrue(state["experimentDeviceDeleted"])
        self.assertIsNone(provider.row)
        self.assertEqual(state["bypasses"], [])
        self.assertEqual([row["label"] for row in state["ownerLiveObservations"]],
                         ["before-worker-probes", "after-default-list", "after-default-rename", "after-private-path-list"])
        self.assertTrue(all(row["device"]["udid"] == NEW and row["device"]["state"] == "Booted" and
                            row["device"]["name"] == state["deviceName"] for row in state["ownerLiveObservations"]))
        observation = state["liveCliObservation"]
        self.assertTrue(all(observation[key] for key in ("defaultListTargetAbsent", "defaultRenameDenied", "privatePathDenied")))
        self.assertFalse(observation["completeNativeIpcControlProven"])
        self.assertFalse(observation["productionBrokerProven"])
        self.assertFalse(observation["autonomousDispatchAllowed"])
        self.assertTrue(all(m.FORBIDDEN_UDID not in argv for argv, _, _ in provider.calls))
        self.assertEqual([argv[4] for argv, _, identity in provider.calls if identity[0] == 422 and argv[:4] == h.LIST[:4] and argv[4] != "list"],
                         ["create", "boot", "bootstatus", "shutdown", "delete"])
        self.assertTrue(all(row["phase"] == "observed" for row in state["commands"]))

    def test_successful_rename_is_never_a_pass_and_owner_restores_exact_bound_device(self):
        provider = Provider("rename-success")
        state = self.scenario(provider)
        self.assertIn("bypass observed", state["error"])
        self.assertTrue(state["ownerRestoredProbeRename"])
        self.assertEqual(provider.owner_rename_count, 1)
        self.assertTrue(state["experimentDeviceDeleted"])
        self.assertIn("default-rename-succeeded", [row["kind"] for row in state["bypasses"]])

    def test_success_without_name_change_visibility_or_private_success_still_fail(self):
        for fault in ("rename-success-no-change", "default-visible", "private-success"):
            with self.subTest(fault=fault):
                state = self.scenario(Provider(fault))
                self.assertIn("bypass observed", state["error"])
                self.assertTrue(state["bypasses"])
                self.assertTrue(state["experimentDeviceDeleted"])

    def test_service_failure_wrong_udid_error_and_wrong_identity_do_not_establish_denial(self):
        for fault in ("default-unavailable", "rename-wrong-id", "wrong-worker-identity"):
            with self.subTest(fault=fault):
                state = self.scenario(Provider(fault))
                self.assertTrue(state["error"])
                self.assertNotIn("liveCliObservation", state)
                self.assertTrue(state["experimentDeviceDeleted"])

    def test_unknown_rename_is_not_replayed_and_owner_reconciles_before_cleanup(self):
        provider = Provider("rename-unknown")
        state = self.scenario(provider)
        self.assertIn("outcome unknown", state["error"])
        self.assertEqual(sum(argv[:3] == [m.XCRUN, "simctl", "rename"] for argv, _, _ in provider.calls), 1)
        self.assertTrue(state["ownerRestoredProbeRename"])
        self.assertTrue(state["experimentDeviceDeleted"])

    def test_unknown_or_forbidden_create_receipt_never_guesses_adopts_or_recreates(self):
        for fault in ("create-unknown", "create-forbidden"):
            with self.subTest(fault=fault):
                provider = Provider(fault)
                state = self.scenario(provider)
                self.assertTrue(state["error"])
                self.assertIn("identity unknown", state["cleanupError"])
                self.assertIsNone(state["createdUdid"])
                self.assertIsNotNone(provider.row)
                mutations = [argv[4] for argv, _, _ in provider.calls if argv[:4] == h.LIST[:4] and argv[4] != "list"]
                self.assertEqual(mutations, ["create"])

    def test_cleanup_unknown_has_no_second_shutdown_or_delete(self):
        for fault, action in (("shutdown-unknown", "shutdown"), ("delete-unknown", "delete")):
            with self.subTest(fault=fault):
                provider = Provider(fault)
                state = self.scenario(provider)
                self.assertTrue(state["cleanupError"])
                self.assertNotIn("experimentDeviceDeleted", state)
                self.assertEqual(sum(argv[:5] == h.LIST[:4] + [action] for argv, _, _ in provider.calls), 1)
                if action == "shutdown":
                    self.assertFalse(any(argv[:5] == h.LIST[:4] + ["delete"] for argv, _, _ in provider.calls))

    def test_intent_write_failure_prevents_create_and_preserves_failure_during_cleanup(self):
        provider = Provider()
        def save(state):
            if state["commands"] and state["commands"][-1]["argv"][:5] == h.LIST[:4] + ["create"]:
                raise RuntimeError("fixture disk failure")
        state = self.scenario(provider, save)
        self.assertEqual(state["persistenceError"], "fixture disk failure")
        self.assertFalse(any(argv[:5] == h.LIST[:4] + ["create"] for argv, _, _ in provider.calls))
        self.assertTrue(state["experimentDeviceDeleted"])

    def test_owner_binding_change_refuses_destructive_cleanup(self):
        provider = Provider()
        def mutate(state):
            if state.get("privatePathDenied") and provider.row:
                provider.row["name"] = "Unrecognized foreign device name"
        state = self.scenario(provider, mutate)
        self.assertIn("binding changed", state["error"])
        self.assertIn("binding changed", state["cleanupError"])
        self.assertFalse(any(argv[:5] == h.LIST[:4] + ["delete"] for argv, _, _ in provider.calls))

    def test_live_mode_is_explicit_and_default_plan_has_no_mutations(self):
        with patch.object(p, "validate_prior", return_value={"createdUdid": "old-reviewed-device"}):
            default = p.make_plan(h, b"fixture")
            live = p.make_plan(h, b"fixture", p.LIVE_MODE)
            self.assertFalse(default["deviceMutationsAllowed"])
            self.assertNotIn("mode", default)
            self.assertEqual(live["mode"], p.LIVE_MODE)
            self.assertEqual(live["maximumSeconds"], 420)
            self.assertEqual(live["reservedCleanupSeconds"], 120)
            self.assertFalse(live["unknownCreateOrCleanupRetryAllowed"])
            self.assertFalse(live["autonomousDispatchAllowed"])
            with self.assertRaisesRegex(RuntimeError, "Unknown fixed"):
                p.make_plan(h, b"fixture", "arbitrary")


if __name__ == "__main__":
    unittest.main()
