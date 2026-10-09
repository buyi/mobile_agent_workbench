#!/usr/bin/env python3
"""Explicit administrator-only account setup/probe; never a production Gate signer.

Without --run or --provision, prints a plan and changes nothing. The root harness
owns positive and negative probes: the Worker never receives sudo permission.
Only newly-created, non-secret files are read or removed.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import uuid

parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--run", action="store_true", help="Probe existing accounts as root")
mode.add_argument("--provision", action="store_true", help="Create missing service accounts, then probe as root")
parser.add_argument("--operator", default=os.environ.get("SUDO_USER"), help="Operator account; defaults to SUDO_USER")
args = parser.parse_args()
setup = Path(__file__).resolve().with_name("setup-worker.sh")
if not (args.run or args.provision):
    print(json.dumps({"status": "plan-only", "changes": False, "steps": [
        "Validate existing identities; optionally create loopit-worker and loopit-signer with private homes.",
        "Create unique 0600 non-secret files owned by operator, signer and Worker.",
        "Verify each owner can read its own fixture, then verify Worker cannot read operator/signer fixtures.",
        "Remove only the new fixtures and retain a local JSON report.",
    ], "privileges": "root harness only; no Worker sudo or operator-home mode changes",
        "command": "sudo /usr/bin/python3 script/macos/account-isolation-probe.py --provision --operator <your-account>"}, indent=2))
    sys.exit(0)
if sys.platform != "darwin" or os.geteuid() != 0:
    parser.error("This probe requires macOS and explicit administrator execution (sudo)")
if not args.operator or not re.fullmatch(r"[a-z_][a-z0-9_-]*", args.operator):
    parser.error("A valid --operator account is required")
operator = pwd.getpwnam(args.operator)
if operator.pw_uid < 501 or args.operator in ("loopit-worker", "loopit-signer"):
    parser.error("Operator must be an ordinary, separate macOS user")

nonce = str(uuid.uuid4())
report = {"schemaVersion": "account-isolation-probe/1", "nonce": nonce,
          "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "status": "blocked", "tests": [], "signedGate": False,
          "limitations": ["Local root-orchestrated capability probe, not an independently signed delivery Gate.",
                          "Only the fresh named fixtures are tested; no claim about every file in the operator home."]}
created = []
directory = Path(tempfile.mkdtemp(prefix="loopit-m0-account-proof-", dir="/private/tmp"))
os.chmod(directory, 0o700)
safe_env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C"}


def run(command, timeout=5):
    try:
        proc = subprocess.run(command, env=safe_env, capture_output=True, text=True, timeout=timeout)
        return {"code": proc.returncode, "stdout": proc.stdout[:65536], "stderr": proc.stderr[:4096], "timedOut": False}
    except subprocess.TimeoutExpired:
        return {"code": None, "stdout": "", "stderr": "probe timeout", "timedOut": True}


def as_user(account, command):
    return run(["/usr/bin/sudo", "-n", "-u", account.pw_name, *command])


def require_identity(account):
    found = as_user(account, ["/usr/bin/id", "-u"])
    if found["timedOut"] or found["code"] != 0 or found["stdout"].strip() != str(account.pw_uid):
        raise RuntimeError("Cannot independently establish process identity for " + account.pw_name)


def fixture(account):
    # mkstemp uses O_EXCL; all cleanup paths come from our own successful creates.
    fd, name = tempfile.mkstemp(prefix=".loopit-m0-nonsecret-", dir=account.pw_dir)
    path = Path(name)
    created.append(path)
    content = ("non-secret M0 identity fixture " + nonce + " " + account.pw_name + "\n").encode()
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, account.pw_uid, account.pw_gid)
        os.write(fd, content)
        os.fsync(fd)
    finally:
        os.close(fd)
    info = path.stat()
    if info.st_uid != account.pw_uid or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("New fixture identity differs from its requested owner")
    positive = as_user(account, ["/bin/cat", name])
    if positive["timedOut"] or positive["code"] != 0 or positive["stdout"] != content.decode():
        raise RuntimeError("Owner baseline failed for " + account.pw_name)
    return path, content


try:
    config = run(["/bin/bash", str(setup), "--apply" if args.provision else "--audit"], timeout=60)
    report["setup"] = config
    if config["timedOut"] or config["code"] != 0:
        raise RuntimeError("Account setup/audit did not pass; access denials cannot substitute for missing accounts")
    if args.provision:
        post_audit = run(["/bin/bash", str(setup), "--audit"], timeout=60)
        report["postProvisionAudit"] = post_audit
        if post_audit["timedOut"] or post_audit["code"] != 0:
            raise RuntimeError("Post-provision account audit failed; do not report readiness")
    worker, signer = pwd.getpwnam("loopit-worker"), pwd.getpwnam("loopit-signer")
    if len({operator.pw_uid, worker.pw_uid, signer.pw_uid}) != 3:
        raise RuntimeError("Operator, Worker and signer must have distinct UIDs")
    for account in (operator, worker, signer):
        require_identity(account)
    own_path, own_content = fixture(worker)
    report["workerPositiveControl"] = {"uid": worker.pw_uid, "readSucceeded": True}
    for role, account in (("operator", operator), ("signer", signer)):
        path, content = fixture(account)
        denied = as_user(worker, ["/bin/cat", str(path)])
        passed = (denied["code"] == 1 and not denied["timedOut"] and not denied["stdout"] and
                  ("Permission denied" in denied["stderr"] or "Operation not permitted" in denied["stderr"]))
        report["tests"].append({"name": role + " fixture unreadable to Worker without Seatbelt", "passed": passed,
                                "ownerUid": account.pw_uid, "workerUid": worker.pw_uid,
                                "fixture": str(path), "fixtureDigest": "sha256:" + hashlib.sha256(content).hexdigest(),
                                "ownerReadSucceeded": True, "workerRead": denied})
    report["status"] = "capability-probe-passed" if all(t["passed"] for t in report["tests"]) else "failed"
except Exception as error:
    report["error"] = str(error)
finally:
    failures = []
    for path in created:
        try:
            path.unlink()
        except Exception as error:
            failures.append({"path": str(path), "error": str(error)})
    report["cleanup"] = {"temporaryFixtureCount": len(created), "failures": failures, "confirmed": not failures}
    if failures:
        report["status"] = "blocked"
    report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    destination = directory / "result.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    os.chmod(destination, 0o600)
    # The report contains no credentials. It is a local capability record, not a
    # trusted signing artifact; hand it to the operator after all root work ends.
    os.chown(destination, operator.pw_uid, operator.pw_gid)
    os.chown(directory, operator.pw_uid, operator.pw_gid)
    print(json.dumps({"status": report["status"], "report": str(destination)}))
sys.exit(0 if report["status"] == "capability-probe-passed" else 2)
