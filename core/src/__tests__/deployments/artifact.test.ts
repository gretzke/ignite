import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@ignite/api';
import { renderArtifact, writeArtifact } from '../../deployments/artifact.js';

const FINGERPRINT = 'f'.repeat(64);
const RAW_TX = '0xdeadbeef';

function run(): RunRecord {
  return {
    schemaVersion: 1,
    id: 'run-1',
    profileId: 'profile-1',
    name: 'Deploy token',
    idempotencyKey: 'key-1',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:01:00.000Z',
    status: 'completed',
    plan: {
      schemaVersion: 1,
      chains: [1],
      signers: {
        global: {
          pluginId: 'key',
          accountId: 'one',
          address: '0x0000000000000000000000000000000000000001',
        },
      },
      contracts: [
        {
          id: 'token',
          repoPathOrUrl: '/Users/daniel/private/token-repo',
          frameworkId: 'foundry',
          artifactPath: 'out/Token.json',
          contractName: 'Token',
          sourcePath: '/Users/daniel/private/token-repo/src/Token.sol',
        },
      ],
      steps: [
        {
          id: 'deploy-token',
          kind: 'deploy',
          contractId: 'token',
          args: { supply: '100' },
        },
      ],
    },
    inputs: {
      token: {
        abi: [],
        creationBytecode: '0x6000',
        compiler: {
          pluginId: 'foundry',
          version: '1.0.0',
          settingsHash: 'a'.repeat(64),
        },
        artifactHash: 'b'.repeat(64),
        repoDirty: false,
      },
    },
    rpcSelection: {
      '1': {
        endpointId: 'rpc-1',
        label: 'Secret RPC',
        urlFingerprint: FINGERPRINT,
      },
    },
    validation: {
      chains: {
        '1': {
          rpc: {
            ok: false,
            blocking: true,
            message: 'Failed at https://rpc.example/KEY',
          },
          signers: { ok: true, blocking: false, message: 'ok' },
          args: { ok: true, blocking: false, message: 'ok' },
          estimation: { ok: true, blocking: false, message: 'ok' },
          balance: { ok: true, blocking: false, message: 'ok' },
          inputs: { ok: true, blocking: false, message: 'ok' },
        },
      },
    },
    lanes: {
      '1': {
        chainId: 1,
        status: 'completed',
        currentStepIndex: 1,
        steps: [
          {
            stepId: 'deploy-token',
            status: 'confirmed',
            address: '0x0000000000000000000000000000000000000002',
            attempts: [
              {
                id: 'attempt-1',
                startedAt: '2026-07-10T00:00:00.000Z',
                endedAt: '2026-07-10T00:01:00.000Z',
                rawTx: RAW_TX,
                txHash: '0x1234',
                nonce: 1,
                gasUsed: '21000',
                effectiveGasPrice: '10',
                blockNumber: 2,
                txStatus: 'success',
                error: 'see https://rpc.example/KEY',
              },
            ],
          },
        ],
      },
    },
  };
}

