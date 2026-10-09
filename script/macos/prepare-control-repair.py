#!/usr/bin/env python3
"""Prepare one explicit repair of the fixed M0 job; never create a DB Run.

Default is audit. --apply requires macOS root and exact current spec/receipt
pins. A failed mutation retains maintenance with null service UIDs; repair is
manual, never an automatic retry. No model, account, key or credential action.
"""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

sys.dont_write_bytecode = True
_loader = importlib.util.spec_from_file_location('control_repair_update_helpers', Path(__file__).with_name('update-control-loop.py'))
update = importlib.util.module_from_spec(_loader)
_loader.loader.exec_module(update)
SIGNER = Path('/private/var/loopit/signer/m0-verifier')
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}')


def arguments(prior, following, expected_spec, expected_receipt):
    if not all(isinstance(value, str) and ID.fullmatch(value) for value in (prior, following)) or prior == following:
        raise RuntimeError('Distinct exact prior/next Run IDs are required')
    if not update.digest(expected_spec) or not update.digest(expected_receipt):
        raise RuntimeError('Exact installed spec and receipt SHA-256 pins are required')


def stop_authority(active):
    if (active.get('workerUid'), active.get('workerGid'), active.get('signerUid'), active.get('signerGid')) != (420, 420, 421, 420):
        raise RuntimeError('Stopped scope service identity changed')
    if not isinstance(active.get('scopeId'), str) or type(active.get('generation')) is not int or active['generation'] < 1:
        raise RuntimeError('Stopped scope identity missing')
    for field, uid, name in [('stopProof', 420, 'loopit-worker'), ('signerStopProof', 421, 'loopit-signer')]:
        proof = active.get(field, {})
        if (proof.get('schemaVersion') != 'worker-stop-proof/1' or proof.get('scopeId') != active['scopeId'] or
                proof.get('generation') != active['generation'] or proof.get('serviceAccount') != name or
                proof.get('workerUid') != 420 or proof.get('observedUid') != uid or proof.get('observedGid') != 420 or
                proof.get('noLiveWorkerProcesses') is not True or proof.get('userDomainAbsent') is not True or
                proof.get('externalActionsVerified') is not False):
            raise RuntimeError('Both service accounts require matching local stop proofs')
        observations = proof.get('observations')
        if not isinstance(observations, list) or len(observations) < 3:
            raise RuntimeError('Stop proof lacks three observations')
        for observation in observations[-3:]:
            if (not isinstance(observation, dict) or observation.get('userDomainPresent') is not False or
                    not isinstance(observation.get('processes'), list) or any(
                        not isinstance(row, dict) or not isinstance(row.get('state'), str) or not row['state'].startswith('Z')
                        for row in observation['processes'])):
                raise RuntimeError('Stop proof contains an unknown/live service observation')


def signer_config():
    # The signer owns its private configuration. Root protection is required
    # above its dedicated home; both signer-owned directories remain 0700.
    for path in (SIGNER.parent, SIGNER):
        info = path.lstat()
        if str(path.resolve()) != str(path) or not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (421, 420, 0o700):
            raise RuntimeError('Signer configuration directory identity changed')
    for path in SIGNER.parent.parents:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Signer configuration ancestor is unprotected')
    path = SIGNER / 'config.json'
    raw = update.regular(path, 1024 * 1024, mode=0o600)
    info = path.lstat()
    if (info.st_uid, info.st_gid) != (421, 420):
        raise RuntimeError('Signer configuration must remain owned by 421:420')
    return raw


