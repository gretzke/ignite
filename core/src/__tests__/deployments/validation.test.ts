import { describe, it, expect, vi } from 'vitest';
import {
  CREATE2_PROXY_ADDRESS,
  CREATE2_PROXY_RUNTIME_CODE,
  type DeploymentPlan,
  type FrozenInputs,
} from '@ignite/api';
import { validatePlan } from '../../deployments/validation.js';
import { initcodeHashOf, predictCreate2Address } from '../../deployments/create2.js';
import { buildChainPredictions, buildInitcode } from '../../deployments/schedule.js';

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
    captureBundles: vi.fn(async (inputs: FrozenInputs) => {
      for (const input of Object.values(inputs)) input.bundleHash = HASH;
      return { token: { bundleHash: HASH } };
    }),
    resolveExplorers: vi.fn(async () => []),
    resolveVerifierTrust: vi.fn(async () => ({
      metadata: { configFields: [] },
      grant: { trust: 'native', net: true, repoWrite: true, secrets: [] },
    })),
    ...overrides,
  };
}

describe('validatePlan', () => {
  it('builds one nonce snapshot and keeps dynamic plugin estimates provisional', async () => {
    const nonce = vi.fn(async () => 7);
    const salt = `0x${'22'.repeat(32)}` as const;
    const prepared = vi.fn(async (_pluginId: string, input: { initcode: `0x${string}` }) => ({ salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf(input.initcode)), notes: ['mined'] }));
    const hookFrozen = { ...frozen, hook: { ...frozen.token, abi: [{ type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] }] } };
    const snapshot = await buildChainPredictions(plan({ steps: [
      { id: 'plain', kind: 'deploy', contractId: 'token', args: { supply: '1' } },
      { id: 'hook', kind: 'deploy', contractId: 'hook', args: { owner: { $ref: { kind: 'step', stepId: 'plain' } } }, strategy: { kind: 'plugin', pluginId: 'hook', prepared: { '1': { predictedAddress: ADDRESS, initcodeHash: `0x${'44'.repeat(32)}` } } } },
    ] }), hookFrozen, 1, { client: { getTransactionCount: nonce }, deploymentTypes: { prepare: prepared } as any });
    expect(nonce).toHaveBeenCalledOnce();
    expect(prepared).toHaveBeenCalledOnce();
    expect(snapshot.entries.hook).toMatchObject({ provisional: true, notes: ['mined'] });
    expect(snapshot.predictions.hook).toBeUndefined();
  });

  it('single-flights only byte-identical validation requests', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const freezeInputs = vi.fn(async () => {
      await blocked;
      return frozen;
    });
    const d = deps({
      freezeInputs,
      makeForkRunner: vi.fn(async () => undefined),
    });
    const first = validatePlan(plan(), { '1': 'rpc-1' }, d);
    const second = validatePlan(plan(), { '1': 'rpc-1' }, d);
    release();
    await Promise.all([first, second]);
    expect(freezeInputs).toHaveBeenCalledOnce();
  });

  it('validates the canonical proxy and returns create2 predictions without broadcasting', async () => {
    const getCode = vi.fn(async ({ address }: { address: string }) =>
      address.toLowerCase() === CREATE2_PROXY_ADDRESS.toLowerCase()
        ? CREATE2_PROXY_RUNTIME_CODE
        : '0x'
    );
    const result = await validatePlan(
      plan({
        steps: [
          {
            id: 'deploy-token',
            kind: 'deploy',
            contractId: 'token',
            args: { supply: '1' },
            strategy: { kind: 'create2', salt: `0x${'11'.repeat(32)}` },
          },
        ],
      }),
      { '1': 'rpc-1' },
      deps({
        createClient: vi.fn(() => ({
          estimateGas: vi.fn(async () => 100n),
          getBalance: vi.fn(async () => 10_000n),
          estimateFeesPerGas: vi.fn(async () => ({
            maxFeePerGas: 10n,
            maxPriorityFeePerGas: 1n,
          })),
          getCode,
        })),
      })
    );
    expect(result.report.chains['1'].create2).toMatchObject({ ok: true });
    expect(result.predicted?.['1']?.['deploy-token']?.predictedAddress).toMatch(
      /^0x[0-9a-f]{40}$/i
    );
    expect(getCode).toHaveBeenCalledWith({ address: CREATE2_PROXY_ADDRESS });
  });
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
  });

  it('names missing constructor args in details', async () => {
    const encodedStepId =
      'deploy-%2FUsers%2Fdaniel%2Fcontracts:foundry:out%2FToken.json:Token';
    const result = await validatePlan(
      plan({
        steps: [{ id: encodedStepId, kind: 'deploy', contractId: 'token' }],
      }),
      { '1': 'rpc-1' },
      deps()
    );
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'MISSING_ARGUMENT',
      message: 'Constructor arguments are missing for Token',
      details: { fields: ['supply'] },
    });
    expect(result.report.chains['1'].args.message).not.toContain('%2F');
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
    const encodedStepId =
      'deploy-%2FUsers%2Fdaniel%2Fcontracts:foundry:out%2FToken.json:Token';
    const estimateGas = vi.fn(async () => {
      throw new Error('constructor reverted');
    });
    const result = await validatePlan(
      plan({
        steps: [
          {
            id: encodedStepId,
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
      message: 'Estimation failed at Token: constructor reverted',
    });
    expect(result.report.chains['1'].simulation?.message).toBe(
      'Simulation reverted at Token: constructor reverted'
    );
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

  it('passes linked runtime bytecode to deployment-type validation', async () => {
    const salt = `0x${'12'.repeat(32)}` as const;
    const deploy = { id: 'deploy-token', kind: 'deploy' as const, contractId: 'token', args: { supply: '1' }, libraries: { 'src/R.sol:R': { kind: 'address' as const, address: '0x0000000000000000000000000000000000000002' as const } } };
    const hash = initcodeHashOf(buildInitcode(deploy, frozen.token, 1, () => { throw new Error('unexpected'); }));
    const predictedAddress = predictCreate2Address(salt, hash);
    const validate = vi.fn(async () => ({ ok: true }));
    await validatePlan(plan({
      steps: [{ ...deploy, strategy: { kind: 'plugin', pluginId: 'hook', salt, prepared: { '1': { initcodeHash: hash, predictedAddress } } } }],
    }), { '1': 'rpc-1' }, deps({
      freezeInputs: vi.fn(async () => ({ token: { ...frozen.token, runtimeBytecode: `0x60${'zz'.repeat(20)}00`, runtimeBytecodeLinkReferences: { 'src/R.sol': { R: [{ start: 1, length: 20 }] } } } })),
      deploymentTypes: { list: vi.fn(async () => [{ pluginId: 'hook', label: 'Hook', description: 'Hook', params: [], validateSupported: true }]), validate },
      createClient: vi.fn(() => ({ estimateGas: vi.fn(async () => 100n), getBalance: vi.fn(async () => 10_000n), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })), getCode: vi.fn(async ({ address }: { address: string }) => address.toLowerCase() === CREATE2_PROXY_ADDRESS.toLowerCase() ? CREATE2_PROXY_RUNTIME_CODE : '0x') })),
    }));
    expect(validate).toHaveBeenCalledWith('hook', expect.objectContaining({ runtimeBytecode: `0x60${'0000000000000000000000000000000000000002'}00` }));
  });

  it('keeps a bundle coherence failure as a non-blocking verification warning when nothing is selected', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        captureBundles: vi.fn(async () => ({
          token: { error: 'creation mismatch' },
        })),
      })
    );
    expect(result.report.chains['1'].verification).toMatchObject({
      ok: false,
      blocking: false,
      code: 'VERIFICATION_BUNDLE_UNAVAILABLE',
    });
    expect(result.report.chains['1'].args.ok).toBe(true);
  });

  it('fails verification when selected explorers lack a captured bundle', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        explorerSelection: { '1': ['manual:one'] },
        captureBundles: vi.fn(async () => ({
          token: { error: 'creation mismatch' },
        })),
        resolveExplorers: vi.fn(async () => [
          {
            id: 'manual:one',
            chainId: 1,
            url: 'http://explorer.test',
            source: 'manual',
            verifierPluginId: 'etherscan',
            label: 'Test explorer',
          },
        ]),
      })
    );
    expect(result.report.chains['1'].verification).toMatchObject({
      ok: false,
      blocking: true,
      code: 'VERIFICATION_BUNDLE_UNAVAILABLE',
    });
  });

  it('accepts a configured verifier when its grants cover network and secrets', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        explorerSelection: { '1': ['manual:one'] },
        resolveExplorers: vi.fn(async () => [
          {
            id: 'manual:one',
            chainId: 1,
            url: 'http://explorer.test',
            source: 'manual',
            verifierPluginId: 'custom-verifier',
            label: 'Test explorer',
          },
        ]),
        resolveVerifierTrust: vi.fn(async () => ({
          metadata: { configFields: [{ key: 'apiKey', secret: true }] },
          grant: {
            trust: 'trusted',
            net: true,
            repoWrite: false,
            secrets: ['apiKey'],
          },
        })),
      })
    );
    expect(result.report.chains['1'].verification).toMatchObject({ ok: true });
  });

  it('blocks a configured verifier without a network grant', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        explorerSelection: { '1': ['manual:one'] },
        resolveExplorers: vi.fn(async () => [
          {
            id: 'manual:one',
            chainId: 1,
            url: 'http://explorer.test',
            source: 'manual',
            verifierPluginId: 'custom-verifier',
            label: 'Test explorer',
          },
        ]),
        resolveVerifierTrust: vi.fn(async () => ({
          metadata: { configFields: [] },
          grant: {
            trust: 'trusted',
            net: false,
            repoWrite: false,
            secrets: [],
          },
        })),
      })
    );
    expect(result.report.chains['1'].verification).toMatchObject({
      ok: false,
      blocking: true,
      code: 'VERIFIER_TRUST_REQUIRED',
      message: 'Verifier custom-verifier is missing the net trust grant',
      details: { pluginId: 'custom-verifier', missingGrant: 'net' },
    });
  });

  it('blocks a verifier without every declared secret-field grant', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        explorerSelection: { '1': ['manual:one'] },
        resolveExplorers: vi.fn(async () => [
          {
            id: 'manual:one',
            chainId: 1,
            url: 'http://explorer.test',
            source: 'manual',
            verifierPluginId: 'custom-verifier',
            label: 'Test explorer',
          },
        ]),
        resolveVerifierTrust: vi.fn(async () => ({
          metadata: { configFields: [{ key: 'apiKey', secret: true }] },
          grant: { trust: 'trusted', net: true, repoWrite: false, secrets: [] },
        })),
      })
    );
    expect(result.report.chains['1'].verification).toMatchObject({
      ok: false,
      blocking: true,
      code: 'VERIFIER_TRUST_REQUIRED',
      message:
        'Verifier custom-verifier is missing trust grants for secret config fields: apiKey',
      details: { pluginId: 'custom-verifier', missingGrant: ['apiKey'] },
    });
  });

  it('accepts keyless sourcify with a network grant', async () => {
    const result = await validatePlan(
      plan(),
      { '1': 'rpc-1' },
      deps({
        explorerSelection: { '1': ['manual:one'] },
        resolveExplorers: vi.fn(async () => [
          {
            id: 'manual:one',
            chainId: 1,
            url: 'http://explorer.test',
            source: 'manual',
            verifierPluginId: 'sourcify',
            label: 'Sourcify',
          },
        ]),
        resolveVerifierTrust: vi.fn(async () => ({
          metadata: { configFields: [{ key: 'apiUrl', secret: false }] },
          grant: { trust: 'trusted', net: true, repoWrite: false, secrets: [] },
        })),
      })
    );
    expect(result.report.chains['1'].verification).toMatchObject({ ok: true });
  });

  it('adds run-level workflow/output items and blocks pinned artifact drift', async () => {
    const expected = 'a'.repeat(64);
    const pinned = plan({ contracts: [{ ...plan().contracts[0], repoPathOrUrl: 'https://source.test/repo.git', pin: { url: 'https://source.test/repo.git', commit: 'c'.repeat(40) } }] });
    const workflow = {
      document: {
        schemaVersion: 1, description: undefined,
        sources: [{ id: 'token', repo: { url: 'https://source.test/repo.git', commit: 'c'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/Token.sol', contractName: 'Token', artifactPath: 'out/Token.json', artifactHash: expected }],
        steps: [{ id: 'deploy-token', kind: 'deploy', contractId: 'token' }],
        defaultChains: undefined, requiredPlugins: [], outputs: { hooks: ['chronicles', 'missing'] },
      },
      binding: { repoPathOrUrl: '/workflow', name: 'release', docHash: 'e'.repeat(64), hooks: ['chronicles', 'missing'] },
    };
    const result = await validatePlan(pinned, { '1': 'rpc-1' }, deps({
      workflow,
      resolveHookStatus: vi.fn(async (id: string) => id === 'chronicles' ? 'ready' : 'missing'),
    }));
    expect(result.report.run?.workflow).toMatchObject({ ok: true, blocking: false });
    expect(result.report.run?.outputs).toMatchObject({ ok: false, blocking: false, code: 'WORKFLOW_HOOKS_UNAVAILABLE', details: { pluginIds: ['missing'] } });
    expect(result.report.chains['1'].inputs).toMatchObject({ ok: false, blocking: true, code: 'WORKFLOW_ARTIFACT_DRIFT', details: { drifts: [{ sourceId: 'token', expected, actual: HASH }] } });
  });

  it('renders portable credential-free pin labels and drops hostless file pins', async () => {
    const credentialed = 'https://user:secret@source.test/private/repo.git';
    const remotePlan = plan({ contracts: [{ ...plan().contracts[0], repoPathOrUrl: credentialed, pin: { url: credentialed, commit: 'c'.repeat(40), ref: 'main', refKind: 'branch' } }] });
    const remote = await validatePlan(remotePlan, { '1': 'rpc-1' }, deps());
    expect(remote.report.chains['1'].inputs.details).toEqual({ pinned: [{ sourceId: 'token', pin: 'source.test/private/repo.git@main', commit: 'cccccccccccc' }] });
    expect(JSON.stringify(remote.report)).not.toContain('user:secret');

    const fileUrl = 'file:///Volumes/private/repo';
    const filePlan = plan({ contracts: [{ ...plan().contracts[0], repoPathOrUrl: fileUrl, pin: { url: fileUrl, commit: 'd'.repeat(40) } }] });
    const file = await validatePlan(filePlan, { '1': 'rpc-1' }, deps());
    expect(file.report.chains['1'].inputs.details).toBeUndefined();
    expect(JSON.stringify(file.report)).not.toContain('Volumes');
  });

  it('honors only a fresh artifact-drift acknowledgement and re-blocks either stale side', async () => {
    const expected = 'a'.repeat(64);
    const pinned = plan({ contracts: [{ ...plan().contracts[0], repoPathOrUrl: 'https://source.test/repo.git', pin: { url: 'https://source.test/repo.git', commit: 'c'.repeat(40) } }] });
    const document = {
      schemaVersion: 1, sources: [{ id: 'token', repo: { url: 'https://source.test/repo.git', commit: 'c'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/Token.sol', contractName: 'Token', artifactPath: 'out/Token.json', artifactHash: expected }],
      steps: [{ id: 'deploy-token', kind: 'deploy', contractId: 'token' }], requiredPlugins: [], outputs: { hooks: [] },
    };
    const validate = (acknowledgeArtifactDrift: Record<string, { expected: string; actual: string }>) => validatePlan(pinned, { '1': 'rpc-1' }, deps({
      workflow: { document, binding: { repoPathOrUrl: '/workflow', name: 'release', docHash: 'e'.repeat(64), hooks: [], acknowledgeArtifactDrift } },
    }));
    await expect(validate({ token: { expected, actual: HASH } })).resolves.toMatchObject({ report: { chains: { '1': { inputs: { ok: true } } } } });
    for (const ack of [
      { token: { expected: 'f'.repeat(64), actual: HASH } },
      { token: { expected, actual: 'f'.repeat(64) } },
    ]) {
      const result = await validate(ack);
      expect(result.report.chains['1'].inputs).toMatchObject({ ok: false, blocking: true, code: 'WORKFLOW_ARTIFACT_DRIFT' });
    }
  });
});
