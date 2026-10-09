// Bounded operator probe of a Loopit-owned mechanical adaptation of upstream
// agent-device. No model/Agent, Broker epoch, OS focus lock, or signed Gate.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStateReader, guardForeground, resolvePrivateRunner } from './ios-state-adapter.mjs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return resolve(args[i + 1]); };
const out = arg('--out'), artifact = arg('--artifact'), runtimeRoot = arg('--runtime'), privatePackage = arg('--private-package');
const here = dirname(fileURLToPath(import.meta.url));
const device = '62F1C107-7480-41BD-B2E2-6C3323B8ECDA', bundle = 'com.seedleap.loopitapp.test', settings = 'com.apple.Preferences';
const simRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24 || existsSync(out)) throw new Error('Requires Node 24/macOS and a fresh report directory');
mkdirSync(out, { recursive: true, mode: 0o700 });
const dirs = Object.fromEntries(['state', 'artifacts', 'derived', 'leases', 'claims', 'swift', 'tmp'].map(key => {
  const path = join(out, key); mkdirSync(path, { mode: 0o700 }); return [key, path];
}));
const env = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'LANG', 'DEVELOPER_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: dirs.tmp,
  AGENT_DEVICE_STATE_DIR: dirs.state, AGENT_DEVICE_CONFIG: join(out, 'config.json'),
  AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: dirs.derived, AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: dirs.leases,
  AGENT_DEVICE_CLAIMS_DIR: dirs.claims, AGENT_DEVICE_SWIFT_CACHE_DIR: dirs.swift,
  AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1', AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: '1000', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '1000' });
for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
writeFileSync(join(out, 'config.json'), '{}\n', { mode: 0o600 });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pause = ms => new Promise(r => setTimeout(r, ms));
const report = { schemaVersion: 'ios-state-probe/1', nonce: randomUUID(), device, bundle, startedAt: new Date().toISOString(), status: 'preparing', operations: [], samples: [], checks: {}, dispatches: { snapshot: 0, action: 0 },
  limitations: ['XCUIApplication.state updates asynchronously. Two stable samples are evidence, not an OS-atomic foreground lock.',
    'The adapter has a check-to-dispatch race against external focus changes. No Broker epoch or OS device exclusivity is claimed.',
    'Original core and shared CLI remain unchanged. Only a private copy of the pinned Runner receives the checked-in patch.',
    'No model calls, login, account entry or business submission. This is not a business-feature or signed-Gate verification.'] };
