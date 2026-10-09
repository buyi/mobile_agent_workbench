// Mechanical device adapter only. XCTest states are asynchronous observations;
// two agreeing samples are not an OS-atomic focus guarantee or a device lease.
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const states = ['unknown', 'not_running', 'background_suspended', 'background', 'foreground'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function preparePrivateRunner(upstreamRoot, destination) {
  const upstream = realpathSync(upstreamRoot), target = resolve(destination);
  if (existsSync(target) || target.startsWith(upstream + '/')) throw new Error('Private package destination must be new and outside upstream');
  const lock = JSON.parse(readFileSync(join(here, 'ios-runner-state.lock.json'), 'utf8'));
  const patch = join(here, 'ios-runner-state.patch');
  const pkg = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
  if (pkg.name !== lock.upstream.package || pkg.version !== lock.upstream.version || sha(readFileSync(join(upstream, 'package.json'))) !== lock.upstream.packageJsonSha256 || sha(readFileSync(patch)) !== lock.patchSha256) throw new Error('Upstream version or patch digest mismatch');
  for (const file of lock.files) if (sha(readFileSync(join(upstream, file.path))) !== file.upstreamSha256) throw new Error(`Upstream file changed: ${file.path}`);
  cpSync(upstream, target, { recursive: true, dereference: false });
  const applied = spawnSync('/usr/bin/patch', ['-p1', '-F', '0', '-N', '-t', '-i', patch], { cwd: target, encoding: 'utf8', timeout: 10000 });
  if (applied.status !== 0 || applied.signal || applied.error) throw new Error(`Private patch failed: ${applied.stderr}`);
  for (const file of lock.files) {
    if (sha(readFileSync(join(target, file.path))) !== file.patchedSha256 || sha(readFileSync(join(upstream, file.path))) !== file.upstreamSha256) throw new Error(`Patch reconciliation failed: ${file.path}`);
  }
  return { ...lock, upstreamRoot: upstream, privatePackageRoot: target, cli: join(target, 'bin/agent-device.mjs') };
}

/** Bind the raw loopback reader to the private upstream runner lease. This is
 * cooperative process metadata, not protection from another same-user process. */
export function resolvePrivateRunner({ leaseDirectory, stateDirectory, device }) {
  const daemon = JSON.parse(readFileSync(join(stateDirectory, 'daemon.json'), 'utf8'));
  const matches = readdirSync(leaseDirectory).filter(n => n.endsWith('.json')).map(n => {
    const path = join(leaseDirectory, n);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Unexpected lease file');
    return JSON.parse(readFileSync(path, 'utf8'));
  }).filter(v => v.deviceId === device);
  if (matches.length !== 1) throw new Error('Expected one private runner lease for the dedicated device');
  const lease = matches[0];
  // Upstream Ht(device, port) creates device:port:timestamp runner ids, not the
  // CLI logical session name. Do not confuse those two distinct identities.
  if (lease.schemaVersion !== 1 || !new RegExp(`^${device}:${lease.port}:[0-9]+$`).test(lease.sessionId ?? '') || realpathSync(lease.ownerStateDir ?? '') !== realpathSync(stateDirectory) || lease.ownerPid !== daemon.pid || !Number.isInteger(lease.port) || lease.port < 1 || lease.port > 65535 || !Number.isInteger(lease.runnerPid) || lease.runnerPid < 1) throw new Error('Private runner lease identity mismatch');
  return { port: lease.port, device, lease };
}

function post(port, body, timeoutMs) {
  return new Promise((resolvePost, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    let timer;
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 65536) { const error = new Error('State response exceeded limit'); req.destroy(error); reject(error); } else chunks.push(b); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { reject(new Error(`State query HTTP ${res.statusCode}`)); return; }
        try { resolvePost(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid state query JSON')); }
      });
    });
    timer = setTimeout(() => { const error = new Error('State query deadline exceeded'); req.destroy(error); reject(error); }, timeoutMs);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(bytes);
  });
}

