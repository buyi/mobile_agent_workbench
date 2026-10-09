"""Nonprivileged update protocol tests. OS ownership is covered by root probes.

Mutation tests only relax UID/path trust checks in an imported module; the CLI
has no such override. Files, hashes, locks, replacements and failure state are real.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('update-control-loop.py')
specification = importlib.util.spec_from_file_location('update_control_loop', SOURCE)
update = importlib.util.module_from_spec(specification)
specification.loader.exec_module(update)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loopit-update-test-', dir='/private/tmp')
        self.root = Path(self.temp.name)
        self.final = self.root / 'm0-code-loop-20261009a'
        self.control = self.final / 'control'
        self.state = self.root / 'supervisor'
        self.stage = self.root / 'stage'
        for path in [self.final / 'bin', self.control, self.state, self.stage]:
            path.mkdir(parents=True, exist_ok=True)
        self.originals = {relative: ('original ' + relative).encode() for relative in update.ASSETS}
        self.pins = {relative: update.sha(data) for relative, data in self.originals.items()}
        for relative, data in self.originals.items():
            (self.final / relative).write_bytes(data)
        self.spec = {'schemaVersion': 'm0-control-loop/1', 'jobId': self.final.name,
                     'controlDirectory': str(self.control), 'authPath': str(self.control / 'auth.json'),
                     'wrapper': {'path': str(self.final / 'bin/worker-exec.py'), 'digest': self.pins['bin/worker-exec.py']},
                     'verifierCli': {'path': str(self.final / 'bin/verifier.mjs'), 'digest': self.pins['bin/verifier.mjs']},
                     'verifierConfigDigest': 'unchanged-config-pin', 'budget': 'unchanged'}
        manifest_raw = update.encoded({'id': self.final.name, 'finalRoot': str(self.final),
            'files': [{'path': path, 'digest': value} for path, value in self.pins.items()]})
        self.receipt = {'root': str(self.final), 'specPath': str(self.control / 'spec.json'),
                        'manifestDigest': update.sha(manifest_raw)}
        self.spec_raw, self.receipt_raw = update.encoded(self.spec), update.encoded(self.receipt)
        (self.control / 'spec.json').write_bytes(self.spec_raw)
        (self.control / 'install-receipt.json').write_bytes(self.receipt_raw)
        (self.control / 'install-manifest.json').write_bytes(manifest_raw)
        proof = {'scopeId': 'test-scope', 'generation': 1, 'noLiveWorkerProcesses': True}
        self.active = {'phase': 'stopped', 'admissionDeadline': 0, 'workerUid': 420, 'signerUid': 421,
                       'scopeId': 'test-scope', 'generation': 1, 'stopProof': proof, 'signerStopProof': proof}
        (self.state / 'active.json').write_bytes(update.encoded(self.active))
        for name in ['ownership.lock', 'launch.lock']:
            (self.state / name).touch()
        self.plan = {'schemaVersion': 'm0-control-update/1', 'revisionId': 'repair-one', 'finalRoot': str(self.final),
                     'previousSpecDigest': update.sha(self.spec_raw), 'previousInstallReceiptDigest': update.sha(self.receipt_raw),
                     'files': []}
        for path in ['bin/controller.mjs', 'bin/worker-exec.py']:
            new = ('replacement ' + path).encode()
            (self.stage / Path(path).name).write_bytes(new)
            self.plan['files'].append({'path': path, 'source': Path(path).name, 'oldDigest': self.pins[path],
                                       'newDigest': update.sha(new), 'size': len(new)})
        self.plan_path = self.stage / 'plan.json'
        self.persist()
        self.path_patch = patch.multiple(update, FINAL=self.final, STATE=self.state)
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temp.cleanup()

    def persist(self):
        self.plan_path.write_bytes(update.encoded(self.plan))
        return update.sha(self.plan_path.read_bytes())

    def unprivileged_mutation(self, callback):
        original_regular = update.regular
        def relaxed(path, limit=128 * 1024 * 1024, protected=False, mode=None):
            return original_regular(path, limit)
        # Only protected-owner checks are replaced. Normal fd writes, flock,
        # fsync, exclusive creation and os.replace still execute in this tempdir.
        def lock(name):
            fd = os.open(self.state / name, os.O_RDONLY)
            update.fcntl.flock(fd, update.fcntl.LOCK_EX | update.fcntl.LOCK_NB)
            return fd
        with patch.object(update, 'regular', relaxed), patch.object(update, 'directory'), \
             patch.object(update, 'acquire', lock), patch.object(update, 'no_live_services'), \
             patch.object(update.os, 'fchown'), patch.object(update.os, 'getuid', return_value=0), \
             patch.object(update.os, 'geteuid', return_value=0):
            return callback()

    def test_plan_pins_and_whitelist(self):
        plan, _, files = update.audit_plan(self.plan_path, self.persist())
        self.assertEqual(len(files), 2)
        self.assertEqual(plan['revisionId'], 'repair-one')
        with self.assertRaisesRegex(RuntimeError, 'Plan digest'):
            update.audit_plan(self.plan_path, 'sha256:' + '0' * 64)
        self.plan['files'][0]['path'] = 'public/goal.json'
        with self.assertRaisesRegex(RuntimeError, 'non-whitelisted'):
            update.audit_plan(self.plan_path, self.persist())

    def test_source_tamper_symlink_and_duplicate(self):
        digest = self.persist()
        source = self.stage / 'controller.mjs'
        source.write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
            update.audit_plan(self.plan_path, digest)
        source.unlink(); source.symlink_to(self.final / 'bin/controller.mjs')
        with self.assertRaisesRegex(RuntimeError, 'symbolic'):
            update.audit_plan(self.plan_path, digest)
        source.unlink(); source.write_text('replacement bin/controller.mjs')
        self.plan['files'].append(dict(self.plan['files'][0]))
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            update.audit_plan(self.plan_path, self.persist())

    def test_default_read_only_and_refresh_requires_apply(self):
        before = sorted(str(path) for path in self.root.rglob('*'))
        with patch.object(update.os, 'getuid', return_value=501):
            result = update.run(self.plan_path, self.persist())
            self.assertEqual(result['status'], 'staged-plan-audited')
            with self.assertRaisesRegex(RuntimeError, 'requires explicit'):
                update.run(self.plan_path, self.persist(), refresh=True)
        self.assertEqual(before, sorted(str(path) for path in self.root.rglob('*')))

    def test_real_replacements_backups_and_spec_only_updates_code(self):
        digest = self.persist()
        result = self.unprivileged_mutation(lambda: update.run(self.plan_path, digest, apply=True))
        self.assertEqual(result['status'], 'applied-not-executed')
        revision = self.control / 'revisions/repair-one'
        self.assertEqual((revision / 'spec.before.json').read_bytes(), self.spec_raw)
        self.assertEqual((revision / 'install-receipt.before.json').read_bytes(), self.receipt_raw)
        for relative, original in self.originals.items():
            self.assertEqual((revision / Path(relative).name).read_bytes(), original)
        expected = json.loads(self.spec_raw)
        expected['wrapper']['digest'] = self.plan['files'][1]['newDigest']
        self.assertEqual(json.loads((self.control / 'spec.json').read_bytes()), expected)
        self.assertEqual(json.loads((self.state / 'active.json').read_bytes())['phase'], 'stopped')
        self.assertFalse((self.control / 'auth.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'pin changed'):
            self.unprivileged_mutation(lambda: update.run(self.plan_path, digest, apply=True))

    def test_interrupted_replace_remains_maintenance_and_cannot_retry(self):
        original_replace = update.replace
        def fail_at_asset(path, data, mode=0o600):
            if path == self.final / 'bin/worker-exec.py':
                raise RuntimeError('simulated disk failure')
            return original_replace(path, data, mode)
        with patch.object(update, 'replace', fail_at_asset):
            with self.assertRaisesRegex(RuntimeError, 'simulated disk failure'):
                self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))
        self.assertEqual(json.loads((self.state / 'active.json').read_bytes())['phase'], 'maintenance')
        self.assertIsNone(json.loads((self.state / 'active.json').read_bytes())['workerUid'])
        self.assertIsNone(json.loads((self.state / 'active.json').read_bytes())['signerUid'])
        self.assertEqual((self.control / 'revisions/repair-one/controller.mjs').read_bytes(), self.originals['bin/controller.mjs'])
        with self.assertRaisesRegex(RuntimeError, 'protected ledger'):
            self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))

    def test_second_revision_uses_current_receipt_and_keeps_first_history(self):
        first = self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))
        first_receipt = (self.control / 'install-receipt.json').read_bytes()
        first_spec = (self.control / 'spec.json').read_bytes()
        self.plan.update(revisionId='repair-two', previousSpecDigest=update.sha(first_spec),
                         previousInstallReceiptDigest=update.sha(first_receipt))
        entry = dict(self.plan['files'][0])
        newer = b'second controller replacement'
        (self.stage / entry['source']).write_bytes(newer)
        entry.update(oldDigest=first['codeAssetDigests'][entry['path']], newDigest=update.sha(newer), size=len(newer))
        self.plan['files'] = [entry]
        second = self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))
        self.assertEqual(second['codeAssetDigests']['bin/controller.mjs'], update.sha(newer))
        self.assertEqual(second['codeAssetDigests']['bin/worker-exec.py'], first['codeAssetDigests']['bin/worker-exec.py'])
        self.assertEqual((self.control / 'revisions/repair-two/install-receipt.before.json').read_bytes(), first_receipt)
        self.assertEqual((self.control / 'revisions/repair-one/install-receipt.before.json').read_bytes(), self.receipt_raw)
        self.assertEqual((self.control / 'revisions/repair-one/spec.before.json').read_bytes(), self.spec_raw)

    def test_unknown_old_hash_or_active_scope_denies_before_writes(self):
        self.plan['files'][0]['oldDigest'] = 'sha256:' + '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'old pin'):
            self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))
        self.plan['files'][0]['oldDigest'] = self.pins['bin/controller.mjs']
        (self.state / 'active.json').write_bytes(update.encoded({**self.active, 'phase': 'running'}))
        with self.assertRaisesRegex(RuntimeError, 'not stopped'):
            self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))
        self.assertFalse((self.control / 'revisions').exists())

    def test_unlisted_asset_and_manifest_drift_is_rejected(self):
        altered = b'changed outside requested replacement'
        relative = 'bin/verifier.mjs'
        (self.final / relative).write_bytes(altered)
        manifest_path = self.control / 'install-manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        next(item for item in manifest['files'] if item['path'] == relative)['digest'] = update.sha(altered)
        manifest_path.write_bytes(update.encoded(manifest))
        with self.assertRaisesRegex(RuntimeError, 'manifest differs'):
            self.unprivileged_mutation(lambda: update.run(self.plan_path, self.persist(), apply=True))
        self.assertFalse((self.control / 'revisions').exists())

    def test_process_inventory_fails_closed(self):
        for output in [b'10 420 420 S\n', b'10 0 421 S\n', b'invalid\n']:
            result = subprocess.CompletedProcess([], 0, output)
            with patch.object(update.subprocess, 'run', return_value=result), self.assertRaises(RuntimeError):
                update.no_live_services()
        with patch.object(update.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'10 420 420 Z\n')):
            update.no_live_services()

    def test_access_copy_never_contains_refresh_or_changes_source(self):
        auth = self.root / 'original-auth.json'
        original = update.encoded({'openai': {'type': 'oauth', 'access': 'fake-test-only-access',
            'refresh': 'fake-test-only-refresh', 'expires': 9999999999999, 'accountId': 'fixture'}})
        auth.write_bytes(original)
        with patch.object(update, 'AUTH_SOURCE', auth):
            source, copied = update.access_only()
        self.assertEqual(source, original)
        self.assertEqual(auth.read_bytes(), original)
        self.assertEqual(set(json.loads(copied)), {'access', 'expiresAt', 'accountId'})
        self.assertNotIn(b'refresh', copied)

    def test_legacy_identity_check_also_refuses_maintenance(self):
        source = SOURCE.with_name('worker-supervisor.py')
        module_spec = importlib.util.spec_from_file_location('supervisor_for_update_test', source)
        supervisor = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(supervisor)
        def account(name):
            return SimpleNamespace(pw_uid=420 if name == 'loopit-worker' else 421,
                                   pw_gid=420, pw_shell='/usr/bin/false')
        maintenance = {**self.active, 'phase': 'maintenance', 'workerUid': None, 'signerUid': None,
                       'workerGid': 420, 'signerGid': 420}
        # scope_identities predates the explicit maintenance-phase guard. This
        # protects the crash window before the old Supervisor is replaced.
        with patch.object(supervisor.pwd, 'getpwnam', side_effect=account):
            with self.assertRaisesRegex(RuntimeError, 'UID/GID changed'):
                supervisor.scope_identities(maintenance)


if __name__ == '__main__':
    unittest.main()