const write = (name, value) => { const p = join(out, name); writeFileSync(p + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(p + '.tmp', p); };
const save = () => write('result.json', report);
async function op(name, action) {
  const event = { name, startedAt: new Date().toISOString(), status: 'dispatching' }; report.operations.push(event); save(); console.log(JSON.stringify({ phase: name }));
  try { const value = await action(); Object.assign(event, { status: 'completed', finishedAt: new Date().toISOString(), result: value }); save(); return value; }
  catch (error) { Object.assign(event, { status: 'failed_or_indeterminate', finishedAt: new Date().toISOString(), error: String(error) }); save(); throw error; }
}
function run(exe, argv, timeout = 60000, allowNonzero = false) {
  return new Promise((done, reject) => {
    const child = spawn(exe, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '', size = 0, expired = false;
    const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); };
    const timer = setTimeout(() => { expired = true; stop(); }, timeout);
    for (const [stream, field] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', data => {
      size += data.length; if (size > 16 * 1024 * 1024) { expired = true; stop(); return; }
      if (field === 'stdout') stdout += data; else stderr += data;
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); const value = { code, signal, expired, stdout, stderr };
      if (signal || expired || (!allowNonzero && code !== 0)) reject(new Error(JSON.stringify({ exe, argv, ...value }))); else done(value);
    });
  });
}
const sim = (name, argv, timeout) => op(name, async () => (await run('/usr/bin/xcrun', ['simctl', ...argv], timeout)).stdout.trim());
async function apps(name) {
  const text = await sim(name, ['listapps', device]); const path = join(out, name + '.plist'); writeFileSync(path, text, { mode: 0o600 });
  return JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])).stdout);
}
const cli = join(privatePackage, 'bin/agent-device.mjs');
let runtime, session, providerSession, deviceOwned = false, installDispatched = false;
try {
  const lock = JSON.parse(readFileSync(join(here, 'ios-runner-state.lock.json'), 'utf8'));
  if (hash(join(here, 'ios-runner-state.patch')) !== lock.patchSha256 || hash(join(privatePackage, 'package.json')) !== lock.upstream.packageJsonSha256) throw new Error('Private patch provenance mismatch');
  for (const f of lock.files) if (hash(join(privatePackage, f.path)) !== f.patchedSha256) throw new Error('Private source does not match checked-in patch');
  report.provenance = { ...lock, privatePackage, node: { version: process.version, sha256: hash(process.execPath) }, scriptSha256: hash(fileURLToPath(import.meta.url)), adapterSha256: hash(join(here, 'ios-state-adapter.mjs')) };
  const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(artifact, 'Info.plist')])).stdout);
  if (info.CFBundleIdentifier !== bundle || info.DTPlatformName !== 'iphonesimulator') throw new Error('Wrong app identity');
  report.app = { bundleId: bundle, version: info.CFBundleShortVersionString, build: info.CFBundleVersion, executableSha256: hash(join(artifact, info.CFBundleExecutable)), jsSha256: hash(join(artifact, 'main.jsbundle')) };
  const before = JSON.parse(await sim('device-before', ['list', 'devices', '--json']));
  const live = before.devices[simRuntime]?.find(d => d.udid === device);
  if (!live?.isAvailable || !live.name.startsWith('Loopit M0 ') || live.deviceTypeIdentifier !== 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' || live.state !== 'Shutdown') throw new Error('Dedicated device identity/state mismatch');
  deviceOwned = true; report.deviceBefore = live;
  await sim('boot', ['boot', device]); await sim('boot-ready', ['bootstatus', device, '-b'], 90000);
  const beforeApps = await apps('apps-before'); report.runnerAppsBefore = Object.keys(beforeApps).filter(id => id.startsWith('com.callstack.agentdevice.'));
  if (beforeApps[bundle]) throw new Error('Unexpected pre-existing target app or placeholder; no replacement');
  installDispatched = true; await sim('install-baseline', ['install', device, artifact]);
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`, wrapper = join(out, 'agent-device');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
  const { MobileUiRuntime } = await import(pathToFileURL(join(runtimeRoot, 'lib/core/runtime.js')).href);
  const { createAgentDeviceProviderFactory } = await import(pathToFileURL(join(runtimeRoot, 'lib/providers/agent-device.js')).href);
  const factory = createAgentDeviceProviderFactory({ agent_device_path: wrapper, state_dir: dirs.state, artifact_dir: dirs.artifacts,
    command_timeout_ms: 30000, snapshot_timeout_ms: 240000, kill_grace_ms: 1500, max_output_bytes: 16 * 1024 * 1024, debug: false });
  runtime = new MobileUiRuntime((request, id) => {
    providerSession = `dsh-mobile-${id}`;
    const p = factory(request, id), open = p.open.bind(p), snapshot = p.snapshot.bind(p), act = p.act.bind(p);
    p.open = async (request, signal) => {
      // Only infrastructure preparation precedes the explicit app open. Once
      // Settings is launched below, no prepare/open/snapshot occurs until guard.
      await op('prepare-private-runner', () => run(process.execPath, [cli, 'prepare', 'ios-runner', '--platform', 'ios', '--udid', device,
        '--session', providerSession, '--state-dir', dirs.state, '--timeout', '180000', '--json'], 200000));
      return open({ ...request, relaunch: true }, signal);
    };
    p.snapshot = (...input) => { report.dispatches.snapshot++; save(); return snapshot(...input); };
    p.act = (...input) => { report.dispatches.action++; save(); return act(...input); };
    return p;
  }, { max_nodes: 5000, history_limit: 8, default_poll_ms: 250, max_wait_ms: 60000, dispose_timeout_ms: 10000, preflight_actions: true });
  const opened = await op('core-open-explicit', () => runtime.open({ app: bundle, platform: 'ios', udid: device, relaunch: true }, AbortSignal.timeout(240000)));
  session = opened.session_id;
  const endpoint = resolvePrivateRunner({ leaseDirectory: dirs.leases, stateDirectory: dirs.state, device, session: providerSession });
  report.runnerIdentity = { device, session: providerSession, ownerPid: endpoint.lease.ownerPid, runnerPid: endpoint.lease.runnerPid, port: endpoint.port };
  const reader = createStateReader({ port: endpoint.port, device, onSample: sample => { report.samples.push(sample); save(); } });
  const foreground = await op('known-loopit-foreground', () => reader.stable([bundle], { desired: { [bundle]: [4] }, timeoutMs: 8000 }));
  if (foreground.status !== 'stable_observation') throw new Error('Known Loopit foreground did not stabilize');
  const positive = await op('foreground-guard-positive-snapshot', () => guardForeground({ reader, bundleId: bundle,
    dispatch: () => runtime.snapshot({ session_id: session }, AbortSignal.timeout(30000)) }));
  if (positive.status !== 'dispatched' || positive.result?.status !== 'ok') throw new Error('Foreground positive case did not produce a snapshot');
  write('foreground-snapshot.json', positive.result); report.checks.foregroundPositive = true;
  const snapshotCountBeforeDrift = report.dispatches.snapshot;
  await sim('launch-settings', ['launch', device, settings]);
  const switched = await op('readonly-observe-loopit-background-settings-foreground', () => reader.stable([bundle, settings], {
    desired: { [bundle]: [2, 3], [settings]: [4] }, timeoutMs: 10000 }));
  if (switched.status !== 'stable_observation') throw new Error('Foreground switch was not independently observed before snapshot');
  const actionCount = report.dispatches.action;
  const guarded = await op('foreground-guard-negative', () => guardForeground({ reader, bundleId: bundle,
    dispatch: () => runtime.act({ session_id: session, base_revision: positive.result.snapshot.revision, action: 'home' }, AbortSignal.timeout(30000)) }));
  report.checks.driftNegative = { status: guarded.status, actionDispatchCount: report.dispatches.action - actionCount,
    snapshotDispatchCount: report.dispatches.snapshot - snapshotCountBeforeDrift, guardLayer: 'loopit-ios-state-adapter', atomic: false };
  if (guarded.status !== 'app_drift' || report.dispatches.action !== actionCount || report.dispatches.snapshot !== snapshotCountBeforeDrift) throw new Error('Guard did not reject before provider dispatch');
  const unchanged = await op('readonly-after-rejection', () => reader.stable([bundle, settings], { desired: { [bundle]: [2, 3], [settings]: [4] }, timeoutMs: 3000 }));
  if (unchanged.status !== 'stable_observation') throw new Error('Read-only observer did not preserve the observed foreground');
  report.checks.readOnlyForegroundPreserved = true;
  report.status = 'capability-observed';
} catch (error) { report.status = 'blocked_or_failed'; report.error = String(error); console.error(String(error)); }
finally {
  report.cleanup = { errors: [] }; save();
  if (runtime && session) { try { report.cleanup.coreClose = await op('core-close', () => runtime.close(session, AbortSignal.timeout(45000))); } catch (e) { report.cleanup.errors.push(String(e)); } }
  if (runtime) { try { await runtime.dispose(); } catch (e) { report.cleanup.errors.push(String(e)); } }
  if (deviceOwned) {
    try {
      const inventory = await apps('apps-before-cleanup');
      if (installDispatched && inventory[bundle]) await sim('uninstall-loopit', ['uninstall', device, bundle]);
      const newRunners = Object.keys(inventory).filter(id => id.startsWith('com.callstack.agentdevice.') && !(report.runnerAppsBefore ?? []).includes(id));
      for (const id of newRunners) await sim('uninstall-private-runner', ['uninstall', device, id]);
      await pause(3000); const remaining = await apps('apps-after-uninstall');
      report.cleanup.appAbsent = !remaining[bundle]; report.cleanup.newRunnerAppsAbsent = newRunners.every(id => !remaining[id]);
      await sim('shutdown-before-cleanup-recheck', ['shutdown', device]);
      if (!report.cleanup.appAbsent) throw new Error('Target app/placeholder remained after uninstall');
      await sim('cleanup-reboot', ['boot', device]); await sim('cleanup-boot-ready', ['bootstatus', device, '-b'], 90000); await pause(3000);
      const afterReboot = await apps('apps-after-cleanup-reboot');
      report.cleanup.appAbsentAfterReboot = !afterReboot[bundle];
      report.cleanup.newRunnerAppsAbsentAfterReboot = newRunners.every(id => !afterReboot[id]);
      const container = await op('app-container-after-reboot', () => run('/usr/bin/xcrun', ['simctl', 'get_app_container', device, bundle, 'app'], 20000, true));
      report.cleanup.appContainerAbsentAfterReboot = container.code !== 0 && !container.stdout.trim() && /No such file or directory/.test(container.stderr);
      if (!report.cleanup.appAbsentAfterReboot || !report.cleanup.appContainerAbsentAfterReboot || !report.cleanup.newRunnerAppsAbsentAfterReboot) throw new Error('Cleanup was not stable across reboot');
    } catch (e) { report.cleanup.errors.push(String(e)); }
    finally {
      try { const state = JSON.parse(await sim('device-before-final-shutdown', ['list', 'devices', '--json'])).devices[simRuntime]?.find(d => d.udid === device)?.state;
        if (state === 'Booted') await sim('final-shutdown', ['shutdown', device]); else if (state !== 'Shutdown') throw new Error('Uncertain dedicated device state');
        report.cleanup.deviceState = JSON.parse(await sim('device-final', ['list', 'devices', '--json'])).devices[simRuntime]?.find(d => d.udid === device)?.state;
      } catch (e) { report.cleanup.errors.push(String(e)); }
    }
  }
  for (let i = 0; i < 20 && existsSync(join(dirs.state, 'daemon.json')); i++) await pause(500);
  report.cleanup.privateDaemonMetadataAbsent = !existsSync(join(dirs.state, 'daemon.json'));
  if (!report.cleanup.privateDaemonMetadataAbsent) report.cleanup.errors.push('Private daemon did not finish idle cleanup; inspect its exact recorded owner PID before further work');
  report.runnerBinaries = [];
  const walk = path => { for (const e of readdirSync(path, { withFileTypes: true })) { const p = join(path, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && /^(AgentDeviceRunner|AgentDeviceRunnerUITests-Runner|AgentDeviceRunnerUITests)$/.test(e.name)) report.runnerBinaries.push({ path: p, sha256: hash(p) }); } };
  walk(dirs.derived);
  if (report.cleanup.errors.length || (deviceOwned && report.cleanup.deviceState !== 'Shutdown')) report.status = 'cleanup-needs-inspection';
  report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ status: report.status, out, checks: report.checks, cleanup: report.cleanup }));
  process.exitCode = report.status === 'capability-observed' ? 0 : 2;
}