def budget_valid(budget, goal):
    if not isinstance(budget, dict) or set(budget) != {'deadlineAt', 'repairIndex', 'maxRepairs'}:
        raise RuntimeError('Invalid frozen execution budget')
    deadline = budget.get('deadlineAt')
    if not isinstance(deadline, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', deadline):
        raise RuntimeError('Invalid frozen deadline')
    remaining = (datetime.datetime.fromisoformat(deadline.replace('Z', '+00:00')) - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    limit = goal.get('budgets', {}).get('maxRepairCycles')
    if (not 0 < remaining <= 3600 or type(budget['repairIndex']) is not int or
            type(budget['maxRepairs']) is not int or budget['maxRepairs'] != 3 or
            type(limit) is not int or not 0 <= budget['repairIndex'] < min(3, limit)):
        raise RuntimeError('Original deadline expired or repair limit exhausted')


def report_inventory(reports):
    inventory, total = [], 0
    def visit(directory, depth):
        nonlocal total
        update.directory(directory, 0o700)
        if depth > 4:
            raise RuntimeError('Report directory exceeds depth bound')
        for path in sorted(directory.iterdir()):
            if path.is_symlink():
                raise RuntimeError('Symbolic report refused')
            if path.is_dir():
                visit(path, depth + 1)
                continue
            data = update.regular(path, 16 * 1024 * 1024, protected=True, mode=0o600)
            total += len(data)
            if len(inventory) >= 256 or total > 64 * 1024 * 1024:
                raise RuntimeError('Report archive exceeds count/size bound')
            inventory.append({'path': str(path.relative_to(reports)), 'digest': update.sha(data), 'size': len(data)})
    visit(reports, 0)
    return inventory


def pinned_file(value):
    if not isinstance(value, dict) or set(value) != {'path', 'digest'} or not update.digest(value['digest']):
        raise RuntimeError('Invalid fixed document pin')
    raw = update.regular(Path(value['path']), 16 * 1024 * 1024, protected=True)
    if update.sha(raw) != value['digest']:
        raise RuntimeError('Fixed document digest changed')
    return raw


def audit(prior, following, expected_spec, expected_receipt):
    installed = update.installed({'previousSpecDigest': expected_spec, 'previousInstallReceiptDigest': expected_receipt, 'files': []})
    spec, receipt, _, _, spec_raw, receipt_raw, active, active_raw = installed
    stop_authority(active)
    control = update.FINAL / 'control'
    if spec.get('runId') != prior or spec.get('verifierConfigPath') != str(SIGNER / 'config.json'):
        raise RuntimeError('Installed Run or fixed verifier configuration path differs')
    for field, relative in [('goal', 'public/goal.json'), ('source', 'public/source.ts'), ('tests', 'public/tests.json')]:
        if spec.get(field, {}).get('path') != str(update.FINAL / relative):
            raise RuntimeError('Fixed goal/source/tests path changed')
        pinned_file(spec[field])
    goal = json.loads(pinned_file(spec['goal']))
    config_raw = signer_config()
    if update.sha(config_raw) != spec.get('verifierConfigDigest'):
        raise RuntimeError('Signer configuration digest changed')
    config = json.loads(config_raw)
    if (config.get('schemaVersion') != 'm0-verifier-config/1' or config.get('signerUid') != 421 or config.get('builderUid') != 420 or
            config.get('verifierId') != 'loopit-signer' or config.get('keyId') != spec.get('verifierKeyId') or
            any(config.get(field) != spec[field] for field in ('goal', 'source', 'tests'))):
        raise RuntimeError('Signer configuration identity/goal/source/tests changed')
    reports = control / 'reports'
    inventory = report_inventory(reports)
    result_raw = update.regular(reports / 'result.json', 16 * 1024 * 1024, protected=True, mode=0o600)
    result = json.loads(result_raw)
    binding = config.get('binding', {})
    revision = result.get('task', {}).get('revisions', {}).get(str(goal.get('goalRevision')), {})
    run = result.get('run', {})
    if (result.get('schemaVersion') != 'm0-control-loop-result/1' or result.get('status') != 'failed' or
            result.get('eventReplayMatches') is not True or result.get('binding') != binding or binding.get('runId') != prior or
            any(binding.get(key) != goal.get(key) for key in ('taskId', 'projectId', 'goalRevision')) or
            binding.get('sourceDigest') != spec['source']['digest'] or run.get('runId') != prior or run.get('status') != 'failed' or
            run.get('taskId') != goal.get('taskId') or run.get('goalRevision') != goal.get('goalRevision') or
            result.get('task', {}).get('currentRevision') != goal.get('goalRevision') or
            result.get('task', {}).get('runs', {}).get(prior) != {key: value for key, value in run.items() if key != 'taskId'} or revision.get('goal') != goal or
            revision.get('goalDigest') != binding.get('goalDigest') or revision.get('frozen') is not True or revision.get('status') != 'active'):
        raise RuntimeError('Expected a failed Run of the same current frozen Goal; database must still be rechecked by controller')
    budget_raw = update.regular(control / 'execution-budget.json', 16384, protected=True, mode=0o600)
    budget = json.loads(budget_raw)
    budget_valid(budget, goal)
    run_ids = revision.get('runIds')
    if (not isinstance(run_ids, list) or len(run_ids) != budget['repairIndex'] + 1 or run_ids[-1] != prior or
            len(set(run_ids)) != len(run_ids) or following in result['task']['runs']):
        raise RuntimeError('Frozen repair index does not match failed Run history')
    execution = json.loads(update.regular(reports / 'execution.json', 16 * 1024 * 1024, protected=True, mode=0o600))
    dispatch = execution.get('dispatch', {})
    if (execution.get('binding') != binding or dispatch.get('runId') != prior or dispatch.get('goalDigest') != binding.get('goalDigest') or
            dispatch.get('input', {}).get('executionBudget') != budget):
        raise RuntimeError('Budget differs from the failed execution; renewal forbidden')
    previous_authorization = None
    authorization_path = control / 'repair-authorization.json'
    if authorization_path.exists():
        previous_authorization = update.regular(authorization_path, 1024 * 1024, protected=True, mode=0o600)
        old = json.loads(previous_authorization)
        if (budget['repairIndex'] < 1 or old.get('schemaVersion') != 'm0-control-repair/1' or old.get('nextRunId') != prior or
                old.get('budgetAfter') != budget or old.get('firstDeadline') != budget['deadlineAt'] or
                receipt.get('lastRepair', {}).get('authorizationDigest') != update.sha(previous_authorization) or
                receipt.get('lastRepair', {}).get('nextRunId') != prior):
            raise RuntimeError('Previous repair authorization differs from the original budget')
    elif budget['repairIndex'] != 0:
        raise RuntimeError('Previous repair authorization missing')
    history = control / 'run-history'
    if history.exists():
        update.directory(history, 0o700)
    archive = history / prior
    if archive.exists() or archive.is_symlink():
        raise RuntimeError('Run history already exists; no overwrite or automatic interrupted retry')
    return {'spec': spec, 'receipt': receipt, 'config': config, 'goal': goal, 'budget': budget, 'active': active,
            'specRaw': spec_raw, 'receiptRaw': receipt_raw, 'configRaw': config_raw, 'budgetRaw': budget_raw,
            'activeRaw': active_raw, 'resultRaw': result_raw, 'inventory': inventory,
            'previousAuthorization': previous_authorization, 'archive': archive, 'reports': reports}


def replace_signer_config(data):
    path = SIGNER / 'config.json'
    temporary = path.with_name('.config.' + str(uuid.uuid4()) + '.repair')
    # Write+sync private bytes first, then persist signer ownership on the same
    # inode before publishing. Never publish root:root 0600 as signer config.
    update.write_new(temporary, data)
    fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fchown(fd, 421, 420)
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        if sys.platform == 'darwin':
            update.fcntl.fcntl(fd, 51)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    update.sync_dir(path.parent)


def run(prior, following, expected_spec, expected_receipt, apply=False):
    arguments(prior, following, expected_spec, expected_receipt)
    if sys.platform != 'darwin' or os.getuid() != 0 or os.geteuid() != 0:
        if apply:
            raise RuntimeError('Explicit macOS root execution required')
        return {'status': 'arguments-validated-only', 'installedState': 'not-checked-requires-root-read', 'writes': 0}
    os.umask(0o077)
    locks = []
    try:
        locks.extend([update.acquire('ownership.lock')])
        locks.extend([update.acquire('launch.lock')])
        checked = audit(prior, following, expected_spec, expected_receipt)
        if not apply:
            return {'status': 'audited-not-applied', 'priorRunId': prior, 'nextRunId': following, 'writes': 0}
        control, archive, reports = update.FINAL / 'control', checked['archive'], checked['reports']
        if not archive.parent.exists():
            archive.parent.mkdir(mode=0o700); update.sync_dir(control)
        archive.mkdir(mode=0o700); update.sync_dir(archive.parent)
        update.write_new(archive / 'active.before.json', checked['activeRaw'])
        active = checked['active']
        update.replace(update.STATE / 'active.json', update.encoded({**active, 'phase': 'maintenance', 'admissionDeadline': 0,
                       'workerUid': None, 'signerUid': None, 'repairPriorRunId': prior, 'repairNextRunId': following}))
        # Any failure below retains maintenance. No DB, workspace, goal, key or
        # authentication file is opened for mutation, and no process is started.
        for name, key in [('spec.before.json', 'specRaw'), ('install-receipt.before.json', 'receiptRaw'),
                          ('verifier-config.before.json', 'configRaw'), ('execution-budget.before.json', 'budgetRaw')]:
            update.write_new(archive / name, checked[key])
        if checked['previousAuthorization'] is not None:
            update.write_new(archive / 'repair-authorization.before.json', checked['previousAuthorization'])
        update.write_new(archive / 'reports-inventory.json', update.encoded(checked['inventory']))
        update.no_live_services()
        if report_inventory(reports) != checked['inventory']:
            raise RuntimeError('Reports changed before archival')
        os.rename(reports, archive / 'reports')
        update.sync_dir(archive); update.sync_dir(control)
        reports.mkdir(mode=0o700); update.sync_dir(control)
        if report_inventory(archive / 'reports') != checked['inventory']:
            raise RuntimeError('Archived reports failed complete byte verification')
        before = checked['budget']
        budget_valid(before, checked['goal'])
        after = {**before, 'repairIndex': before['repairIndex'] + 1}
        config = {**checked['config'], 'binding': {**checked['config']['binding'], 'runId': following}}
        config_raw = update.encoded(config)
        spec = {**checked['spec'], 'runId': following, 'verifierConfigDigest': update.sha(config_raw)}
        spec_raw = update.encoded(spec)
        authorization = {'schemaVersion': 'm0-control-repair/1', 'priorRunId': prior, 'nextRunId': following,
                         'priorResultDigest': update.sha(checked['resultRaw']), 'budgetBefore': before, 'budgetAfter': after,
                         'firstDeadline': before['deadlineAt'], 'archivedResultPath': str(archive / 'reports/result.json'),
                         'goal': checked['spec']['goal'], 'bindingBefore': checked['config']['binding'], 'bindingAfter': config['binding'],
                         'previousSpecDigest': expected_spec, 'nextSpecDigest': update.sha(spec_raw),
                         'previousInstallReceiptDigest': expected_receipt, 'stopProofsDigest': update.sha(checked['activeRaw']),
                         'authorizedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        authorization_raw = update.encoded(authorization)
        receipt = {**checked['receipt'], 'specDigest': update.sha(spec_raw),
                   'lastRepair': {'priorRunId': prior, 'nextRunId': following, 'authorizationDigest': update.sha(authorization_raw),
                                  'archivePath': str(archive)}}
        update.write_new(archive / 'repair-authorization.json', authorization_raw)
        update.replace(control / 'repair-authorization.json', authorization_raw)
        update.replace(control / 'execution-budget.json', update.encoded(after))
        replace_signer_config(config_raw)
        update.replace(control / 'spec.json', spec_raw)
        update.replace(control / 'install-receipt.json', update.encoded(receipt))
        for path, expected in [(control / 'spec.json', spec_raw), (control / 'install-receipt.json', update.encoded(receipt)),
                               (control / 'execution-budget.json', update.encoded(after)), (control / 'repair-authorization.json', authorization_raw)]:
            if update.regular(path, protected=True, mode=0o600) != expected:
                raise RuntimeError('Repair output failed final byte verification')
        if signer_config() != config_raw:
            raise RuntimeError('Signer configuration failed final identity/byte verification')
        budget_valid(before, checked['goal'])
        update.no_live_services()
        outcome = {'schemaVersion': 'm0-control-repair-receipt/1', 'status': 'prepared-not-executed',
                   'priorRunId': prior, 'nextRunId': following, 'specDigest': update.sha(spec_raw),
                   'installReceiptDigest': update.sha(update.encoded(receipt)), 'authorizationDigest': update.sha(authorization_raw),
                   'archivePath': str(archive), 'deadlineAt': after['deadlineAt'], 'repairIndex': after['repairIndex'],
                   'modelCalls': 0, 'databaseChanged': False}
        update.write_new(archive / 'repair-receipt.json', update.encoded(outcome))
        update.replace(update.STATE / 'active.json', checked['activeRaw'])
        return outcome
    finally:
        for fd in reversed(locks):
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prior-run', required=True)
    parser.add_argument('--next-run', required=True)
    parser.add_argument('--expected-spec', required=True)
    parser.add_argument('--expected-receipt', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.prior_run, args.next_run, args.expected_spec, args.expected_receipt, args.apply)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'blocked', 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          'note': 'No automatic retry. After mutation, retain maintenance and reconcile archived documents.'}))
        sys.exit(2)
