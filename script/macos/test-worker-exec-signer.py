"""No privilege or process execution: test the fixed Signer launch contract."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('worker-exec.py')
definition = importlib.util.spec_from_file_location('signer_launcher_test', source)
launcher = importlib.util.module_from_spec(definition)
definition.loader.exec_module(launcher)


class SignerLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loopit-signer-launch-', dir='/private/tmp')
        self.job = Path(self.temp.name)
        (self.job / 'bin').mkdir(); (self.job / 'control').mkdir()
        self.bun, self.verifier = self.job / 'bin/bun', self.job / 'bin/verifier.mjs'
        self.bun.write_bytes(b'fake binary for no-exec tests')
        self.verifier.write_bytes(b'fake verifier for no-exec tests')
        pin = lambda path: {'path': str(path), 'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
        self.spec = {'schemaVersion': 'm0-control-loop/1', 'jobId': self.job.name,
                     'controlDirectory': str(self.job / 'control'), 'bun': pin(self.bun), 'verifierCli': pin(self.verifier)}
        self.save()
        self.patchers = [patch.object(launcher, 'SIGNER_JOB', self.job),
                         patch.object(launcher.os, 'getuid', return_value=0), patch.object(launcher.os, 'geteuid', return_value=0),
                         patch.object(launcher.pwd, 'getpwnam', side_effect=lambda name: SimpleNamespace(
                             pw_uid=420 if name == 'loopit-worker' else 421, pw_gid=420, pw_shell='/usr/bin/false'))]
        for item in self.patchers:
            item.start()

    def tearDown(self):
        for item in reversed(self.patchers):
            item.stop()
        self.temp.cleanup()

    def save(self):
        (self.job / 'control/spec.json').write_text(json.dumps(self.spec))

    def command(self, uid=421, gid=420, command=None):
        # Trust checks are tested separately; only replace UID ownership here.
        with patch.object(launcher, 'root_file_bytes', side_effect=lambda path, limit: path.read_bytes()):
            return launcher.signer_verifier_command(uid, gid, command or [])

    def test_only_fixed_bun_and_verifier_without_extra_arguments(self):
        self.assertEqual(self.command(), [str(self.bun), str(self.verifier)])
        for uid, gid, tail in [(420, 420, []), (421, 0, []), (0, 0, []), (421, 420, ['/bin/sh'])]:
            with self.assertRaisesRegex(RuntimeError, 'Only the fixed Signer'):
                self.command(uid, gid, tail)

    def test_tampered_binaries_and_arbitrary_path_are_rejected(self):
        self.verifier.write_bytes(b'modified')
        with self.assertRaisesRegex(RuntimeError, 'pin changed'):
            self.command()
        self.spec['verifierCli']['path'] = '/bin/sh'; self.save()
        with self.assertRaisesRegex(RuntimeError, 'path is not fixed'):
            self.command()

    def test_wrong_job_cannot_supply_other_verifier(self):
        self.spec['jobId'] = 'another-job'; self.save()
        with self.assertRaisesRegex(RuntimeError, 'Unexpected fixed Signer'):
            self.command()

    def test_root_protection_and_symlink_checks_are_real(self):
        # Real filesystem ownership: current operator-owned fixture is forbidden.
        with self.assertRaisesRegex(RuntimeError, 'root protected'):
            launcher.root_file_bytes(self.bun, 1024)
        link = self.job / 'link'; link.symlink_to(self.bun)
        with self.assertRaisesRegex(RuntimeError, 'canonical'):
            launcher.root_file_bytes(link, 1024)

    def test_signer_requires_finalizing_phase_and_current_generation(self):
        scope = {'scopeId': 'scope', 'generation': 2, 'phase': 'finalizing',
                 'signerUid': 421, 'signerGid': 420, 'admissionDeadline': time.time() + 30}
        self.assertGreater(launcher.validate_admission(scope, 'scope', 2, 421, 420), time.time())
        for altered, generation in [({**scope, 'phase': 'running'}, 2), (scope, 1), ({**scope, 'phase': 'stopped'}, 2)]:
            with self.assertRaises(RuntimeError):
                launcher.validate_admission(altered, 'scope', generation, 421, 420)

    def test_main_uses_admitted_drop_and_clean_environment(self):
        env = {'LOOPIT_SCOPE_ID': 'scope', 'LOOPIT_GENERATION': '2', 'BUN_OPTIONS': '--preload=/evil',
               'NODE_OPTIONS': '--require=/evil', 'DYLD_INSERT_LIBRARIES': '/evil', 'SECRET': 'test-only'}
        with patch.dict(os.environ, env), patch.object(sys, 'argv', ['worker-exec.py', '--uid', '421', '--gid', '420', '--signer-verifier']), \
             patch.object(launcher, 'root_file_bytes', side_effect=lambda path, limit: path.read_bytes()), \
             patch.object(launcher, 'close_inherited_descriptors') as close, patch.object(launcher, 'admitted_drop') as admission, \
             patch.object(launcher.os, 'execve') as execute:
            launcher.main()
        close.assert_called_once()
        admission.assert_called_once_with(421, 420, 'scope', 2)
        command, arguments, actual_env = execute.call_args.args
        self.assertEqual(command, str(self.bun)); self.assertEqual(arguments, [str(self.bun), str(self.verifier)])
        self.assertEqual(actual_env, launcher.signer_environment())
        self.assertFalse(set(env) & set(actual_env))

    def test_admission_failure_never_executes_even_with_valid_pins(self):
        with patch.dict(os.environ, {'LOOPIT_SCOPE_ID': 'scope', 'LOOPIT_GENERATION': '2'}), \
             patch.object(sys, 'argv', ['worker-exec.py', '--uid', '421', '--gid', '420', '--signer-verifier']), \
             patch.object(launcher, 'root_file_bytes', side_effect=lambda path, limit: path.read_bytes()), \
             patch.object(launcher, 'close_inherited_descriptors'), patch.object(launcher, 'admitted_drop', side_effect=RuntimeError('closed')), \
             patch.object(launcher.os, 'execve') as execute:
            with self.assertRaisesRegex(RuntimeError, 'closed'):
                launcher.main()
        execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
