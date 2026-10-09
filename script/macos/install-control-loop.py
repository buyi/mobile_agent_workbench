#!/usr/bin/env python3
"""Audit, or explicitly install, one pinned M0 control-loop payload.

Default is read-only staging audit. --apply requires root and never starts a
controller/model, changes accounts/sudo rules, or overwrites an existing run.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import stat
import subprocess
import sys

BASE = Path('/private/var/loopit')
SIGNER = BASE / 'signer/m0-verifier'
AUTH_SOURCE = Path('/private/tmp/loopit-opencode-preview.hnHSTM/data/opencode/auth.json')
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
FIXED = {'bin/bun', 'bin/opencode', 'bin/controller.mjs', 'bin/verifier.mjs', 'bin/worker-exec.py', 'bin/worker-supervisor.py',
         'public/source.ts', 'public/tests.json', 'public/runner.mjs', 'public/catalog.json',
         'public/goal.json', 'public/policy.json', 'public/cost-policy.json', 'public/retention.json'}
OPTIONAL = {'bin/supervisor-probe.mjs'}


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def plain_file(path, limit=512 * 1024 * 1024):
    path = Path(path)
    if not path.is_absolute() or str(path.resolve()) != str(path):
        raise RuntimeError('Noncanonical or symbolic source path')
    for part in (path, *path.parents):
        if stat.S_ISLNK(part.lstat().st_mode):
            raise RuntimeError('Symbolic source path refused')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise RuntimeError('Expected a bounded regular file without hardlinks')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise RuntimeError('Source grew beyond bound')
            chunks.append(chunk)
        after = os.fstat(fd)
        if size != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise RuntimeError('Source changed while reading')
        return b''.join(chunks)
    finally:
        os.close(fd)


def staged_files(root):
    found = set()
    for current, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            path = Path(current) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise RuntimeError('Staged non-regular entry refused')
        found.update(str((Path(current) / name).relative_to(root)) for name in names)
    return found


def audit(manifest_path, expected_digest):
    raw = plain_file(manifest_path, 4 * 1024 * 1024)
    if sha(raw) != expected_digest:
        raise RuntimeError('Manifest digest mismatch')
    manifest = json.loads(raw)
    stage = manifest_path.parent
    if manifest.get('schemaVersion') != 'm0-control-install/1' or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', manifest.get('id', '')):
        raise RuntimeError('Unsupported installation manifest')
    final = BASE / 'm0-runs' / manifest['id']
    if manifest['finalRoot'] != str(final) or manifest['authSource'] != str(AUTH_SOURCE):
        raise RuntimeError('Unexpected installation or authentication root')
    files, seen = {}, set()
    for item in manifest['files']:
        relative = item['path']
        if not isinstance(relative, str) or str(PurePosixPath(relative)) != relative or relative.startswith('/') or '..' in PurePosixPath(relative).parts or relative in seen:
            raise RuntimeError('Invalid or duplicate manifest path')
        if relative not in FIXED | OPTIONAL and not relative.startswith('workspace/'):
            raise RuntimeError('Unrecognized destination')
        wanted_owner = 'worker' if relative.startswith('workspace/') else 'root'
        wanted_mode = 0o600 if wanted_owner == 'worker' else 0o555 if relative in {'bin/bun', 'bin/opencode', 'bin/worker-exec.py', 'bin/worker-supervisor.py'} else 0o444
        if item['owner'] != wanted_owner or item['mode'] != wanted_mode:
            raise RuntimeError('Unexpected ownership/mode request')
        contents = plain_file(stage / relative)
        if len(contents) != item['size'] or sha(contents) != item['digest']:
            raise RuntimeError('Staged file digest mismatch: ' + relative)
        files[relative] = item
        seen.add(relative)
    if not FIXED.issubset(seen) or staged_files(stage) != seen | {'manifest.json'}:
        raise RuntimeError('Missing or unmanifested staged files')
    if not re.fullmatch(r'[0-9a-f]{40}', manifest['baselineCommit']):
        raise RuntimeError('Missing real baseline commit')
    def pinned(relative):
        return {'path': str(final / relative), 'digest': files[relative]['digest']}
    template = manifest['specTemplate']
    if not re.fullmatch(r'run-[0-9a-f-]{36}', template.get('runId', '')):
        raise RuntimeError('Invalid run ID')
    expected = {'schemaVersion': 'm0-control-loop/1', 'jobId': manifest['id'], 'runId': template['runId'],
                'goal': pinned('public/goal.json'), 'source': pinned('public/source.ts'), 'tests': pinned('public/tests.json'),
                'executable': {**pinned('bin/opencode'), 'version': '1.18.35'}, 'bun': pinned('bin/bun'),
                'catalog': pinned('public/catalog.json'), 'wrapper': pinned('bin/worker-exec.py'),
                'workspace': str(final / 'workspace'), 'runtimeDirectory': str(final / 'runtime'),
                'controlDirectory': str(final / 'control'), 'authPath': str(final / 'control/auth.json'),
                'verifierCli': pinned('bin/verifier.mjs'), 'verifierConfigPath': str(SIGNER / 'config.json'),
                'verifierPublicKeyPath': str(final / 'control/verifier-public.pem')}
    if template != expected or manifest['source'] != pinned('public/source.ts'):
        raise RuntimeError('Spec template does not match fixed paths and file pins')
    goal = json.loads(plain_file(stage / 'public/goal.json', 1024 * 1024))
    if goal['taskId'] != manifest['id'] or goal['scope']['baseRevision'] != manifest['baselineCommit'] or goal['targetMatrix'] != [] or [x['id'] for x in goal['acceptance']] != ['M0-CODE-01']:
        raise RuntimeError('Goal scope mismatch')
    if goal['budgets'] != {'wallMinutes': 60, 'maxRepairCycles': 3, 'maxParallelWriters': 1}:
        raise RuntimeError('Unauthorized budget change')
    if files['public/source.ts']['digest'] != files['workspace/sumEvenThrough.ts']['digest']:
        raise RuntimeError('Baseline source mismatch')
    return manifest, files, goal


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, data, uid, gid, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(path.parent)


def json_new(path, value, uid=0, gid=0, mode=0o600):
    write_new(path, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode(), uid, gid, mode)


def protected_directory(path, uid=0, gid=0, mode=0o755, existing=False):
    if path.exists():
        info = path.lstat()
        if not existing or not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode:
            raise RuntimeError('Existing directory is not the exact protected directory: ' + str(path))
    else:
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
        os.chmod(path, mode)
        sync_directory(path.parent)


def install(manifest_path, expected_digest):
    if sys.platform != 'darwin' or os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError('Explicit macOS root execution required')
    os.umask(0o077)
    manifest, files, goal = audit(manifest_path, expected_digest)
    worker, signer = pwd.getpwnam('loopit-worker'), pwd.getpwnam('loopit-signer')
    if (worker.pw_uid, worker.pw_gid, signer.pw_uid, signer.pw_gid) != (420, 420, 421, 420):
        raise RuntimeError('Expected provisioned 420/421 identities and group 420')
    inventory = subprocess.run(['/bin/ps', '-axo', 'uid=,pid='], env=ENV, capture_output=True, timeout=5, check=True).stdout.decode()
    if any(int(line.split()[0]) in (420, 421) for line in inventory.splitlines() if line.split()):
        raise RuntimeError('Service identity still has processes; explicit recovery required')
    if (SIGNER / 'config.json').exists() or (SIGNER / 'key.pem').exists():
        raise RuntimeError('Existing signer configuration/key refused; no automatic replacement')
    final = Path(manifest['finalRoot'])
    if final.exists():
        raise RuntimeError('Existing run directory refused')
    # Read credentials only during explicit installation. Never log/return/store
    # the refresh token or write the source store. Failure does not refresh it.
    original_auth = plain_file(AUTH_SOURCE, 1024 * 1024)
    auth = json.loads(original_auth).get('openai', {})
    expires = auth.get('expires')
    if auth.get('type') != 'oauth' or not isinstance(auth.get('access'), str) or len(auth['access']) < 8 or not isinstance(expires, (int, float)) or not math.isfinite(expires) or expires < datetime.datetime.now().timestamp() * 1000 + 120000:
        raise RuntimeError('Existing access token is missing/expired; source refresh is not attempted')
    access_only = {'access': auth['access'], 'expiresAt': expires}
    if 'accountId' in auth:
        if not isinstance(auth['accountId'], str):
            raise RuntimeError('Invalid account reference')
        access_only['accountId'] = auth['accountId']
    protected_directory(BASE, existing=True)
    protected_directory(BASE / 'm0-runs', existing=True)
    protected_directory(final)
    for name, owner, group, mode in [('bin', 0, 0, 0o555), ('public', 0, 0, 0o555), ('control', 0, 0, 0o700), ('workspace', 420, 420, 0o700), ('runtime', 420, 420, 0o700)]:
        protected_directory(final / name, owner, group, mode)
    for name in ['home', 'config', 'data', 'cache', 'state', 'tmp']:
        protected_directory(final / 'runtime' / name, 420, 420, 0o700)
    for name in ['reports', 'runtime-state']:
        protected_directory(final / 'control' / name, 0, 0, 0o700)
    for relative, item in files.items():
        target = final / relative
        for parent in reversed(target.parents):
            if parent == final or final not in parent.parents:
                continue
            if not parent.exists():
                protected_directory(parent, 420 if relative.startswith('workspace/') else 0, 420 if relative.startswith('workspace/') else 0, 0o700 if relative.startswith('workspace/') else 0o555)
        data = plain_file(manifest_path.parent / relative)
        if len(data) != item['size'] or sha(data) != item['digest']:
            raise RuntimeError('Staged bytes changed after audit')
        owner = 420 if item['owner'] == 'worker' else 0
        write_new(target, data, owner, 420 if owner else 0, item['mode'])
    git = ['/usr/bin/git', '-C', str(final / 'workspace'), '-c', 'safe.directory=' + str(final / 'workspace'), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
    head = subprocess.run([*git, 'rev-parse', 'HEAD'], env=ENV, capture_output=True, timeout=10, check=True).stdout.decode().strip()
    original = subprocess.run([*git, 'show', 'HEAD:sumEvenThrough.ts'], env=ENV, capture_output=True, timeout=10, check=True).stdout
    if head != manifest['baselineCommit'] or sha(original) != manifest['source']['digest']:
        raise RuntimeError('Installed Git baseline does not match manifest')
    # Signer home is provisioned separately; do not change its ownership/mode.
    protected_directory(BASE / 'signer', 421, 420, 0o700, existing=True)
    protected_directory(SIGNER, 421, 420, 0o700, existing=True)
    for name in ['work', 'evidence', 'inbox']:
        protected_directory(SIGNER / name, 421, 420, 0o700, existing=True)
    key_program = """const { generateKeyPairSync, createHash } = require('node:crypto');
