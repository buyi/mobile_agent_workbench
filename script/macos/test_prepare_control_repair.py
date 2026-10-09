"""Unprivileged protocol tests: real files/hashes/flocks/rename/fsync, mocked
OS identities and process inventory. No installed state or service UID touched.
"""
import datetime
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


repair = load('repair_under_test', 'prepare-control-repair.py')
fixtures = load('repair_update_test_fixture', 'test_update_control_loop.py')


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.UpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.u = fixtures.update
        self.control = self.fixture.control
        self.signer = self.fixture.root / 'signer/m0-verifier'
        self.signer.mkdir(parents=True)
        self.prior, self.following = 'run-old', 'run-repair-one'
        self.goal = {'projectId': 'project', 'taskId': 'task', 'goalRevision': 1, 'budgets': {'maxRepairCycles': 3}}
        self.budget = {'deadlineAt': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                       'repairIndex': 0, 'maxRepairs': 3}
        (self.control / 'execution-budget.json').write_bytes(self.u.encoded(self.budget))
        public = self.fixture.final / 'public'; public.mkdir()
        def pin(name, data):
            path = public / name; path.write_bytes(data)
            return {'path': str(path), 'digest': self.u.sha(data)}
        self.fixture.spec.update(runId=self.prior, goal=pin('goal.json', self.u.encoded(self.goal)),
                                 source=pin('source.ts', b'untouched source'), tests=pin('tests.json', b'{}'),
                                 verifierConfigPath=str(self.signer / 'config.json'), verifierKeyId='key-unchanged')
        self.binding = {'projectId': 'project', 'taskId': 'task', 'goalRevision': 1, 'runId': self.prior,
                        'goalDigest': self.u.sha(b'frozen goal'), 'sourceDigest': self.fixture.spec['source']['digest']}
        self.config = {'schemaVersion': 'm0-verifier-config/1', 'verifierId': 'loopit-signer', 'signerUid': 421, 'builderUid': 420,
                       'keyId': 'key-unchanged', 'binding': self.binding,
                       **{key: self.fixture.spec[key] for key in ('goal', 'source', 'tests')}}
        (self.signer / 'config.json').write_bytes(self.u.encoded(self.config))
        self.fixture.spec['verifierConfigDigest'] = self.u.sha(self.u.encoded(self.config))
        self.write_spec()
        self.fixture.active.update(workerGid=420, signerGid=420)
        for key, uid, name in [('stopProof', 420, 'loopit-worker'), ('signerStopProof', 421, 'loopit-signer')]:
            self.fixture.active[key] = {'schemaVersion': 'worker-stop-proof/1', 'scopeId': 'test-scope', 'generation': 1,
                'workerUid': 420, 'observedUid': uid, 'observedGid': 420, 'serviceAccount': name,
                'noLiveWorkerProcesses': True, 'userDomainAbsent': True, 'externalActionsVerified': False,
                'observations': [{'processes': [], 'userDomainPresent': False} for _ in range(3)]}
        (self.fixture.state / 'active.json').write_bytes(self.u.encoded(self.fixture.active))
        self.reports = self.control / 'reports'; self.reports.mkdir()
        run = {'runId': self.prior, 'goalRevision': 1, 'status': 'failed'}
        self.result = {'schemaVersion': 'm0-control-loop-result/1', 'status': 'failed', 'binding': self.binding,
            'eventReplayMatches': True, 'run': {**run, 'taskId': 'task'}, 'task': {'currentRevision': 1, 'runs': {self.prior: run},
            'revisions': {'1': {'goal': self.goal, 'goalDigest': self.binding['goalDigest'], 'frozen': True, 'status': 'active', 'runIds': [self.prior]}}}}
        self.execution = {'binding': self.binding, 'dispatch': {'runId': self.prior, 'goalDigest': self.binding['goalDigest'], 'input': {'executionBudget': self.budget}}}
        self.write_reports()
        # Sentinels are never opened for mutation by the repair protocol.
        self.untouched = {self.control / 'delivery.sqlite': b'database sentinel', self.signer / 'key.pem': b'nonsecret key sentinel',
                          self.control / 'auth.json': b'nonsecret auth sentinel', self.fixture.final / 'workspace/candidate.ts': b'candidate sentinel'}
        for path, value in self.untouched.items():
            path.parent.mkdir(exist_ok=True); path.write_bytes(value)
        self.patches = [patch.object(repair, 'update', self.u), patch.object(repair, 'SIGNER', self.signer),
                        patch.object(repair, 'signer_config', side_effect=lambda: self.u.regular(self.signer / 'config.json'))]
        for item in self.patches:
            item.start(); self.addCleanup(item.stop)

    def write_spec(self):
        (self.control / 'spec.json').write_bytes(self.u.encoded(self.fixture.spec))

    def write_reports(self):
        (self.reports / 'result.json').write_bytes(self.u.encoded(self.result))
        (self.reports / 'execution.json').write_bytes(self.u.encoded(self.execution))
        (self.reports / 'native.jsonl').write_bytes(b'{"type":"fixture"}\n')

    def call(self, apply=True, expected_spec=None):
        return self.fixture.unprivileged_mutation(lambda: repair.run(self.prior, self.following,
            expected_spec or self.u.sha((self.control / 'spec.json').read_bytes()),
            self.u.sha((self.control / 'install-receipt.json').read_bytes()), apply))

    def test_real_archive_budget_and_two_run_bindings_preserve_other_bytes(self):
        old_spec = (self.control / 'spec.json').read_bytes()
        old_config = (self.signer / 'config.json').read_bytes()
        old_result = (self.reports / 'result.json').read_bytes()
        old_active = (self.fixture.state / 'active.json').read_bytes()
        # Also prove the publishing path explicitly applies signer ownership.
        with patch.object(repair.os, 'fchown') as owner:
            # Fixture patches the same os module, so capture the ownership call
            # at the function boundary while keeping actual file writes real.
            original = repair.replace_signer_config
            owners = []
            def publish(data):
                with patch.object(repair.os, 'fchown', side_effect=lambda fd, uid, gid: owners.append((uid, gid))):
                    original(data)
            with patch.object(repair, 'replace_signer_config', side_effect=publish):
                outcome = self.call()
        self.assertIn((421, 420), owners)
        self.assertEqual(outcome['status'], 'prepared-not-executed')
        archive = self.control / 'run-history' / self.prior
        self.assertEqual((archive / 'reports/result.json').read_bytes(), old_result)
        self.assertEqual((archive / 'spec.before.json').read_bytes(), old_spec)
        self.assertEqual((archive / 'verifier-config.before.json').read_bytes(), old_config)
        self.assertEqual(list(self.reports.iterdir()), [])
        self.assertEqual((self.fixture.state / 'active.json').read_bytes(), old_active)
        authorization = json.loads((self.control / 'repair-authorization.json').read_bytes())
        self.assertEqual(authorization['budgetBefore'], self.budget)
        self.assertEqual(authorization['budgetAfter'], {**self.budget, 'repairIndex': 1})
        self.assertEqual(authorization['priorResultDigest'], self.u.sha(old_result))
        self.assertEqual(authorization['firstDeadline'], self.budget['deadlineAt'])
        new_spec = json.loads((self.control / 'spec.json').read_bytes())
        new_config_raw = (self.signer / 'config.json').read_bytes()
        self.assertEqual(new_spec['runId'], self.following)
        self.assertEqual(json.loads(new_config_raw)['binding']['runId'], self.following)
        self.assertEqual(new_spec['verifierConfigDigest'], self.u.sha(new_config_raw))
        self.assertEqual(json.loads((self.control / 'install-receipt.json').read_bytes())['specDigest'], self.u.sha(self.u.encoded(new_spec)))
        self.assertEqual((self.signer / 'config.json').stat().st_mode & 0o777, 0o600)
        for path, value in self.untouched.items(): self.assertEqual(path.read_bytes(), value)

    def test_audit_is_read_only_and_wrong_pin_or_result_refuses(self):
        before = sorted(str(path) for path in self.fixture.root.rglob('*'))
        self.assertEqual(self.call(apply=False)['status'], 'audited-not-applied')
        self.assertEqual(before, sorted(str(path) for path in self.fixture.root.rglob('*')))
        with self.assertRaisesRegex(RuntimeError, 'pin changed'): self.call(expected_spec='sha256:' + '0' * 64)
        for change in [lambda: self.result.update(status='passed'),
                       lambda: self.result['run'].update(taskId='other'),
                       lambda: self.result['task']['revisions']['1'].update(goal={**self.goal, 'taskId': 'other'})]:
            original = json.loads(json.dumps(self.result)); change(); self.write_reports()
            with self.assertRaisesRegex(RuntimeError, 'failed Run'): self.call()
            self.result = original
        self.assertFalse((self.control / 'run-history').exists())

    def test_expired_reset_or_exhausted_budget_never_mutates(self):
        for value in [{**self.budget, 'deadlineAt': '2020-01-01T00:00:00.000Z'}, {**self.budget, 'repairIndex': 3},
                      {**self.budget, 'deadlineAt': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=31)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}]:
            (self.control / 'execution-budget.json').write_bytes(self.u.encoded(value))
            with self.assertRaises(RuntimeError): self.call()
            self.assertFalse((self.control / 'run-history').exists())

    def test_stop_proof_domain_or_live_inventory_failure_is_closed(self):
        self.fixture.active['signerStopProof']['userDomainAbsent'] = False
        (self.fixture.state / 'active.json').write_bytes(self.u.encoded(self.fixture.active))
        with self.assertRaisesRegex(RuntimeError, 'stop proofs'): self.call()
        self.assertFalse((self.control / 'run-history').exists())

    def test_partial_publish_stays_maintenance_without_overwriting_history(self):
        old_result = (self.reports / 'result.json').read_bytes()
        original = self.u.replace
        def fail(path, data, mode=0o600):
            if path == self.control / 'spec.json': raise RuntimeError('injected spec write failure')
            return original(path, data, mode)
        with patch.object(self.u, 'replace', side_effect=fail), self.assertRaisesRegex(RuntimeError, 'injected'):
            self.call()
        active = json.loads((self.fixture.state / 'active.json').read_bytes())
        self.assertEqual(active['phase'], 'maintenance')
        self.assertIsNone(active['workerUid']); self.assertIsNone(active['signerUid'])
        archive = self.control / 'run-history' / self.prior
        self.assertEqual((archive / 'reports/result.json').read_bytes(), old_result)
        with self.assertRaises(RuntimeError): self.call()
        self.assertEqual((archive / 'reports/result.json').read_bytes(), old_result)

    def test_existing_history_and_symlink_report_refused(self):
        archive = self.control / 'run-history' / self.prior
        archive.mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, 'history already exists'): self.call()
        archive.rmdir(); archive.parent.rmdir()
        (self.reports / 'native.jsonl').unlink()
        (self.reports / 'native.jsonl').symlink_to(self.control / 'auth.json')
        with self.assertRaisesRegex(RuntimeError, 'Symbolic report'): self.call()
        self.assertFalse((self.control / 'run-history').exists())

    def test_three_repairs_share_first_deadline_and_fourth_is_refused(self):
        first_deadline = self.budget['deadlineAt']
        old_reports = {}
        for index in range(1, 4):
            old_reports[self.prior] = (self.reports / 'result.json').read_bytes()
            outcome = self.call()
            self.assertEqual(outcome['repairIndex'], index)
            self.assertEqual(outcome['deadlineAt'], first_deadline)
            self.prior = self.following
            self.following = 'run-repair-' + str(index + 1)
            self.binding = json.loads((self.signer / 'config.json').read_bytes())['binding']
            self.budget = json.loads((self.control / 'execution-budget.json').read_bytes())
            run = {'runId': self.prior, 'goalRevision': 1, 'status': 'failed'}
            self.result['binding'] = self.binding
            self.result['run'] = {**run, 'taskId': 'task'}
            self.result['task']['runs'][self.prior] = run
            self.result['task']['revisions']['1']['runIds'].append(self.prior)
            self.execution = {'binding': self.binding, 'dispatch': {'runId': self.prior,
                'goalDigest': self.binding['goalDigest'], 'input': {'executionBudget': self.budget}}}
            self.write_reports()
        with self.assertRaisesRegex(RuntimeError, 'repair limit exhausted'): self.call()
        for run_id, expected in old_reports.items():
            self.assertEqual((self.control / 'run-history' / run_id / 'reports/result.json').read_bytes(), expected)

    def test_signer_publication_failure_never_restores_admission(self):
        with patch.object(repair, 'replace_signer_config', side_effect=RuntimeError('signer ownership failed')):
            with self.assertRaisesRegex(RuntimeError, 'signer ownership'): self.call()
        active = json.loads((self.fixture.state / 'active.json').read_bytes())
        self.assertEqual(active['phase'], 'maintenance')
        self.assertIsNone(active['signerUid'])
        self.assertEqual(json.loads((self.control / 'spec.json').read_bytes())['runId'], self.prior)
        self.assertEqual((self.signer / 'config.json').read_bytes(), self.u.encoded(self.config))

    def test_cli_inputs_do_not_accept_path_escape_or_reuse(self):
        for prior, following in [('../escape', 'next'), ('old', '/next'), ('same', 'same')]:
            with self.assertRaises(RuntimeError): repair.arguments(prior, following, 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64)


if __name__ == '__main__':
    unittest.main()
