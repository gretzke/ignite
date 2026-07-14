#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const BEGIN = '<<<IGNITE_RESULT_BEGIN>>>'; const END = '<<<IGNITE_RESULT_END>>>';
let passes = 0;
function run(operation, input = '{}') {
  const child = spawnSync(process.execPath, [entry, operation], { input, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal((child.stdout.match(new RegExp(BEGIN, 'g')) ?? []).length, 1);
  assert.equal((child.stdout.match(new RegExp(END, 'g')) ?? []).length, 1);
  const begin = child.stdout.indexOf(BEGIN); const end = child.stdout.indexOf(END);
  assert.equal(child.stdout.slice(0, begin).trim(), ''); assert.equal(child.stdout.slice(end + END.length).trim(), '');
  return JSON.parse(child.stdout.slice(begin + BEGIN.length, end));
}
function check(condition, label) { assert.ok(condition, label); passes += 1; console.log(`PASS: ${label}`); }

const info = run('getInfo');
check(info.success && info.data.id === 'chronicles-logger' && info.data.operations.length === 3, 'metadata and empty stdin framing');
const describe = run('describeDeploymentHook');
check(describe.success && describe.data.label.length <= 64 && describe.data.description.length <= 512, 'describe caps');
const malformed = run('getInfo', '{bad');
check(!malformed.success && malformed.error.code === 'CLI_EXECUTION_FAILED', 'malformed JSON envelope');
const unknown = run('missingOperation');
check(!unknown.success && unknown.error.code === 'OPERATION_NOT_IMPLEMENTED', 'unknown operation envelope');
const thrown = run('onRunCompleted', '{}');
check(!thrown.success && thrown.error.code === 'PLUGIN_EXECUTION_ERROR', 'handler exception envelope');

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicles-protocol-'));
try {
  const jsonDir = path.join(workspace, 'deployments', 'json');
  await fs.mkdir(jsonDir, { recursive: true });
  const logFile = path.join(jsonDir, '1.json');
  await fs.writeFile(logFile, JSON.stringify({
    chainId: 1,
    unknownRoot: { keep: true },
    latest: { Token: '0x1111111111111111111111111111111111111111' },
    history: [{
      name: 'Token', address: '0x1111111111111111111111111111111111111111',
      timestamp: '2026-01-01T00:00:00.000Z', runId: 'old', eventId: 'old:1:deploy', workflow: 'old', unknownEntry: 'keep',
    }],
  }));
  await fs.writeFile(path.join(workspace, 'deployments', '1.md'), 'Human **prose**.\n');

  const newer = artifact('newer', '2026-07-14T12:00:00.000Z', '0x2222222222222222222222222222222222222222');
  const older = artifact('older', '2026-07-14T11:00:00.000Z', '0x3333333333333333333333333333333333333333');
  check(run('onRunCompleted', JSON.stringify({ workspacePath: workspace, workflowName: 'release_[x]', artifact: newer })).success, 'hook operation framing');
  run('onRunCompleted', JSON.stringify({ workspacePath: workspace, workflowName: 'release_[x]', artifact: older }));
  run('onRunCompleted', JSON.stringify({ workspacePath: workspace, workflowName: 'release_[x]', artifact: newer }));
  const merged = JSON.parse(await fs.readFile(logFile, 'utf8'));
  check(
    merged.unknownRoot.keep === true &&
      merged.history.find((entry) => entry.eventId === 'old:1:deploy').unknownEntry === 'keep' &&
      merged.history.filter((entry) => entry.eventId === 'newer:1:deploy').length === 1 &&
      merged.latest['Token_[x]@v2.0.0'] === '0x2222222222222222222222222222222222222222',
    'redelivery dedup, out-of-order latest, and unknown fields',
  );
  const markdown = await fs.readFile(path.join(workspace, 'deployments', '1.md'), 'utf8');
  check(markdown.startsWith('Human **prose**.\n') && markdown.includes('Token\\_\\[x\\]') && markdown.includes('ignite:chronicles:begin'), 'markdown region preservation and escaping');

  await fs.writeFile(logFile, '{malformed');
  const before = await fs.readFile(logFile, 'utf8');
  const refused = run('onRunCompleted', JSON.stringify({ workspacePath: workspace, workflowName: 'release', artifact: newer }));
  check(refused.success && refused.data.notes.length === 1 && await fs.readFile(logFile, 'utf8') === before, 'malformed log refusal without write');
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
console.log(`\n${passes} passed, 0 failed`);

function artifact(runId, updatedAt, address) {
  return {
    schemaVersion: 2, runId, profileId: 'p', name: runId, status: 'completed', createdAt: updatedAt, updatedAt,
    workflow: { name: 'release', docHash: 'a'.repeat(64) },
    contracts: [{ id: 'token', repoName: 'token', sourcePath: 'src/Token.sol', contractName: 'Token_[x]', artifactHash: 'b'.repeat(64), versionLabel: 'v2.0.0', compiler: { pluginId: 'foundry', version: '1', settingsHash: 'c'.repeat(64) } }],
    validation: { chains: {} },
    lanes: { '1': { chainId: 1, status: 'completed', providerLabel: 'RPC', steps: [{ stepId: 'deploy', kind: 'deploy', contractId: 'token', status: 'confirmed', args: {}, value: '0', address, attempts: [] }] } },
  };
}
