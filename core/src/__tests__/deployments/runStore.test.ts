import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@ignite/api';
import { RunStore } from '../../deployments/RunStore.js';

const HASH = 'a'.repeat(64);

function run(id = 'run-1'): RunRecord {
  return {
    schemaVersion: 1,
    id,
    profileId: 'profile-1',
    name: 'Example deployment',
    idempotencyKey: `key-${id}`,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    plan: {
      schemaVersion: 1,
      contracts: [{ id: 'c', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'a', contractName: 'C', sourcePath: 'C.sol' }],
      steps: [{ id: 's', kind: 'deploy', contractId: 'c' }],
      chains: [1],
      signers: {},
    },
    inputs: { c: { abi: [], creationBytecode: '0x6000', compiler: { pluginId: 'f', version: '1', settingsHash: HASH }, artifactHash: HASH, repoDirty: false } },
    rpcSelection: {
      '1': { endpointId: 'rpc-1', label: 'Anvil', urlFingerprint: HASH },
    },
    validation: {
      chains: {
        '1': {
          rpc: { ok: true, blocking: true, message: 'ok' },
          signers: { ok: true, blocking: true, message: 'ok' },
          args: { ok: true, blocking: true, message: 'ok' },
          estimation: { ok: true, blocking: true, message: 'ok' },
          balance: { ok: true, blocking: true, message: 'ok' },
          inputs: { ok: true, blocking: true, message: 'ok' },
        },
      },
    },
    lanes: {
      '1': {
        chainId: 1,
        status: 'pending',
        currentStepIndex: 0,
        steps: [],
      },
    },
    status: 'running',
  };
}

describe('RunStore', () => {
  let home: string;
  let store: RunStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-runs-'));
    store = new RunStore({ baseDir: home });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('serializes concurrent mutations without losing updates', async () => {
    const record = run();
    await store.create(record);

    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.mutate('profile-1', record.id, (current) => {
          current.name += '!';
        })
      )
    );

    expect((await store.get('profile-1', record.id))?.name).toBe(
      `${record.name}${'!'.repeat(50)}`
    );
  });

  it('propagates a mutation error and leaves the persisted record unchanged', async () => {
    const record = run();
    await store.create(record);
    await expect(
      store.mutate('profile-1', record.id, () => {
        throw new Error('no write');
      })
    ).rejects.toThrow('no write');
    expect(await store.get('profile-1', record.id)).toEqual(record);
  });

  it('quarantines corrupt and unknown-version records and reports them as unreadable', async () => {
    const dir = path.join(home, 'profiles', 'profile-1', 'deployments', 'runs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'corrupt.json'), '{ nope');
    await fs.writeFile(
      path.join(dir, 'future.json'),
      JSON.stringify({ ...run('future'), schemaVersion: 99 })
    );

    await store.recoverStartup();

    expect(await fs.stat(path.join(dir, 'corrupt.json.bad'))).toBeDefined();
    expect(await fs.stat(path.join(dir, 'future.json.bad'))).toBeDefined();
    await expect(fs.access(path.join(dir, 'corrupt.json'))).rejects.toThrow();
    expect((await store.list('profile-1')).unreadable).toEqual([
      'corrupt',
      'future',
    ]);
  });

  it('recovery claims pending and running lanes while leaving terminal lanes alone', async () => {
    const record = run();
    record.lanes = {
      '1': { chainId: 1, status: 'pending', currentStepIndex: 0, steps: [] },
      '2': { chainId: 2, status: 'running', currentStepIndex: 0, steps: [] },
      '3': { chainId: 3, status: 'completed', currentStepIndex: 0, steps: [] },
    };
    await store.create(record);

    const recovered = await store.recoverStartup();
    const claimed = recovered[0];
    expect(claimed.lanes['1']).toMatchObject({
      status: 'paused',
      pause: { reason: 'interrupted' },
    });
    expect(claimed.lanes['2']).toMatchObject({
      status: 'paused',
      pause: { reason: 'interrupted' },
    });
    expect(claimed.lanes['3'].status).toBe('completed');
  });

  it('recovery preserves an existing pause instead of re-stamping it as interrupted', async () => {
    const record = run();
    record.lanes = {
      '1': {
        chainId: 1,
        status: 'paused',
        currentStepIndex: 0,
        pause: {
          reason: 'revert',
          stepIndex: 0,
          error: 'Constructor reverted',
          attemptId: 'attempt-1',
        },
        steps: [],
      },
      '2': { chainId: 2, status: 'running', currentStepIndex: 0, steps: [] },
    };
    record.status = 'paused';
    await store.create(record);

    const recovered = await store.recoverStartup();
    const claimed = recovered[0];
    expect(claimed.lanes['1'].pause).toMatchObject({
      reason: 'revert',
      error: 'Constructor reverted',
      attemptId: 'attempt-1',
    });
    expect(claimed.lanes['2'].pause).toMatchObject({ reason: 'interrupted' });
  });

  it('returns an existing run for its profile idempotency key', async () => {
    const record = run();
    await store.create(record);
    expect(
      await store.findByIdempotencyKey('profile-1', record.idempotencyKey)
    ).toEqual(record);
    await expect(
      store.create({ ...run('run-2'), idempotencyKey: record.idempotencyKey })
    ).rejects.toThrow(/idempotency/i);
  });
});
