#!/usr/bin/env python3
"""Audit or explicitly repair the five code assets of the installed M0 fixture.

This is deliberately tied to one job, not an arbitrary privileged file writer.
No accounts, key, signer configuration, goal, source or budget are changed.
Interrupted mutation leaves Supervisor admission quarantined (maintenance).
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

FINAL = Path('/private/var/loopit/m0-runs/m0-code-loop-20261009a')
STATE = Path('/private/var/loopit/supervisor')
AUTH_SOURCE = Path('/private/tmp/loopit-opencode-preview.hnHSTM/data/opencode/auth.json')
ASSETS = {'bin/controller.mjs': 0o444, 'bin/verifier.mjs': 0o444,
          'bin/supervisor-probe.mjs': 0o444, 'bin/worker-exec.py': 0o555,
          'bin/worker-supervisor.py': 0o555}
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C.UTF-8'}


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', value)


def regular(path, limit=128 * 1024 * 1024, protected=False, mode=None):
    path = Path(path)
    if not path.is_absolute() or str(path.resolve()) != str(path):
        raise RuntimeError('Noncanonical or symbolic path')
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or (protected and (info.st_uid != 0 or info.st_mode & 0o022)):
            raise RuntimeError('Unprotected installed ancestor')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise RuntimeError('Expected a bounded single-link regular file')
        if protected and (before.st_uid != 0 or before.st_mode & 0o022):
            raise RuntimeError('Installed file is not root protected')
        if mode is not None and stat.S_IMODE(before.st_mode) != mode:
            raise RuntimeError('Installed file mode changed')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise RuntimeError('File grew beyond bound')
            chunks.append(chunk)
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino) or size != before.st_size:
            raise RuntimeError('File changed during read')
        return b''.join(chunks)
    finally:
        os.close(fd)


def audit_plan(path, expected):
    raw = regular(path, 1024 * 1024)
    if not digest(expected) or sha(raw) != expected:
        raise RuntimeError('Plan digest mismatch')
    plan = json.loads(raw)
    if set(plan) != {'schemaVersion', 'revisionId', 'finalRoot', 'previousSpecDigest', 'previousInstallReceiptDigest', 'files'}:
        raise RuntimeError('Unexpected plan fields')
    if plan['schemaVersion'] != 'm0-control-update/1' or plan['finalRoot'] != str(FINAL):
        raise RuntimeError('Only the fixed installed M0 job may be repaired')
    if not isinstance(plan['revisionId'], str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', plan['revisionId']):
        raise RuntimeError('Invalid revision ID')
    if not digest(plan['previousSpecDigest']) or not digest(plan['previousInstallReceiptDigest']):
        raise RuntimeError('Missing previous installed document pins')
    if not isinstance(plan['files'], list) or not 1 <= len(plan['files']) <= len(ASSETS):
        raise RuntimeError('Expected one to five code replacements')
    contents = {}
    for item in plan['files']:
        if set(item) != {'path', 'source', 'oldDigest', 'newDigest', 'size'} or item['path'] not in ASSETS or item['path'] in contents:
            raise RuntimeError('Duplicate or non-whitelisted code replacement')
        if item['source'] != Path(item['path']).name or not digest(item['oldDigest']) or not digest(item['newDigest']):
            raise RuntimeError('Invalid source basename or code pin')
        if type(item['size']) is not int or not 0 < item['size'] <= 128 * 1024 * 1024:
            raise RuntimeError('Invalid code asset size')
        data = regular(path.parent / item['source'])
        if len(data) != item['size'] or sha(data) != item['newDigest']:
            raise RuntimeError('Staged code digest mismatch: ' + item['path'])
        contents[item['path']] = data
    return plan, raw, contents


def directory(path, mode):
    if str(path.resolve()) != str(path):
        raise RuntimeError('Symbolic installed directory')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('Installed directory ownership/mode changed')


def no_live_services():
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,uid=,ruid=,stat='], env=ENV,
                            capture_output=True, timeout=5, check=True)
    for line in result.stdout.decode().splitlines():
        fields = line.split()
        if len(fields) != 4 or not all(x.isdigit() for x in fields[:3]):
            raise RuntimeError('Unrecognized process inventory')
        if (420 in (int(fields[1]), int(fields[2])) or 421 in (int(fields[1]), int(fields[2]))) and not fields[3].startswith('Z'):
            raise RuntimeError('Worker or Signer still has live processes')


def acquire(name):
    path = STATE / name
    regular(path, 1024, protected=True, mode=0o600)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise RuntimeError('Supervisor lock identity changed')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (info.st_dev, info.st_ino) != (path.lstat().st_dev, path.lstat().st_ino):
            raise RuntimeError('Supervisor lock replaced during acquisition')
        return fd
    except BaseException:
        os.close(fd)
        raise


def installed(plan):
    control = FINAL / 'control'
    directory(FINAL, 0o755); directory(FINAL / 'bin', 0o555)
    directory(control, 0o700); directory(STATE, 0o700)
    spec_raw = regular(control / 'spec.json', protected=True, mode=0o600)
    receipt_raw = regular(control / 'install-receipt.json', protected=True, mode=0o600)
    if sha(spec_raw) != plan['previousSpecDigest'] or sha(receipt_raw) != plan['previousInstallReceiptDigest']:
        raise RuntimeError('Installed spec or receipt pin changed')
    spec, receipt = json.loads(spec_raw), json.loads(receipt_raw)
    if (spec.get('schemaVersion'), spec.get('jobId'), spec.get('controlDirectory')) != ('m0-control-loop/1', FINAL.name, str(control)):
        raise RuntimeError('Installed spec does not identify the fixed job')
    if spec.get('authPath') != str(control / 'auth.json') or receipt.get('root') != str(FINAL) or receipt.get('specPath') != str(control / 'spec.json'):
        raise RuntimeError('Installed path identity changed')
    manifest_raw = regular(control / 'install-manifest.json', protected=True, mode=0o600)
    if sha(manifest_raw) != receipt.get('manifestDigest'):
        raise RuntimeError('Installation manifest differs from protected receipt pin')
    manifest = json.loads(manifest_raw)
    if manifest.get('id') != FINAL.name or manifest.get('finalRoot') != str(FINAL):
        raise RuntimeError('Installation manifest job mismatch')
    pins = receipt.get('codeAssetDigests')
    if pins is None:
        pins = {item['path']: item['digest'] for item in manifest['files'] if item['path'] in ASSETS}
    if set(pins) != set(ASSETS) or not all(digest(value) for value in pins.values()):
        raise RuntimeError('Installed code asset ledger is incomplete')
    old = {}
    for relative, mode in ASSETS.items():
        old[relative] = regular(FINAL / relative, protected=True, mode=mode)
        if sha(old[relative]) != pins[relative]:
            raise RuntimeError('Installed code does not match its protected ledger: ' + relative)
    for relative, field in [('bin/worker-exec.py', 'wrapper'), ('bin/verifier.mjs', 'verifierCli')]:
        if spec.get(field) != {'path': str(FINAL / relative), 'digest': pins[relative]}:
            raise RuntimeError('Spec code binding differs from protected ledger')
    for item in plan['files']:
        if item['oldDigest'] != pins[item['path']]:
            raise RuntimeError('Replacement old pin differs from installed ledger')
    active_raw = regular(STATE / 'active.json', protected=True, mode=0o600)
    active = json.loads(active_raw)
    if active.get('phase') != 'stopped' or active.get('admissionDeadline') != 0:
        raise RuntimeError('Supervisor scope is not stopped with admission closed')
    if (active.get('workerUid'), active.get('signerUid')) != (420, 421):
        raise RuntimeError('Supervisor identity changed')
    for key in ('stopProof', 'signerStopProof'):
        proof = active.get(key, {})
        if proof.get('scopeId') != active.get('scopeId') or proof.get('generation') != active.get('generation') or proof.get('noLiveWorkerProcesses') is not True:
            raise RuntimeError('Supervisor stop proof is missing or stale')
    no_live_services()
    return spec, receipt, pins, old, spec_raw, receipt_raw, active, active_raw


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, 0, 0); os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise RuntimeError('Short write')
            view = view[written:]
        os.fsync(fd)
        if sys.platform == 'darwin':
            fcntl.fcntl(fd, 51)  # F_FULLFSYNC, matching Supervisor durability.
    finally:
        os.close(fd)
    sync_dir(path.parent)


def replace(path, data, mode=0o600):
    temporary = path.with_name('.' + path.name + '.' + str(uuid.uuid4()) + '.update')
    write_new(temporary, data, mode)
    os.replace(temporary, path)
    sync_dir(path.parent)


def access_only():
    original = regular(AUTH_SOURCE, 1024 * 1024)
    auth = json.loads(original).get('openai', {})
    expires = auth.get('expires')
    if auth.get('type') != 'oauth' or not isinstance(auth.get('access'), str) or len(auth['access']) < 8 or type(expires) not in (int, float) or not math.isfinite(expires) or expires < datetime.datetime.now().timestamp() * 1000 + 120000:
        raise RuntimeError('Original access token unavailable/expired; no refresh is attempted')
    result = {'access': auth['access'], 'expiresAt': expires}
    if 'accountId' in auth:
        if not isinstance(auth['accountId'], str):
            raise RuntimeError('Invalid original account reference')
        result['accountId'] = auth['accountId']
    return original, encoded(result)


def run(plan_path, expected, apply=False, refresh=False):
    plan, plan_raw, replacements = audit_plan(plan_path, expected)
    if refresh and not apply:
        raise RuntimeError('--refresh-access requires explicit --apply; audit never reads authentication')
    if sys.platform != 'darwin' or os.getuid() != 0 or os.geteuid() != 0:
        if apply:
            raise RuntimeError('Explicit macOS root execution required')
        return {'status': 'staged-plan-audited', 'installedState': 'not-checked-requires-root-read',
                'planDigest': expected, 'fileCount': len(replacements), 'writes': 0, 'credentialsRead': False}
    os.umask(0o077)
    locks = []
    try:
        locks.append(acquire('ownership.lock'))
        locks.append(acquire('launch.lock'))
        spec, receipt, pins, old, spec_raw, receipt_raw, active, active_raw = installed(plan)
        control, revision = FINAL / 'control', FINAL / 'control/revisions' / plan['revisionId']
        if revision.exists():
            raise RuntimeError('Revision already exists; interrupted updates are never retried automatically')
        if not apply:
            return {'status': 'audited-not-applied', 'planDigest': expected, 'fileCount': len(replacements),
                    'installedState': 'stopped-and-pinned', 'writes': 0, 'credentialsRead': False}
        # The optional temporary credential is reconstructed only if it was
        # deleted. Never overwrite an existing credential or copy refresh data.
        original, credential = None, None
        if refresh:
            if (control / 'auth.json').exists():
                raise RuntimeError('Access-only copy already exists; refuse overwrite')
            original, credential = access_only()
        if not revision.parent.exists():
            revision.parent.mkdir(mode=0o700); sync_dir(control)
        directory(revision.parent, 0o700)
        revision.mkdir(mode=0o700); sync_dir(revision.parent)
        write_new(revision / 'plan.json', plan_raw)
        write_new(revision / 'spec.before.json', spec_raw)
        write_new(revision / 'install-receipt.before.json', receipt_raw)
        write_new(revision / 'active.before.json', active_raw)
        for relative, data in old.items():
            write_new(revision / Path(relative).name, data)
        # Null identities also make the *old*, already-installed Supervisor's
        # scope_identities reject generic recover if we crash before replacing
        # that binary. The complete original scope is preserved above. Only a
        # completely persisted update restores the original stopped identity.
        replace(STATE / 'active.json', encoded({**active, 'phase': 'maintenance', 'admissionDeadline': 0,
                                               'workerUid': None, 'signerUid': None,
                                               'codeUpdateRevision': plan['revisionId']}))
        # Any error after this point leaves durable maintenance admission closed.
        no_live_services()
        for relative, data in replacements.items():
            replace(FINAL / relative, data, ASSETS[relative])
            pins[relative] = sha(data)
        spec['wrapper']['digest'] = pins['bin/worker-exec.py']
        spec['verifierCli']['digest'] = pins['bin/verifier.mjs']
        next_spec = encoded(spec)
        replace(control / 'spec.json', next_spec)
        new_receipt = {**receipt, 'codeAssetDigests': pins,
                       'lastUpdate': {'revisionId': plan['revisionId'], 'planDigest': expected,
                                      'receiptPath': str(revision / 'update-receipt.json')}}
        replace(control / 'install-receipt.json', encoded(new_receipt))
        if refresh:
            if regular(AUTH_SOURCE, 1024 * 1024) != original:
                raise RuntimeError('Original authentication changed concurrently; access copy not written')
            write_new(control / 'auth.json', credential)
        for relative, pin in pins.items():
            if sha(regular(FINAL / relative, protected=True, mode=ASSETS[relative])) != pin:
                raise RuntimeError('Installed code failed final digest check')
        no_live_services()
        outcome = {'schemaVersion': 'm0-control-update-receipt/1', 'status': 'applied-not-executed',
                   'revisionId': plan['revisionId'], 'finalRoot': str(FINAL), 'planDigest': expected,
                   'previousSpecDigest': sha(spec_raw), 'specDigest': sha(next_spec),
                   'previousInstallReceiptDigest': sha(receipt_raw), 'installReceiptDigest': sha(encoded(new_receipt)),
                   'codeAssetDigests': pins, 'replacements': plan['files'], 'accessCopyRecreated': refresh,
                   'originalAuthUnchanged': True if refresh else None, 'refreshTokenCopied': False,
                   'modelCalls': 0, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        write_new(revision / 'update-receipt.json', encoded(outcome))
        replace(STATE / 'active.json', encoded({**active, 'lastCodeRevision': plan['revisionId']}))
        return outcome
    finally:
        for fd in reversed(locks):
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--refresh-access', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.plan.absolute(), args.sha256, args.apply, args.refresh_access)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'blocked', 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          'note': 'No automatic retry or rollback. After mutation, inspect the retained maintenance scope and revision.'}))
        sys.exit(2)