const fs = require('node:fs'); const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const fd = fs.openSync(process.argv[1], 'wx', 0o600);
try { fs.writeFileSync(fd, privateKey.export({type:'pkcs8',format:'pem'})); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
console.log(JSON.stringify({publicKey:publicKey.export({type:'spki',format:'pem'}),keyId:'sha256:'+createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')}));"""
    generated = subprocess.run([str(final / 'bin/bun'), '-e', key_program, str(SIGNER / 'key.pem')], env=ENV, capture_output=True, timeout=15)
    if generated.returncode:
        raise RuntimeError('Ed25519 key generation failed; partial installation retained')
    trust = json.loads(generated.stdout)
    os.chown(SIGNER / 'key.pem', 421, 420); os.chmod(SIGNER / 'key.pem', 0o600); sync_directory(SIGNER)
    write_new(final / 'control/verifier-public.pem', trust['publicKey'].encode(), 0, 0, 0o400)
    json_new(final / 'control/auth.json', access_only)
    spec = {**manifest['specTemplate'], 'verifierKeyId': trust['keyId']}
    binding = {'projectId': goal['projectId'], 'taskId': goal['taskId'], 'goalRevision': goal['goalRevision'], 'runId': spec['runId'],
               'goalDigest': sha(canonical(goal)), 'sourceDigest': spec['source']['digest'], 'acceptanceDigest': sha(canonical(goal['acceptance'])), 'criterionIds': ['M0-CODE-01']}
    def pinned(relative):
        return {'path': str(final / relative), 'digest': files[relative]['digest']}
    config = {'schemaVersion': 'm0-verifier-config/1', 'verifierId': 'loopit-signer', 'signerUid': 421, 'builderUid': 420,
              'inboxRoot': str(SIGNER / 'inbox'), 'workRoot': str(SIGNER / 'work'), 'evidenceRoot': str(SIGNER / 'evidence'),
              'runtime': spec['bun'], 'runner': pinned('public/runner.mjs'), 'tests': spec['tests'], 'source': spec['source'], 'goal': spec['goal'],
              'privateKeyPath': str(SIGNER / 'key.pem'), 'keyId': trust['keyId'], 'binding': binding}
    json_new(SIGNER / 'config.json', config, 421, 420, 0o600)
    spec['verifierConfigDigest'] = sha(plain_file(SIGNER / 'config.json'))
    json_new(final / 'control/spec.json', spec)
    if plain_file(AUTH_SOURCE, 1024 * 1024) != original_auth:
        raise RuntimeError('Original authentication store changed concurrently; installation not marked ready')
    json_new(final / 'control/install-manifest.json', manifest)
    receipt = {'schemaVersion': 'm0-control-install-receipt/1', 'status': 'installed-not-executed', 'manifestDigest': expected_digest,
               'root': str(final), 'specPath': str(final / 'control/spec.json'), 'baselineCommit': head, 'fileCount': len(files),
               'keyId': trust['keyId'], 'originalAuthUnchanged': True, 'refreshTokenCopied': False, 'modelCalls': 0,
               'scope': 'Installation only; no Supervisor/controller/model invocation or OS conformance claim'}
    json_new(final / 'control/install-receipt.json', receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', args.sha256):
        raise RuntimeError('Expected exact sha256: manifest digest')
    manifest_path = args.manifest.absolute()
    manifest, files, _ = audit(manifest_path, args.sha256)
    result = install(manifest_path, args.sha256) if args.apply else {'status': 'audited-not-installed', 'fileCount': len(files),
        'manifestDigest': args.sha256, 'finalRoot': manifest['finalRoot'], 'administratorActions': 0, 'credentialsRead': False, 'modelCalls': 0}
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print command output or authentication/key data from an exception.
        print(json.dumps({'status': 'blocked', 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          'note': 'No automatic cleanup/retry of a partial installation; inspect before reuse.'}))
        sys.exit(2)
