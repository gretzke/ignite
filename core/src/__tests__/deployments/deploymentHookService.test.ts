import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginType } from '@ignite/plugin-types/types';
import { DescribeDeploymentHookResultSchema, OnRunCompletedResultSchema, SuggestAddressesResultSchema, type RunRecord } from '@ignite/api';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { DeploymentHookService } from '../../deployments/DeploymentHookService.js';
import { RunStore } from '../../deployments/RunStore.js';

const config: PluginConfig = {
  origin: 'installed', repoRead: false,
  metadata: { id: 'chronicles', types: [PluginType.DEPLOYMENT_HOOK], name: 'Chronicles', version: '1', baseImage: 'ignite/chronicles', operations: ['describeDeploymentHook', 'onRunCompleted', 'suggestAddresses'] },
};
const RUN_RECOVERED = '11111111-1111-4111-8111-111111111111';
const RUN_FIRST = '22222222-2222-4222-8222-222222222222';
const RUN_SECOND = '33333333-3333-4333-8333-333333333333';
const RUN_FAILED = '44444444-4444-4444-8444-444444444444';

describe('DeploymentHookService', () => {
  let home: string;

  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-hooks-')); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it('describes deployment hooks with none scope, strips controls, and caches', async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: { label: 'Chron\u0000icles', description: 'Writes history\u0007' } }));
    const service = new DeploymentHookService({ getProviders: vi.fn(async () => [config]), execute });
    await expect(service.list()).resolves.toEqual([{ pluginId: 'chronicles', label: 'Chronicles', description: 'Writes history' }]);
    await service.list();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('chronicles', 'describeDeploymentHook', {}, { chainScope: 'none' });
  });

  it('rejects malformed or oversized describe results with a typed error', async () => {
    const service = new DeploymentHookService({ getProviders: async () => [config], execute: async () => ({ success: true, data: { label: 'x'.repeat(65), description: 'bad' } }) });
    await expect(service.list()).rejects.toMatchObject({ code: 'DEPLOYMENT_HOOK_OP_FAILED' });
  });

  it('pins hook operation wire caps', () => {
    expect(() => DescribeDeploymentHookResultSchema.parse({ label: 'x'.repeat(65), description: 'ok' })).toThrow();
    expect(() => OnRunCompletedResultSchema.parse({ notes: Array.from({ length: 9 }, () => 'note') })).toThrow();
    expect(() => SuggestAddressesResultSchema.parse({ suggestions: Array.from({ length: 65 }, () => ({ chainId: 1, address: '0x1111111111111111111111111111111111111111' })) })).toThrow();
    expect(SuggestAddressesResultSchema.parse({ suggestions: [{ chainId: 1, address: '0x1111111111111111111111111111111111111111', label: 'Known' }] }).suggestions).toHaveLength(1);
  });

  it.each(['pending', 'running'] as const)('startup reconciliation re-dispatches a %s durable outbox entry', async (status) => {
    const store = new RunStore({ baseDir: home });
    const record = completedRun(RUN_RECOVERED);
    record.hookRuns = { chronicles: { status, ...(status === 'running' ? { jobId: 'old-job' } : {}) } };
    await store.create(record);
    const jobs = fakeJobs();
    const execute = vi.fn(async () => ({ success: true as const, data: { notes: ['recorded'] } }));
    const service = new DeploymentHookService({
      getProviders: async () => [config], execute, runStore: store,
      resolveWorkspace: async () => record.workflow!.repoPathOrUrl,
      canonicalize: async (value) => value, startJob: jobs.start,
    });

    await service.reconcileStartup();
    await jobs.drain();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.get(record.profileId, record.id)).toMatchObject({
      status: 'completed',
      hookRuns: { chronicles: { status: 'completed', jobId: expect.not.stringMatching(/^old-job$/), notes: ['recorded'] } },
    });
  });

  it('keeps the job runner in a canonical workflow-repo FIFO until hook completion', async () => {
    const store = new RunStore({ baseDir: home });
    const first = completedRun(RUN_FIRST); const second = completedRun(RUN_SECOND);
    await store.create(first); await store.create(second);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const execute = vi.fn(async (_id: string, _op: string, options: Record<string, unknown>) => {
      const artifact = options.artifact as { runId: string };
      order.push(`start:${artifact.runId}`);
      if (artifact.runId === first.id) await firstGate;
      order.push(`end:${artifact.runId}`);
      return { success: true as const, data: {} };
    });
    const jobs = fakeJobs();
    const service = new DeploymentHookService({
      getProviders: async () => [config], execute, runStore: store,
      resolveWorkspace: async () => '/same/repo', canonicalize: async () => '/canonical/repo', startJob: jobs.start,
    });

    await Promise.all([service.dispatch(first), service.dispatch(second)]);
    await eventually(() => order.length === 1);
    expect(order).toEqual([`start:${first.id}`]);
    releaseFirst();
    await jobs.drain();
    expect(order).toEqual([`start:${first.id}`, `end:${first.id}`, `start:${second.id}`, `end:${second.id}`]);
  });

  it('records hook failure without changing the terminal run outcome', async () => {
    const store = new RunStore({ baseDir: home });
    const record = completedRun(RUN_FAILED); await store.create(record);
    const jobs = fakeJobs();
    const service = new DeploymentHookService({
      getProviders: async () => [config],
      execute: async () => { throw new Error('hook exploded'); },
      runStore: store, resolveWorkspace: async () => '/repo', canonicalize: async (value) => value, startJob: jobs.start,
    });
    await service.dispatch(record); await jobs.drain();
    expect(await store.get(record.profileId, record.id)).toMatchObject({
      status: 'completed', hookRuns: { chronicles: { status: 'failed', error: 'hook exploded' } },
    });
  });

  it('validates and checksums suggestion results while timeout and invalid plugins degrade to omission', async () => {
    const invalid = { ...config, metadata: { ...config.metadata, id: 'invalid' } };
    const slow = { ...config, metadata: { ...config.metadata, id: 'slow' } };
    let slowSignal: AbortSignal | undefined;
    const service = new DeploymentHookService({
      getProviders: async () => [config, invalid, slow],
      execute: async (id, _operation, _request, opts) => {
        if (id === 'slow') { slowSignal = opts.signal; return new Promise(() => undefined); }
        if (id === 'invalid') return { success: true, data: { suggestions: [{ chainId: 1, address: 'not-an-address' }] } } as never;
        return { success: true, data: { suggestions: [{ chainId: 1, address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', label: 'known' }] } };
      },
    });
    await expect(service.suggest(['chronicles', 'invalid', 'slow'], '/repo', { chainIds: [1], contractName: 'Token' }, 5)).resolves.toEqual([
      { pluginId: 'chronicles', chainId: 1, address: '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD', label: 'known' },
    ]);
    expect(slowSignal?.aborted).toBe(true);
  });

  it('includes verification tasks fetched at hook fire time in the payload artifact', async () => {
    const store = new RunStore({ baseDir: home });
    const record = completedRun('55555555-5555-4555-8555-555555555555'); await store.create(record);
    const jobs = fakeJobs();
    const execute = vi.fn(async (_id: string, _operation: string, options: Record<string, unknown>) => {
      expect(options.artifact).toHaveProperty('verifications.c.0.status', 'verified');
      return { success: true as const, data: {} };
    });
    const service = new DeploymentHookService({
      getProviders: async () => [config], execute, runStore: store,
      resolveWorkspace: async () => '/repo', canonicalize: async (value) => value, startJob: jobs.start,
      listVerificationTasks: async () => [{
        id: 'verification', chainId: 1, address: '0x1111111111111111111111111111111111111111', bundleHash: 'b'.repeat(64), encodedConstructorArgs: '0x',
        explorer: { entryId: 'scan', url: 'https://scan.test', verifierPluginId: 'etherscan', label: 'Scan' },
        origin: { runId: record.id, stepId: 's', contractId: 'c' }, status: 'verified', attempts: [], createdAt: record.createdAt, updatedAt: record.updatedAt,
      } as never],
    });
    await service.dispatch(record); await jobs.drain();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function completedRun(id: string): RunRecord {
  const hash = 'a'.repeat(64);
  return {
    schemaVersion: 1, id, profileId: 'profile', name: id, idempotencyKey: `key-${id}`,
    createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:01.000Z', status: 'completed',
    workflow: { repoPathOrUrl: '/workflow/repo', name: 'release', docHash: hash, hooks: ['chronicles'] },
    plan: { schemaVersion: 1, chains: [1], signers: {}, contracts: [{ id: 'c', repoPathOrUrl: '/source', frameworkId: 'foundry', artifactPath: 'out/C.json', contractName: 'C', sourcePath: 'src/C.sol' }], steps: [{ id: 's', kind: 'deploy', contractId: 'c' }] },
    inputs: { c: { abi: [], creationBytecode: '0x6000', compiler: { pluginId: 'foundry', version: '1', settingsHash: hash }, artifactHash: hash, repoDirty: false } },
    rpcSelection: { '1': { endpointId: 'rpc', label: 'RPC', urlFingerprint: hash } },
    validation: { chains: { '1': { rpc: item(), signers: item(), args: item(), estimation: item(), balance: item(), inputs: item() } } },
    lanes: { '1': { chainId: 1, status: 'completed', currentStepIndex: 1, steps: [{ stepId: 's', status: 'confirmed', address: '0x1111111111111111111111111111111111111111', attempts: [] }] } },
    hookRuns: { chronicles: { status: 'pending' } },
  };
}
const item = () => ({ ok: true, blocking: false, message: 'ok' });

function fakeJobs() {
  let sequence = 0;
  const pending: Promise<unknown>[] = [];
  const start = vi.fn((_type: string, _params: Record<string, unknown>, runner: (ctx: { log: (line: string) => void; signal: AbortSignal }) => Promise<unknown>) => {
    const job = { id: `job-${++sequence}` };
    pending.push(Promise.resolve().then(() => runner({ log: () => undefined, signal: new AbortController().signal })).catch(() => undefined));
    return job;
  });
  return { start, drain: async () => { await Promise.all(pending); } };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}