export function createStateReader({ port, device, onSample = () => {} }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !device) throw new Error('Invalid private runner endpoint');
  async function sample(bundleIds, timeoutMs = 2500) {
    if (!bundleIds.length || bundleIds.length > 8 || new Set(bundleIds).size !== bundleIds.length || bundleIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(id))) throw new Error('Invalid bundle query');
    const nonce = randomUUID(), startedAt = Date.now();
    const response = await post(port, { command: 'loopitAppStates', commandId: nonce, queryBundleIds: bundleIds }, timeoutMs);
    const value = response?.data?.loopitAppStates;
    if (response?.ok !== true || value?.schemaVersion !== 'loopit-ios-state/1' || value.nonce !== nonce || value.deviceUdid !== device || !Number.isFinite(value.startedUptimeMs) || !Number.isFinite(value.finishedUptimeMs) || value.startedUptimeMs < 0 || value.finishedUptimeMs < value.startedUptimeMs || value.finishedUptimeMs - value.startedUptimeMs > 2500 || !Array.isArray(value.entries) || value.entries.length !== bundleIds.length) throw new Error('Untrusted state observation identity or timing');
    const seen = new Set();
    for (const entry of value.entries) {
      if (!bundleIds.includes(entry.bundleId) || seen.has(entry.bundleId) || !Number.isInteger(entry.rawState) || entry.rawState < 0 || entry.rawState > 4 || states[entry.rawState] !== entry.state) throw new Error('Invalid state observation entries');
      seen.add(entry.bundleId);
    }
    const sample = { ...value, hostStartedAtMs: startedAt, hostFinishedAtMs: Date.now() };
    onSample(sample); return sample;
  }
  async function stable(bundleIds, { timeoutMs = 5000, intervalMs = 150, desired } = {}) {
    const deadline = Date.now() + timeoutMs, samples = []; let previous;
    while (Date.now() < deadline && samples.length < 32) {
      const next = await sample(bundleIds, Math.min(2500, deadline - Date.now())); samples.push(next);
      const agrees = previous && next.startedUptimeMs >= previous.finishedUptimeMs && next.hostStartedAtMs - previous.hostFinishedAtMs >= intervalMs - 10 && bundleIds.every(id => next.entries.find(e => e.bundleId === id).rawState === previous.entries.find(e => e.bundleId === id).rawState);
      const known = next.entries.every(e => e.rawState !== 0);
      const wanted = !desired || next.entries.every(e => desired[e.bundleId]?.includes(e.rawState));
      if (agrees && known && wanted) return { status: 'stable_observation', samples, observation: next, atomic: false };
      previous = next;
      if (Date.now() + intervalMs >= deadline) break;
      await sleep(intervalMs);
    }
    return { status: 'blocked', reason: 'No two stable desired asynchronous state observations within deadline', samples, atomic: false };
  }
  return { sample, stable };
}

/** Guarded dispatch. No fallback and no implicit activation. A caller must
 * explicitly open/activate its app before retrying after app_drift. */
export async function guardForeground({ reader, bundleId, timeoutMs = 2500, dispatch }) {
  let proof;
  try { proof = await reader.stable([bundleId], { timeoutMs }); }
  catch (error) { return { status: 'blocked', dispatched: false, reason: String(error) }; }
  if (proof.status !== 'stable_observation') return { status: 'blocked', dispatched: false, proof };
  if (proof.observation.entries[0].rawState !== 4) return { status: 'app_drift', dispatched: false, proof };
  return { status: 'dispatched', dispatched: true, proof, result: await dispatch() };
}

// Preparation only; building/starting the private runner is an explicit probe
// operation. No devices are touched by this entry point.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return args[i + 1]; };
  console.log(JSON.stringify(preparePrivateRunner(get('--upstream'), get('--out')), null, 2));
}
