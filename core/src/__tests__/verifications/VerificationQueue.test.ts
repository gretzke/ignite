import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerificationStore } from '../../verifications/VerificationStore.js';
import {
  VerificationQueue,
  MAX_SUBMIT_ATTEMPTS,
  SUBMIT_BACKOFF_MS,
} from '../../verifications/VerificationQueue.js';
const dirs: string[] = [];
async function subject(
  result: any = { success: true, data: { status: 'verified' } }
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-verify-'));
  dirs.push(dir);
  return new VerificationQueue({
    store: new VerificationStore({ baseDir: dir }),
    executor: { execute: vi.fn(async () => result) } as any,
  });
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))
  );
});
const req = {
  contract: {
    id: 'c',
    repoPathOrUrl: 'x',
    frameworkId: 'f',
    artifactPath: 'a',
    contractName: 'C',
    sourcePath: 'C.sol',
  },
  chainId: 1,
  address: '0x0000000000000000000000000000000000000001',
  explorerEntryIds: ['e'],
};
const resolved = {
  bundleHash: 'a'.repeat(64),
  encodedConstructorArgs: '0x',
  explorers: [
    {
      entryId: 'e',
      url: 'https://scan.test',
      verifierPluginId: 'verifier',
      label: 'Scan',
    },
  ],
};
describe('VerificationQueue', () => {
  it('uses fake-timer scheduling for new tasks', async () => {
    vi.useFakeTimers();
    const queue = await subject();
    (queue as any).bundles = { write: vi.fn(async () => 'b'.repeat(64)), read: vi.fn(async (_profile: string, hash: string) => hash === 'unused' ? null : {}) };
    await queue.enqueueManual('p', req as any, resolved);
    expect((await queue.store.list('p'))[0].status).toBe('queued');
  });
  it('supersedes a live task when its bundle changes', async () => {
    vi.useFakeTimers();
    const queue = await subject();
    await queue.enqueueManual('p', req as any, resolved);
    await queue.enqueueManual('p', req as any, {
      ...resolved,
      bundleHash: 'b'.repeat(64),
    });
    expect((await queue.store.list('p')).map((t) => t.status)).toContain(
      'superseded'
    );
  });
  it('exports the exact submit policy constants', () => {
    expect(MAX_SUBMIT_ATTEMPTS).toBe(8);
    expect(SUBMIT_BACKOFF_MS).toEqual([5000, 15000, 45000, 120000, 300000]);
  });
  it('queues a derived contract-type capture with its dedicated origin', async () => {
    vi.useFakeTimers();
    const queue = await subject();
    (queue as any).bundles = { write: vi.fn(async () => 'b'.repeat(64)), read: vi.fn(async (_profile: string, hash: string) => hash === 'unused' ? null : {}) };
    const artifact = { abi: [{ type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] }], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.30', standardJsonInput: { language: 'Solidity', sources: { 'Admin.sol': { content: 'contract Admin {}' } }, settings: {} }, sourceIdentifier: 'Admin.sol:Admin' } as const;
    const run = { id: 'run', plan: { contracts: [{ id: 'proxy', origin: 'contract-type', pluginId: 'ct', artifactKey: 'proxy' }] }, inputs: { proxy: { bundleHash: 'unused' } }, explorerTargets: { '1': resolved.explorers } } as any;
    await queue.enqueueContractTypeCapture('p', run, 1, 'wrapper', 'proxy', 'admin', '0x0000000000000000000000000000000000000002', artifact, '0x0000000000000000000000000000000000000001');
    expect((await queue.store.list('p'))[0]).toMatchObject({ origin: { runId: 'run', stepId: 'wrapper', contractId: 'proxy', captureKey: 'admin' }, encodedConstructorArgs: '0x0000000000000000000000000000000000000001' });
  });
  it('does not auto-submit an unverified-provenance capture', async () => {
    vi.useFakeTimers();
    const queue = await subject();
    // The queue's store is rooted in the temporary Ignite home only through
    // its VerificationStore; inject a bundle reader to model a third-party
    // frozen wrapper without filesystem coupling.
    (queue as any).bundles = { write: vi.fn(async () => 'b'.repeat(64)), read: vi.fn(async () => ({ unverifiedProvenance: true })) };
    const artifact = { abi: [], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.30', standardJsonInput: { language: 'Solidity', sources: { 'Admin.sol': { content: 'contract Admin {}' } }, settings: {} }, sourceIdentifier: 'Admin.sol:Admin' } as const;
    await queue.enqueueContractTypeCapture('p', { id: 'run', plan: { contracts: [{ id: 'proxy', origin: 'contract-type', pluginId: 'ct' }] }, inputs: {}, explorerTargets: { '1': resolved.explorers } } as any, 1, 'wrapper', 'proxy', 'admin', '0x0000000000000000000000000000000000000002', artifact, '0x');
    expect(await queue.store.list('p')).toEqual([]);
  });
});
