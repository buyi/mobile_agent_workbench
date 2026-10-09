// Operator-directed, bounded capability experiment. No model, planner, Device
// Broker, lease epoch, OS device isolation, independent verifier or signed Gate.
// Run with Node 24. Uses ONLY the existing runtime core + agent-device provider.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const required = name => { const value = option(name); if (!value) throw new Error(`Missing ${name}`); return resolve(value); };
const out = required('--out');
const artifact = required('--artifact');
const runtimeRoot = required('--runtime');
const cli = required('--agent-device');
const device = '62F1C107-7480-41BD-B2E2-6C3323B8ECDA';
const bundle = 'com.seedleap.loopitapp.test';
const simRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
const deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Requires macOS and Node 24+');
if (existsSync(out)) throw new Error('Output must be new; inspect prior evidence before another experiment');
mkdirSync(out, { recursive: true, mode: 0o700 });
const dirs = Object.fromEntries(['state', 'artifacts', 'runner-derived', 'runner-leases', 'claims', 'swift-cache', 'tmp'].map(n => {
  const path = join(out, n); mkdirSync(path, { mode: 0o700 }); return [n, path];
}));
// No credentials, proxy configuration, global agent config or previous runner
// overrides are inherited. HOME is retained for macOS services, not repurposed.
const cleanEnv = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'LANG', 'DEVELOPER_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(cleanEnv, {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: dirs.tmp,
  AGENT_DEVICE_STATE_DIR: dirs.state, AGENT_DEVICE_CONFIG: join(out, 'agent-device.json'),
  AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: dirs['runner-derived'],
  AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: dirs['runner-leases'], AGENT_DEVICE_CLAIMS_DIR: dirs.claims,
  AGENT_DEVICE_SWIFT_CACHE_DIR: dirs['swift-cache'], AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: '1000', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '1000',
});
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, cleanEnv);
writeFileSync(join(out, 'agent-device.json'), '{}\n', { mode: 0o600 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = path => ({ path, bytes: statSync(path).size, sha256: sha(readFileSync(path)) });
const report = { schemaVersion: 'ios-ui-probe/1', nonce: randomUUID(), startedAt: new Date().toISOString(), status: 'preparing',
  device, bundle, operations: [], checks: {}, tools: {}, providerActionDispatches: 0,
  limitations: ['Operator-directed core/provider experiment, no second reasoning runtime or model calls.',
    'No Device Broker epoch, service-managed exclusivity or OS device isolation. Private cooperative claims only.',
    'An accessibility tree and safe local UI actions do not prove a business feature, server behavior or signed Gate.',
    'Loopit may perform its normal unauthenticated startup requests; no login, account, form submission or external business mutation is driven.'],
};
const write = (name, value) => { const path = join(out, name); writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(path + '.tmp', path); };
const save = () => write('result.json', report);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function operation(name, fn) {
  const event = { name, startedAt: new Date().toISOString(), status: 'dispatching' };
  report.operations.push(event); save(); console.log(JSON.stringify({ phase: name, status: 'dispatching' }));
  try { const value = await fn(); Object.assign(event, { status: 'completed', finishedAt: new Date().toISOString(), result: value }); save(); return value; }
  catch (error) { Object.assign(event, { status: 'failed_or_indeterminate', finishedAt: new Date().toISOString(), error: String(error) }); save(); throw error; }
}
async function run(command, argv, timeout = 60000, allowNonzero = false) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, size = 0, exceeded = false;
    const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const collect = key => data => { size += data.length; if (size > 16 * 1024 * 1024) { exceeded = true; stop(); return; } if (key === 'out') stdout += data; else stderr += data; };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); const result = { code, signal, timedOut, exceeded, stdout, stderr };
      if ((!allowNonzero && code !== 0) || signal || timedOut || exceeded) reject(new Error(JSON.stringify({ command, argv, ...result })));
      else resolveRun(result);
    });
  });
}
const simctl = (name, argv, timeout) => operation(name, async () => (await run('/usr/bin/xcrun', ['simctl', ...argv], timeout)).stdout.trim());
async function devices(name) { return JSON.parse(await simctl(name, ['list', 'devices', '--json'])); }
async function apps(name) {
  const raw = await simctl(name, ['listapps', device]);
  const path = join(out, `${name}.plist`); writeFileSync(path, raw, { mode: 0o600 });
  return JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])).stdout);
}
const signal = ms => AbortSignal.timeout(ms);
let runtime, session, bootedByProbe = false, installDispatched = false, ownsDevice = false;
let providerSession;
try {
  report.tools.node = { version: process.version, ...hashFile(process.execPath) };
  report.tools.agentDevice = { version: (await run(process.execPath, [cli, '--version'])).stdout.trim(), ...hashFile(cli) };
  if (report.tools.agentDevice.version !== '0.21.1') throw new Error('Probe was reviewed against agent-device 0.21.1 only');
  report.tools.runtime = ['lib/core/runtime.js', 'lib/core/protocol.js', 'lib/providers/agent-device.js', 'package.json'].map(p => hashFile(join(runtimeRoot, p)));
  report.tools.xcode = (await run('/usr/bin/xcodebuild', ['-version'])).stdout.trim();
  report.artifactInfo = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(artifact, 'Info.plist')])).stdout);
  if (report.artifactInfo.CFBundleIdentifier !== bundle || report.artifactInfo.DTPlatformName !== 'iphonesimulator') throw new Error('Unexpected app identity');
  report.artifactSelectedHashes = ['Info.plist', report.artifactInfo.CFBundleExecutable].map(p => hashFile(join(artifact, p)));
  const before = await devices('device-before');
  const live = before.devices[simRuntime]?.find(d => d.udid === device);
  if (!live?.isAvailable || !live.name.startsWith('Loopit M0 ') || live.deviceTypeIdentifier !== deviceType || live.state !== 'Shutdown') throw new Error('Dedicated device identity/state does not match; do not operate');
  report.deviceBefore = live; ownsDevice = true; save();
  await simctl('boot-dedicated-device', ['boot', device]); bootedByProbe = true;
  await simctl('wait-for-boot', ['bootstatus', device, '-b'], 90000);
  const beforeApps = await apps('apps-before');
  if (beforeApps[bundle]) throw new Error('Target app already exists; refuse replacement');
  report.checks.initialAppAbsent = true;
  report.runnerAppsBefore = Object.keys(beforeApps).filter(id => id.startsWith('com.callstack.agentdevice.'));
  installDispatched = true; await simctl('install-loopit', ['install', device, artifact]);
  const wrapper = join(out, 'agent-device');
  const q = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(wrapper, `#!/bin/sh\nexec ${q(process.execPath)} ${q(cli)} "$@"\n`, { mode: 0o700 });
  const { MobileUiRuntime } = await import(pathToFileURL(join(runtimeRoot, 'lib/core/runtime.js')).href);
  const { createAgentDeviceProviderFactory } = await import(pathToFileURL(join(runtimeRoot, 'lib/providers/agent-device.js')).href);
  const factory = createAgentDeviceProviderFactory({ agent_device_path: wrapper, state_dir: dirs.state, artifact_dir: dirs.artifacts,
    command_timeout_ms: 30000, snapshot_timeout_ms: 240000, kill_grace_ms: 1500, max_output_bytes: 16 * 1024 * 1024, debug: false });
  runtime = new MobileUiRuntime((request, id) => {
    providerSession = `dsh-mobile-${id}`; // Existing provider namespace; no DSH agent is loaded.
    const provider = factory(request, id); const act = provider.act.bind(provider);
    provider.act = async (...input) => { report.providerActionDispatches++; save(); return act(...input); };
    return provider;
  }, { max_nodes: 5000, history_limit: 8, default_poll_ms: 250, max_wait_ms: 60000, dispose_timeout_ms: 10000, preflight_actions: true });
  const opened = await operation('core-open', () => runtime.open({ app: bundle, platform: 'ios', target: 'mobile', udid: device }, signal(240000)));
  session = opened.session_id;
  let observed = await operation('semantic-snapshot', () => runtime.snapshot({ session_id: session, screenshot: true }, signal(90000)));
  write('initial-snapshot.json', observed);
  const snap = observed.snapshot;
  if (snap.app !== bundle || snap.truncated || !snap.nodes.some(n => n.name?.trim() && n.role.toLowerCase() !== 'application')) throw new Error('No complete named Loopit semantic tree; no readiness claim');
  report.checks.semanticTree = { app: snap.app, revision: snap.revision, nodes: snap.nodes.length, namedNodes: snap.nodes.filter(n => n.name?.trim()).length, warnings: snap.warnings };
  const priorDispatches = report.providerActionDispatches;
  const stale = await operation('stale-revision-negative', () => runtime.act({ session_id: session, base_revision: snap.revision - 1, action: 'home' }, signal(10000)));
  report.checks.staleGuard = { status: stale.status, providerDispatched: report.providerActionDispatches !== priorDispatches };
  if (stale.status !== 'stale_snapshot' || report.providerActionDispatches !== priorDispatches) throw new Error('Stale revision guard failed');
  console.log(JSON.stringify({ phase: 'await-observed-safe-action', decisionFile: join(out, 'decision.json'), snapshot: join(out, 'initial-snapshot.json'), timeoutMs: 120000,
    nodes: snap.nodes.filter(n => n.name || n.actions.length).map(n => ({ ref: n.ref, role: n.role, name: n.name, actions: n.actions })) }));
  const decisionPath = join(out, 'decision.json'), deadline = Date.now() + 120000;
  while (!existsSync(decisionPath) && Date.now() < deadline) await pause(250);
  if (!existsSync(decisionPath)) throw new Error('No observed safe action selected within bounded decision window');
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  const node = snap.nodes.find(n => n.ref === decision.pressRef);
  if (!node || !decision.reason || /agree|accept|sign.?in|log.?in|continue|同意|登录|注册|发送|submit/i.test(node.name ?? '')) throw new Error('Ref absent or action outside local non-submitting UI scope');
  report.decision = decision; save();
  const acted = await operation('safe-semantic-press', () => runtime.act({ session_id: session, base_revision: snap.revision, action: 'press', target: { ref: node.ref } }, signal(90000)));
  write('safe-action.json', acted);
  if (acted.status !== 'ok') throw new Error(`Safe action outcome ${acted.status}; no automatic action retry`);
  observed = await operation('post-action-snapshot', () => runtime.snapshot({ session_id: session, screenshot: true }, signal(90000)));
  write('post-action-snapshot.json', observed);
  const after = observed.snapshot;
  report.checks.safeAction = { status: acted.status, fromRevision: snap.revision, toRevision: after.revision, app: after.app, diff: after.diff };
  if (after.app !== bundle || after.truncated) throw new Error('Post-action app/completeness mismatch');
  if (decision.expectExactName && !after.nodes.some(n => n.name === decision.expectExactName)) throw new Error('Expected post-action semantic name absent');
  if (decision.expectKeyboard && !after.nodes.some(n => /keyboard/i.test(n.role))) throw new Error('Expected keyboard absent after focus');
  // System Settings is used only as a safe foreground perturbation. If the
  // guard fails, the attempted fallback is home, never a business operation.
  // IMPORTANT: simctl launch returning a PID is not live foreground evidence.
  // In 0.21.1 iOS appstate returns source=session, and Runner snapshot may
  // activateTarget(stale_target). Thus this is only a candidate negative case,
  // and cannot establish the guard even if its status happened to match.
  await simctl('foreground-drift-to-settings', ['launch', device, 'com.apple.Preferences']);
  const beforeDrift = report.providerActionDispatches;
  const drift = await operation('app-drift-negative', () => runtime.act({ session_id: session, base_revision: after.revision, action: 'home' }, signal(90000)));
  write('app-drift.json', drift);
  report.checks.appDriftGuard = { status: drift.status, providerDispatched: report.providerActionDispatches !== beforeDrift,
    foregroundIndependentlyObserved: false, conclusion: 'not-established',
    missingCapability: 'Native read-only live foreground identity; iOS appstate is session metadata, Runner snapshot may activate the session target.' };
  if (drift.status !== 'app_drift' || report.providerActionDispatches !== beforeDrift) throw new Error('iOS app drift guard not established');
  throw new Error('Native iOS foreground identity is unavailable; candidate negative case cannot establish the app drift guard');
} catch (error) {
  report.status = 'blocked_or_failed'; report.error = String(error); console.error(String(error));
} finally {
  report.cleanup = { errors: [] }; save();
  if (session && runtime) {
    try { report.cleanup.coreClose = await operation('core-close', () => runtime.close(session, signal(45000))); }
    catch (e) { report.cleanup.errors.push(String(e)); }
  } else if (providerSession) {
    // Open may have created native state before returning an error. Close that
    // exact private session once; this is cleanup, not retrying the failed UI op.
    try { await operation('close-partial-private-session', () => run(process.execPath, [cli, 'close', '--session', providerSession, '--state-dir', dirs.state, '--platform', 'ios', '--udid', device], 45000)); }
    catch (e) { report.cleanup.errors.push(String(e)); }
  }
  if (runtime) { try { await runtime.dispose(); } catch (e) { report.cleanup.errors.push(String(e)); } }
  if (ownsDevice && bootedByProbe) {
    try {
      const inventory = await apps('apps-before-cleanup');
      if (installDispatched && inventory[bundle]) await simctl('uninstall-loopit', ['uninstall', device, bundle]);
      const runnerIds = Object.keys(inventory).filter(id => id.startsWith('com.callstack.agentdevice.') && !(report.runnerAppsBefore ?? []).includes(id));
      for (const id of runnerIds) await simctl(`uninstall-probe-runner-${id}`, ['uninstall', device, id]);
      await pause(3000); // Uninstall completion is also checked across reboot below.
      const cleaned = await apps('apps-after-cleanup');
      report.cleanup.appAbsent = !cleaned[bundle];
      report.cleanup.newRunnerAppsAbsent = runnerIds.every(id => !cleaned[id]);
    } catch (e) { report.cleanup.errors.push(String(e)); }
    try { await simctl('shutdown-dedicated-device', ['shutdown', device]); } catch (e) { report.cleanup.errors.push(String(e)); }
    if (report.cleanup.appAbsent && installDispatched) {
      try {
        await simctl('cleanup-reboot', ['boot', device]);
        await simctl('cleanup-wait-for-boot', ['bootstatus', device, '-b'], 90000);
        await pause(3000);
        const stable = await apps('apps-after-cleanup-reboot');
        report.cleanup.appAbsentAfterReboot = !stable[bundle];
        const container = await operation('container-after-cleanup-reboot', () => run('/usr/bin/xcrun', ['simctl', 'get_app_container', device, bundle, 'app'], 20000, true));
        report.cleanup.appContainerAbsentAfterReboot = container.code !== 0 && !container.stdout.trim() && /No such file or directory/.test(container.stderr);
        if (!report.cleanup.appAbsentAfterReboot || !report.cleanup.appContainerAbsentAfterReboot) throw new Error('Cleanup is not stable across reboot');
      } catch (e) { report.cleanup.errors.push(String(e)); }
      finally { try { await simctl('final-shutdown', ['shutdown', device]); } catch (e) { report.cleanup.errors.push(String(e)); } }
    }
    try { const end = await devices('device-after'); report.cleanup.deviceState = end.devices[simRuntime]?.find(d => d.udid === device)?.state; }
    catch (e) { report.cleanup.errors.push(String(e)); }
  }
  // The upstream runner/daemon idle shutdown is bounded separately. Never kill
  // an unrelated daemon or runner process by name.
  const daemonInfo = join(dirs.state, 'daemon.json');
  for (let n = 0; n < 20 && existsSync(daemonInfo); n++) await pause(500);
  report.cleanup.privateDaemonMetadataAbsent = !existsSync(daemonInfo);
  const runnerBinaries = [];
  function inspectTree(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) inspectTree(child);
      else if (entry.isFile() && /^(AgentDeviceRunner|AgentDeviceRunnerUITests-Runner|AgentDeviceRunnerUITests)$/.test(entry.name)) runnerBinaries.push(hashFile(child));
    }
  }
  inspectTree(dirs['runner-derived']); report.tools.builtRunnerBinaries = runnerBinaries;
  if (report.cleanup.errors.length || (ownsDevice && bootedByProbe && (!report.cleanup.appAbsent || report.cleanup.deviceState !== 'Shutdown'))) report.status = 'cleanup-needs-inspection';
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, out, staleGuard: report.checks.staleGuard, appDriftGuard: report.checks.appDriftGuard, cleanup: report.cleanup }));
  process.exitCode = report.status === 'capability-observed' ? 0 : 2;
}
