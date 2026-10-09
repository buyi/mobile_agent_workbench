import { afterEach, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateReader, guardForeground, resolvePrivateRunner } from '../m0/ios-state-adapter.mjs';

const device = '62F1C107-7480-41BD-B2E2-6C3323B8ECDA';
const app = 'com.loopit.state.fixture';
const servers = [];
const roots = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(r => server.close(r)); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function endpoint(rawStates, mutate = value => value) {
  const queries = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const query = JSON.parse(body); queries.push(query);
    const raw = rawStates[Math.min(queries.length - 1, rawStates.length - 1)];
    if (raw === 'hang') return;
    if (raw === 'http500') { res.writeHead(500); res.end('{}'); return; }
    const now = performance.now();
    const value = { ok: true, data: { loopitAppStates: { schemaVersion: 'loopit-ios-state/1', nonce: query.commandId,
      deviceUdid: device, startedUptimeMs: now, finishedUptimeMs: now,
      entries: query.queryBundleIds.map(bundleId => ({ bundleId, rawState: raw, state: ['unknown', 'not_running', 'background_suspended', 'background', 'foreground'][raw] })) } } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(mutate(value)));
  });
  servers.push(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { reader: createStateReader({ port: server.address().port, device }), queries };
}

test('live HTTP observations wait through a transition and require distinct nonces', async () => {
  const { reader, queries } = await endpoint([3, 4, 4]);
  const proof = await reader.stable([app], { timeoutMs: 1000, intervalMs: 20, desired: { [app]: [4] } });
  expect(proof.status).toBe('stable_observation'); expect(proof.samples).toHaveLength(3);
  expect(new Set(queries.map(q => q.commandId)).size).toBe(3);
  expect(queries.every(q => q.command === 'loopitAppStates')).toBe(true);
});

test.each([
  ['nonce', v => { v.data.loopitAppStates.nonce = 'earlier-response'; }],
  ['UDID', v => { v.data.loopitAppStates.deviceUdid = 'another-device'; }],
  ['state label', v => { v.data.loopitAppStates.entries[0].state = 'background'; }],
  ['duplicate bundle', v => { v.data.loopitAppStates.entries.push(v.data.loopitAppStates.entries[0]); }],
  ['unrequested bundle', v => { v.data.loopitAppStates.entries[0].bundleId = 'com.another.app'; }],
  ['backward time', v => { v.data.loopitAppStates.finishedUptimeMs = -1; }],
  ['failed response', v => { v.ok = false; }],
])('invalid %s cannot dispatch', async (_, mutate) => {
  const { reader } = await endpoint([4], v => { mutate(v); return v; }); let dispatched = 0;
  const result = await guardForeground({ reader, bundleId: app, dispatch: () => { dispatched++; } });
  expect(result.status).toBe('blocked'); expect(result.dispatched).toBe(false); expect(dispatched).toBe(0);
});

test.each([1, 2, 3])('non-foreground state %i rejects the actual dispatch closure', async raw => {
  const { reader } = await endpoint([raw]); let dispatched = 0;
  const result = await guardForeground({ reader, bundleId: app, dispatch: () => { dispatched++; } });
  expect(result.status).toBe('app_drift'); expect(dispatched).toBe(0); expect(result.proof.samples).toHaveLength(2);
});

test('stable foreground permits exactly one downstream invocation', async () => {
  const { reader } = await endpoint([4]); let dispatched = 0;
  const result = await guardForeground({ reader, bundleId: app, dispatch: async () => { dispatched++; return 'actual result'; } });
  expect(result.status).toBe('dispatched'); expect(result.result).toBe('actual result'); expect(dispatched).toBe(1);
});

test.each([0, 'hang', 'http500'])('unknown/error/deadline %s never dispatches', async raw => {
  const { reader } = await endpoint([raw]); let dispatched = 0;
  const result = await guardForeground({ reader, bundleId: app, timeoutMs: 200, dispatch: () => { dispatched++; } });
  expect(result.status).toBe('blocked'); expect(dispatched).toBe(0);
});

test('a failed downstream operation propagates; the adapter does not retry it', async () => {
  const { reader } = await endpoint([4]); let dispatched = 0;
  await expect(guardForeground({ reader, bundleId: app, dispatch: async () => { dispatched++; throw new Error('uncertain operation'); } })).rejects.toThrow('uncertain operation');
  expect(dispatched).toBe(1);
});

function leaseFixture(override = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loopit-state-lease-test-')); roots.push(root);
  const stateDirectory = join(root, 'state'), leaseDirectory = join(root, 'leases'); mkdirSync(stateDirectory); mkdirSync(leaseDirectory);
  writeFileSync(join(stateDirectory, 'daemon.json'), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(leaseDirectory, 'fixture.json'), JSON.stringify({ schemaVersion: 1, deviceId: device, sessionId: `${device}:12345:1780000000000`,
    ownerStateDir: stateDirectory, ownerPid: process.pid, runnerPid: process.pid + 1, port: 12345, ...override }));
  return { leaseDirectory, stateDirectory, device };
}
test('private runner binding uses native device:port:timestamp identity', () => {
  expect(resolvePrivateRunner(leaseFixture()).port).toBe(12345);
});
test.each([
  { ownerPid: -1 }, { sessionId: 'dsh-mobile-cli-session-is-not-runner-identity' },
  { deviceId: 'another-device' }, { port: 70000 },
])('foreign or malformed private runner lease is rejected: %j', override => {
  expect(() => resolvePrivateRunner(leaseFixture(override))).toThrow();
});
