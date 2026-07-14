import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../src/index.js');
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('metadata and describe declare the bounded deployment-hook surface', async () => {
  const info = plugin.getInfo();
  assert.equal(info.success, true);
  assert.deepEqual(info.data.types, ['deployment-hook']);
  assert.equal(info.data.repoRead, true);
  assert.deepEqual(info.data.operationPermissions, { onRunCompleted: 'repoWrite' });
  assert.ok(info.data.permissions.some((permission) => permission.id === 'repoWrite'));
  assert.deepEqual(info.data.operations, ['describeDeploymentHook', 'onRunCompleted', 'suggestAddresses']);
  const described = await plugin.describeDeploymentHook();
  assert.equal(described.success, true);
  assert.ok(described.data.label.length <= 64);
  assert.ok(described.data.description.length <= 512);
});

test('upserts eventId, preserves unknown fields, and recomputes latest for out-of-order delivery', async (t) => {
  const root = await workspace(t);
  const jsonDir = path.join(root, 'deployments', 'json'); await fs.mkdir(jsonDir, { recursive: true });
  const file = path.join(jsonDir, '1.json');
  await fs.writeFile(file, JSON.stringify({
    chainId: 1, customRoot: { keep: true }, latest: { Legacy: A, customLatest: 'keep' },
    history: [{ name: 'Legacy', address: A, timestamp: '2026-01-01T00:00:00.000Z', runId: 'legacy', eventId: 'legacy:1:s', workflow: 'old', customEntry: { keep: true } }],
  }, null, 2));

  await plugin.onRunCompleted({ workspacePath: root, workflowName: 'release', artifact: artifact('newer', '2026-07-14T12:00:00.000Z', B) });
  await plugin.onRunCompleted({ workspacePath: root, workflowName: 'release', artifact: artifact('older', '2026-07-14T11:00:00.000Z', A) });
  let value = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(value.customRoot, { keep: true });
  assert.deepEqual(value.history.find((entry) => entry.eventId === 'legacy:1:s').customEntry, { keep: true });
  assert.equal(value.latest['Token@v2.0.0'], B);

  const delivered = value.history.find((entry) => entry.eventId === 'newer:1:deploy'); delivered.thirdParty = { keep: 1 };
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  await plugin.onRunCompleted({ workspacePath: root, workflowName: 'release', artifact: artifact('newer', '2026-07-14T12:00:00.000Z', A) });
  value = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(value.history.filter((entry) => entry.eventId === 'newer:1:deploy').length, 1);
  assert.deepEqual(value.history.find((entry) => entry.eventId === 'newer:1:deploy').thirdParty, { keep: 1 });
  assert.equal(value.latest['Token@v2.0.0'], A);
  assert.equal(value.history.find((entry) => entry.eventId === 'newer:1:deploy').deployer, A);
});

test('includes addressed accept-deployed skips and ignores steps without an address', async (t) => {
  const root = await workspace(t);
  const value = artifact('skip', '2026-07-14T12:00:00.000Z', A);
  value.lanes['1'].steps = [
    { ...value.lanes['1'].steps[0], stepId: 'accepted', status: 'skipped', address: B },
    { ...value.lanes['1'].steps[0], stepId: 'excluded', status: 'skipped', address: undefined },
  ];
  await plugin.onRunCompleted({ workspacePath: root, workflowName: 'release', artifact: value });
  const log = JSON.parse(await fs.readFile(path.join(root, 'deployments/json/1.json'), 'utf8'));
  assert.deepEqual(log.history.map((entry) => entry.eventId), ['skip:1:accepted']);
});

test('malformed existing JSON returns an error note and leaves the file untouched', async (t) => {
  const root = await workspace(t); const dir = path.join(root, 'deployments/json'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '1.json'); await fs.writeFile(file, '{broken');
  const before = await fs.readFile(file, 'utf8');
  const result = await plugin.onRunCompleted({ workspacePath: root, workflowName: 'release', artifact: artifact('run', '2026-07-14T12:00:00.000Z', A) });
  assert.equal(result.success, true);
  assert.match(result.data.notes[0], /deployments\/json\/1\.json/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('markdown only replaces/appends managed regions, preserves prose, and escapes artifact text', async (t) => {
  const root = await workspace(t); const deployments = path.join(root, 'deployments'); await fs.mkdir(deployments, { recursive: true });
  const chainFile = path.join(deployments, '1.md'); const indexFile = path.join(deployments, 'index.md');
  await fs.writeFile(chainFile, 'Human **prose** stays byte-for-byte.\n');
  await fs.writeFile(indexFile, 'Before\n<!-- ignite:chronicles:begin -->old<!-- ignite:chronicles:end -->\nAfter\n');
  const value = artifact('markdown', '2026-07-14T12:00:00.000Z', A);
  value.contracts[0].contractName = 'Token_[x]|pipe';
  await plugin.onRunCompleted({ workspacePath: root, workflowName: 'flow_[x]', artifact: value });
  const chain = await fs.readFile(chainFile, 'utf8'); const index = await fs.readFile(indexFile, 'utf8');
  assert.ok(chain.startsWith('Human **prose** stays byte-for-byte.\n'));
  assert.equal((chain.match(/ignite:chronicles:begin/g) ?? []).length, 1);
  assert.match(chain, /Token\\_\\\[x\\\]\\\|pipe/);
  assert.ok(index.startsWith('Before\n')); assert.ok(index.endsWith('\nAfter\n'));
  assert.doesNotMatch(index, />old</);
});

test('suggestAddresses filters by contract name, sorts newest-first, and caps at 64', async (t) => {
  const root = await workspace(t); const dir = path.join(root, 'deployments/json'); await fs.mkdir(dir, { recursive: true });
  const history = Array.from({ length: 70 }, (_, index) => ({
    name: index === 69 ? 'Other' : 'Token', address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    timestamp: `2026-07-14T${String(index % 24).padStart(2, '0')}:${String(index).padStart(2, '0')}:00.000Z`, runId: `run-${index}`, eventId: `run-${index}:1:s`, workflow: 'release',
  }));
  await fs.writeFile(path.join(dir, '1.json'), JSON.stringify({ chainId: 1, latest: {}, history }));
  const result = await plugin.suggestAddresses({ workspacePath: root, chainIds: [1], contractName: 'Token' });
  assert.equal(result.success, true); assert.equal(result.data.suggestions.length, 64);
  assert.ok(result.data.suggestions.every((entry) => entry.contractName === 'Token'));
  assert.ok(result.data.suggestions[0].label.includes('release'));
});

function artifact(runId, updatedAt, address) {
  return {
    schemaVersion: 2, runId, profileId: 'p', name: runId, status: 'completed', createdAt: updatedAt, updatedAt,
    workflow: { name: 'release', docHash: 'a'.repeat(64) },
    contracts: [{ id: 'token', repoName: 'token', sourcePath: 'src/Token.sol', contractName: 'Token', artifactHash: 'b'.repeat(64), versionLabel: 'v2.0.0', compiler: { pluginId: 'foundry', version: '1', settingsHash: 'c'.repeat(64) } }],
    validation: { chains: {} },
    lanes: { '1': { chainId: 1, status: 'completed', providerLabel: 'RPC', steps: [{ stepId: 'deploy', kind: 'deploy', contractId: 'token', status: 'confirmed', args: {}, value: '0', address, signerAddress: A, attempts: [{ id: 'a', startedAt: updatedAt, txHash: '0x1234' }] }] } },
  };
}
