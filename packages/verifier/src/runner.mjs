// Root-owned child entry. No keys, case expectations or signer configuration are
// present. One invocation observes one input, in a fresh restricted JS realm.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const bytes = await Bun.stdin.text();
if (bytes.length > 4096) throw new Error('input_too_large');
const request = JSON.parse(bytes);
if (typeof request.nonce !== 'string' || request.nonce.length !== 36 ||
    !Number.isSafeInteger(request.caseIndex) || request.caseIndex < 0 || request.caseIndex >= 12 ||
    (typeof request.input !== 'number' && request.input !== 'NaN') ||
    typeof request.compiledDigest !== 'string' || process.argv.length !== 3) throw new Error('invalid_case_request');
const source = readFileSync(process.argv[2]);
const digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
if (digest !== request.compiledDigest) throw new Error('compiled_candidate_mismatch');
const input = request.input === 'NaN' ? 'NaN' : JSON.stringify(request.input);
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
let observation;
try {
  const value = new vm.Script(`'use strict';\n${source.toString('utf8')}\nsumEvenThrough(${input});`, { filename: 'restricted-candidate.js' })
    .runInContext(context, { timeout: 250 });
  observation = typeof value === 'number' && Number.isFinite(value) ? { kind: 'returned', value } : { kind: 'invalid-return' };
} catch (error) {
  observation = error?.name === 'RangeError' ? { kind: 'threw', name: 'RangeError' } : { kind: 'execution-error' };
}
process.stdout.write(JSON.stringify({ schemaVersion: 'fixture-observation/1', nonce: request.nonce,
  caseIndex: request.caseIndex, compiledDigest: digest, observation }) + '\n');