describe('deployment artifact renderer', () => {
  let temp: string | undefined;

  afterEach(async () => {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  });

  it('renders a portable, sanitized artifact and writes it under the profile', async () => {
    const record = run();
    record.validation.chains['1'].rpc.details = {
      nested: ['file:///Volumes/private/contracts', { remote: 'ssh://user:secret@example.test/private/repo.git' }],
      absolute: '/srv/company/internal/config.json',
    };
    record.lanes['1'].steps[0].attempts[0].error = 'file:///Volumes/private/key ssh://user:secret@example.test/repo /srv/private/key';
    const artifact = renderArtifact(record);
    const json = JSON.stringify(artifact);

    expect(json).not.toContain(RAW_TX);
    expect(json).not.toContain(FINGERPRINT);
    expect(json).not.toContain('/Users/');
    expect(json.toLowerCase()).not.toContain('http');
    expect(json).not.toContain('file://');
    expect(json).not.toContain('ssh://');
    expect(json).not.toContain('/srv/');
    expect(json).not.toContain('secret@example');
    expect(artifact.contracts[0]).toMatchObject({
      repoName: 'token-repo',
      sourcePath: 'Token.sol',
      contractName: 'Token',
    });
    expect(artifact.lanes['1'].steps[0].attempts[0]).not.toHaveProperty(
      'rawTx'
    );

    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-artifacts-'));
    const file = await writeArtifact(record, { baseDir: temp });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(artifact);
  });

  it('has a load-bearing sanitizer: verbatim run data would fail every invariant', () => {
    const record = run();
    const unsafe = JSON.stringify(record);
    expect(unsafe).toContain(RAW_TX);
    expect(unsafe).toContain(FINGERPRINT);
    expect(unsafe).toContain('/Users/');
    expect(unsafe.toLowerCase()).toContain('http');
  });

  it('keeps the core-constructed explorer link and passes its own schema with verification outcomes', async () => {
    const { DeploymentArtifactSchema } = await import('@ignite/api');
    const artifact = renderArtifact(run(), [
      {
        id: 't1',
        chainId: 1,
        address: '0x1111111111111111111111111111111111111111',
        bundleHash: 'a'.repeat(64),
        encodedConstructorArgs: '0x',
        explorer: {
          entryId: 'manual:e1',
          url: 'https://scan.test',
          verifierPluginId: 'etherscan',
          label: 'Scan',
        },
        explorerPageUrl:
          'https://scan.test/address/0x1111111111111111111111111111111111111111',
        origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token' },
        status: 'verified',
        attempts: [],
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      } as never,
    ]);
    // A redacted link previously failed schema validation and silently broke
    // every post-verification artifact write (final-review finding).
    const parsed = DeploymentArtifactSchema.parse(artifact);
    const outcome = Object.values(parsed.verifications ?? {})[0]?.[0];
    expect(outcome?.explorerPageUrl).toBe(
      'https://scan.test/address/0x1111111111111111111111111111111111111111'
    );
    expect(outcome?.status).toBe('verified');
  });

  it('copies workflow artifacts into the repo and records a written outcome', async () => {
    const record = run();
    record.workflow = { repoPathOrUrl: '/workflow', name: 'release', hooks: [], docHash: 'c'.repeat(64) };
    const writeRepoFile = vi.fn(async () => ({ success: true as const, data: null }));
    const mutate = vi.fn(async (_profileId: string, _runId: string, fn: (draft: RunRecord) => void) => {
      fn(record); return record;
    });
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-artifacts-'));

    await writeArtifact(record, { baseDir: temp, repoService: { writeRepoFile }, runStore: { mutate }, now: () => Date.parse('2026-07-14T12:00:00.000Z') });

    expect(writeRepoFile).toHaveBeenCalledWith('/workflow', 'ignite/deployments/release/run-1.json', `${JSON.stringify(renderArtifact(record), null, 2)}\n`);
    expect(record.repoArtifact).toEqual({ path: 'ignite/deployments/release/run-1.json', status: 'written', updatedAt: '2026-07-14T12:00:00.000Z' });
  });

  it('keeps the profile artifact authoritative and records a failed repo-copy outcome', async () => {
    const record = run();
    record.workflow = { repoPathOrUrl: '/workflow', name: 'release', hooks: [], docHash: 'c'.repeat(64) };
    const mutate = vi.fn(async (_profileId: string, _runId: string, fn: (draft: RunRecord) => void) => { fn(record); return record; });
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-artifacts-'));
    const file = await writeArtifact(record, {
      baseDir: temp,
      repoService: { writeRepoFile: async () => ({ success: false as const, error: { code: 'FILE_WRITE_ERROR', message: 'read only' } }) },
      runStore: { mutate }, now: () => Date.parse('2026-07-14T12:00:00.000Z'),
    });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).runId).toBe(record.id);
    expect(record.repoArtifact).toEqual({ path: 'ignite/deployments/release/run-1.json', status: 'failed', error: 'read only', updatedAt: '2026-07-14T12:00:00.000Z' });
  });
});
