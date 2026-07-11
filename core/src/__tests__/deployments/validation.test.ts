import { describe, it, expect, vi } from 'vitest';
import type { DeploymentPlan, FrozenInputs } from '@ignite/api';
import { validatePlan } from '../../deployments/validation.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const HASH = 'b'.repeat(64);

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    schemaVersion: 1,
    chains: [1],
    contracts: [
      {
        id: 'token',
        repoPathOrUrl: '/repo/token',
        frameworkId: 'foundry',
        artifactPath: 'out/Token.json',
        contractName: 'Token',
        sourcePath: 'src/Token.sol',
      },
    ],
    signers: {
      global: { pluginId: 'key', accountId: 'account', address: ADDRESS },
    },
    steps: [
      {
        id: 'deploy-token',
        kind: 'deploy',
        contractId: 'token',
        args: { supply: '1' },
      },
    ],
    ...overrides,
  };
}

const frozen: FrozenInputs = {
  token: {
    abi: [
      { type: 'constructor', inputs: [{ name: 'supply', type: 'uint256' }] },
    ],
    creationBytecode: '0x60006000',
    compiler: { pluginId: 'foundry', version: '1.0.0', settingsHash: HASH },
    artifactHash: HASH,
    repoDirty: false,
  },
};

function deps(overrides: Record<string, unknown> = {}): any {
  const estimateGas = vi.fn(async () => 100n);
  const getBalance = vi.fn(async () => 10_000n);
  const estimateFeesPerGas = vi.fn(async () => ({
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  }));
  const updateVerification = vi.fn(async () => undefined);
  return {
    freezeInputs: vi.fn(async () => frozen),
    resolveRpcEndpoint: vi.fn(async (_chainId: number, endpointId: string) => ({
      id: endpointId,
      label: 'Anvil',
      url: 'https://rpc.example/secret',
    })),
    verifyRpcEndpoint: vi.fn(async () => ({
      ok: true,
      reportedChainId: 1,
      chainIdMatch: true,
      blockAgeSeconds: 2,
      checkedAt: '2026-07-10T00:00:00.000Z',
    })),
    updateVerification,
    listAccounts: vi.fn(async () => [
      {
        pluginId: 'key',
        name: 'Key',
        state: 'ok',
        accounts: [{ id: 'account', address: ADDRESS }],
      },
    ]),
    createClient: vi.fn(() => ({
      estimateGas: overrides.estimateGas ?? estimateGas,
      getBalance: overrides.getBalance ?? getBalance,
      estimateFeesPerGas: overrides.estimateFeesPerGas ?? estimateFeesPerGas,
    })),
    estimateGas,
    getBalance,
    estimateFeesPerGas,
    ...overrides,
  };
}

describe('validatePlan', () => {
  it('reports an unresolved signer only on the affected chain', async () => {
    const d = deps({
      listAccounts: vi.fn(async () => [
        { pluginId: 'key', name: 'Key', state: 'ok', accounts: [] },
      ]),
    });
    const result = await validatePlan(
      plan({ chains: [1, 2] }),
      { '1': 'rpc-1', '2': 'rpc-2' },
      d
    );
    expect(result.report.chains['1'].signers).toMatchObject({
      ok: false,
      blocking: true,
      code: 'SIGNER_ACCOUNT_NOT_FOUND',
    });
    expect(result.report.chains['2'].signers.ok).toBe(false);
    // Runs two full per-chain validations against fake RPC timing; the
    // default 5s budget is borderline on a loaded machine.
  }, 15_000);

  it('names missing constructor args in details', async () => {
    const result = await validatePlan(
      plan({
        steps: [{ id: 'deploy-token', kind: 'deploy', contractId: 'token' }],
      }),
      { '1': 'rpc-1' },
      deps()
    );
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'MISSING_ARGUMENT',
      details: { fields: ['supply'] },
    });
  });

  it('aggregates balance requirements for steps sharing a signer', async () => {
    const d = deps({ getBalance: vi.fn(async () => 2_500n) });
    const result = await validatePlan(
      plan({
        steps: [
          {
            id: 'one',
            kind: 'deploy',
            contractId: 'token',
            args: { supply: '1' },
          },
          {
            id: 'two',
            kind: 'deploy',
            contractId: 'token',
            args: { supply: '2' },
          },
        ],
      }),
      { '1': 'rpc-1' },
      d
    );
    expect(result.report.chains['1'].balance).toMatchObject({
      ok: true,
      details: { requiredWei: '2400' },
    });
  });

  it('marks legacy fee support as a blocking checklist failure', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        estimateFeesPerGas: vi.fn(async () => {
          throw new Error('legacy');
        }),
      })
    );
    expect(result.report.chains['1'].rpc).toMatchObject({
      ok: false,
      blocking: true,
      code: 'LEGACY_FEES_UNSUPPORTED',
    });
  });

  it('still estimates a constructor when gasLimit is overridden', async () => {
    const estimateGas = vi.fn(async () => {
      throw new Error('constructor reverted');
    });
    const result = await validatePlan(
      plan({
        steps: [
          {
            id: 'deploy-token',
            kind: 'deploy',
            contractId: 'token',
            args: { supply: '1' },
            gasOverrides: { gasLimit: '1' },
          },
        ],
      }),
      { '1': 'rpc-1' },
      deps({ estimateGas })
    );
    expect(estimateGas).toHaveBeenCalledOnce();
    expect(result.report.chains['1'].estimation).toMatchObject({
      ok: false,
      blocking: true,
      code: 'ESTIMATION_FAILED',
    });
  });

  it('annotates stale blocks without blocking and persists stored-endpoint verification', async () => {
    const d = deps({
      verifyRpcEndpoint: vi.fn(async () => ({
        ok: true,
        reportedChainId: 1,
        chainIdMatch: true,
        blockAgeSeconds: 999,
        checkedAt: '2026-07-10T00:00:00.000Z',
      })),
    });
    const result = await validatePlan(plan(), { '1': 'rpc-1' }, d);
    expect(result.report.chains['1'].rpc).toMatchObject({
      ok: true,
      blocking: false,
      details: { blockAgeSeconds: 999 },
    });
    expect(d.updateVerification).toHaveBeenCalledOnce();
  });

  it('turns unlinked library references into an inputs failure', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        freezeInputs: vi.fn(async () => {
          throw Object.assign(new Error('link'), {
            code: 'LIBRARY_LINKING_UNSUPPORTED',
          });
        }),
      })
    );
    expect(result.report.chains['1'].inputs).toMatchObject({
      ok: false,
      blocking: true,
      code: 'LIBRARY_LINKING_UNSUPPORTED',
    });
  });
});
