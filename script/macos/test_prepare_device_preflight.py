"""Non-privileged protocol tests. No dscl mutation, simctl, account or device use."""
import copy
import importlib.util
import json
from pathlib import Path
import signal
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("device_preflight", Path(__file__).with_name("prepare-device-preflight.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
NEW = "6D9EB9B7-02A1-43B4-BA68-EF334DBAEF10"
NAME = "Loopit UID422 Preflight 456ba9cb-64bc-45bc-bdac-e9e8fbc9f451"


def result(stdout="", code=0, stderr="", timeout=False):
    return {"stdout": stdout, "stderr": stderr, "exitCode": code, "timedOut": timeout, "overflow": False}


class FixedProvider:
    def __init__(self, unknown_create=False, denial="Permission denied"):
        self.rows = []
        self.actions = []
        self.calls = []
        self.unknown_create = unknown_create
        self.denial = denial

    def __call__(self, argv, timeout=5, identity=None):
        self.calls.append((argv, identity))
        if argv[-1] == "--internal-access":
            uid, gid, groups, _ = identity
            own = uid == 422
            return result(json.dumps({"uid": uid, "gid": gid, "kernelGroups": groups, "public": {"opened": True},
                                      "directory": {"opened": True} if own else {"opened": False, "errno": 13},
                                      "canary": {"opened": True} if own else {"opened": False, "errno": 13}}))
        if argv == [m.XCRUN, "simctl", "help"]:
            return result("usage: simctl [--set <path>] ...")
        assert argv[:4] == [m.XCRUN, "simctl", "--set", str(m.SET)]
        action = argv[4]
        if identity[0] == 501:
            assert action == "list"
            return result(code=1, stderr=self.denial)
        assert identity[:3] == (422, 422, [422])
        self.actions.append(action)
        if action == "list":
            return result(json.dumps({"devices": {m.RUNTIME: self.rows}}))
        if action == "create":
            self.rows = [{"udid": NEW, "name": argv[5], "state": "Shutdown", "isAvailable": True, "deviceTypeIdentifier": m.DEVICE_TYPE}]
            return result(NEW + "\n", code=None if self.unknown_create else 0, timeout=self.unknown_create)
        assert argv[5] == NEW and argv[5] != m.FORBIDDEN_UDID
        if action == "boot": self.rows[0]["state"] = "Booted"
        elif action == "shutdown": self.rows[0]["state"] = "Shutdown"
        elif action == "delete": self.rows = []
        else: assert action == "bootstatus"
        return result()


class Tests(unittest.TestCase):
    def setUp(self):
        m.APPLY_DEADLINE = m.WORK_DEADLINE = None

    def tearDown(self):
        m.APPLY_DEADLINE = m.WORK_DEADLINE = None

    def test_directory_absence_requires_complete_parse_and_free_name_and_id(self):
        rows = m.directory_rows("nobody -2\nroot 0\nother 500\n")
        m.assert_unused(rows, "Users")
        for rows in [[(m.NAME, 500)], [("other", 422)]]:
            with self.assertRaises(RuntimeError): m.assert_unused(rows, "Users")
        for text in ["", "user missing", "user 422 extra"]:
            with self.assertRaises(RuntimeError): m.directory_rows(text)

    def test_commands_always_fixed_private_set_and_only_observed_new_uuid(self):
        self.assertEqual(m.tool_argv("list"), [m.XCRUN, "simctl", "--set", str(m.SET), "list", "devices", "-j"])
        self.assertEqual(m.tool_argv("create", name=NAME)[5:], [NAME, m.DEVICE_TYPE, m.RUNTIME])
        for action in ["boot", "bootstatus", "shutdown", "delete"]:
            self.assertEqual(m.tool_argv(action, NEW)[5], NEW)
            for bad in [None, "all", "booted", m.FORBIDDEN_UDID, "../../something", NEW.lower()]:
                with self.assertRaises(RuntimeError): m.tool_argv(action, bad)
        for action in ["install", "spawn", "erase", "/bin/sh", "--set"]:
            with self.assertRaises(RuntimeError): m.tool_argv(action, NEW)
        with self.assertRaises(RuntimeError): m.tool_argv("create", name="arbitrary name")

    def test_inventory_rejects_existing_formal_device_and_wrong_binding(self):
        with self.assertRaises(RuntimeError): m.devices(json.dumps({"devices": {m.RUNTIME: [{"udid": m.FORBIDDEN_UDID}]}}))
        row = {"udid": NEW, "name": NAME, "runtime": m.RUNTIME, "deviceTypeIdentifier": m.DEVICE_TYPE, "isAvailable": True}
        self.assertEqual(m.owned_device([row], NEW, NAME), row)
        for rows in [[], [row, row], [{**row, "name": "someone else's"}], [{**row, "runtime": "other"}], [{**row, "isAvailable": False}]]:
            with self.assertRaises(RuntimeError): m.owned_device(rows, NEW, NAME)

    def test_domain_inventory_is_read_only_system_and_unknown_format_blocks(self):
        text = "system = {\n\tsubdomains = {\n\t\tuser/422\n\t\tuser/501\n\t}\n}\n"
        with patch.object(m, "run", return_value=result(text)) as command:
            self.assertTrue(m.domain_present())
            self.assertEqual(command.call_args.args[0], ["/bin/launchctl", "print", "system"])
        self.assertFalse(m.domain_present(text.replace("\t\tuser/422\n", "")))
        for bad in [text.replace("user/422", "unknown/422"), text.replace("\t}", ""), "", text.replace("user/501", "user/422")]:
            with self.assertRaises(RuntimeError): m.domain_present(bad)

    def scenario(self, provider, persist=None, stop_error=None):
        state = {"deviceName": NAME, "commands": []}
        save = persist or (lambda: None)
        def account(name):
            return SimpleNamespace(pw_uid=501 if name == "buyi" else 420, pw_gid=20 if name == "buyi" else 420, pw_dir="/no-data-read")
        with patch.object(m, "assert_account"), patch.object(m, "tool_check"), patch.object(m, "run", side_effect=provider), \
             patch.object(m.pwd, "getpwnam", side_effect=account), patch.object(m.os, "getgrouplist", return_value=[20, 80]), \
             patch.object(m, "stop_device_identity", side_effect=stop_error, return_value={"noLiveProcesses": True, "userDomainAbsent": True}) as stop:
            m.probe(state, save)
            self.assertEqual(stop.call_count, 1)
        return state

    def test_finite_success_observes_uuid_before_boot_and_deletes_only_that_device(self):
        provider = FixedProvider()
        state = self.scenario(provider)
        self.assertEqual(state["status"], "private-device-preflight-passed")
        self.assertTrue(state["experimentDeviceDeleted"])
        self.assertEqual(provider.actions[:4], ["list", "create", "list", "boot"])
        self.assertEqual(provider.actions[-3:], ["list", "delete", "list"])
        worker = [argv for argv, identity in provider.calls if identity and identity[0] == 420]
        self.assertEqual(worker, [["/usr/bin/python3", str(m.RUNNER), "--internal-access"]])
        operator_identities = [identity for _, identity in provider.calls if identity and identity[0] == 501]
        self.assertTrue(all(identity[1:3] == (20, [20, 80]) for identity in operator_identities))
        self.assertTrue(state["operatorToolHelpBaseline"])

    def test_unknown_create_has_no_boot_or_delete_and_retains_maintenance(self):
        provider = FixedProvider(unknown_create=True)
        state = self.scenario(provider)
        self.assertEqual(state["phase"], "maintenance")
        self.assertFalse(state["experimentDeviceDeleted"])
        self.assertNotIn("boot", provider.actions); self.assertNotIn("delete", provider.actions)
        self.assertNotIn("createdUdid", state)

    def test_tool_failure_is_not_operator_denial_and_known_device_is_cleaned(self):
        provider = FixedProvider(denial="CoreSimulator service unavailable")
        state = self.scenario(provider)
        self.assertEqual(state["phase"], "maintenance")
        self.assertTrue(state["experimentDeviceDeleted"])
        self.assertNotIn("operatorPrivateSetDenied", state)

    def test_cleanup_stop_failure_forbids_pass_even_when_device_deleted(self):
        state = self.scenario(FixedProvider(), stop_error=RuntimeError("domain reappeared"))
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(state["phase"], "maintenance")
        self.assertTrue(state["experimentDeviceDeleted"])

    def test_persistence_failure_still_attempts_dedicated_cleanup(self):
        provider = FixedProvider()
        with patch.object(m, "stop_device_identity", return_value={}) as stop, patch.object(m, "assert_account"), \
             patch.object(m, "tool_check"), patch.object(m, "run", side_effect=provider):
            with self.assertRaisesRegex(RuntimeError, "disk fault"):
                m.probe({"deviceName": NAME, "commands": []}, lambda: (_ for _ in ()).throw(RuntimeError("disk fault")))
            self.assertEqual(stop.call_count, 1)

    def test_group_drift_blocks_instead_of_repairing_or_deleting_identity(self):
        account = SimpleNamespace(pw_uid=422, pw_gid=422, pw_dir=str(m.HOME), pw_shell="/usr/bin/false")
        with patch.object(m.pwd, "getpwnam", return_value=account), patch.object(m, "run", return_value=result("PrimaryGroupID: 499\n")) as call:
            with self.assertRaisesRegex(RuntimeError, "group identity changed"): m.assert_account()
            self.assertEqual(call.call_args.args[0][2], "-read")

    def test_nonroot_apply_and_invalid_reaper_targets_have_no_system_actions(self):
        with patch.object(m.os, "getuid", return_value=501), patch.object(m, "make_plan") as plan:
            with self.assertRaisesRegex(RuntimeError, "root apply"): m.apply("missing", "bad")
            plan.assert_not_called()
        with patch.object(m.os, "fork") as fork:
            for targets in [[-1], [0], [1], [m.os.getpid()]]:
                with self.assertRaises(RuntimeError): m.reap(signal.SIGKILL, targets, time.monotonic() + 1)
            fork.assert_not_called()

    def test_local_child_timeout_and_output_cap_are_bounded_without_group_signals(self):
        start = time.monotonic()
        value = m.run([sys.executable, "-c", "import time; time.sleep(10)"], timeout=.1)
        self.assertTrue(value["timedOut"])
        self.assertLess(time.monotonic() - start, 2)
        value = m.run([sys.executable, "-c", "import sys; sys.stdout.write('x' * (4*1024*1024))"], timeout=2)
        self.assertTrue(value["overflow"])
        self.assertLessEqual(len(value["stdout"]), 2 * 1024 ** 2)


if __name__ == "__main__":
    unittest.main()
