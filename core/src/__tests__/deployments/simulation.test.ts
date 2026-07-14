import { describe, expect, it, vi } from 'vitest';
import type { DeploymentPlan, FrozenInputs, Hex } from '@ignite/api';
import { simulateChain } from '../../deployments/simulation.js';
import type { ChainPredictions } from '../../deployments/schedule.js';

const A = '0x0000000000000000000000000000000000000001' as Hex;
const B = '0x0000000000000000000000000000000000000002' as Hex;
const plan = (steps: DeploymentPlan['steps']): DeploymentPlan => ({
  schemaVersion: 1,
  chains: [1],
  contracts: [
    {
      id: 'c',
      repoPathOrUrl: 'repo',
      frameworkId: 'f',
      artifactPath: 'a',
      contractName: 'C',
      sourcePath: 'C.sol',
    },
  ],
  signers: { global: { pluginId: 'key', accountId: 'a', address: A } },
  steps,
});
const frozen: FrozenInputs = {
  c: {
    abi: [{ type: 'constructor', inputs: [{ name: 'peer', type: 'address' }] }],
    creationBytecode: '0x6000',
    compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) },
    artifactHash: 'a'.repeat(64),
    repoDirty: false,
  },
};

describe('simulateChain', () => {
  it('uses eth_simulateV1 with nonce bookkeeping across interleaved signers', async () => {
    const simulated = vi.fn(async (_args: unknown) => ({
      blocks: [
        {
          calls: [
            { status: 'success', gasUsed: '10' },
            { status: 'success', gasUsed: '11' },
            { status: 'success', gasUsed: '12' },
          ],
        },
      ],
    }));
    const outcome = await simulateChain({
      chainId: 1,
      plan: plan([
        { id: 'one', kind: 'deploy', contractId: 'c', args: { peer: A } },
        { id: 'two', kind: 'call', target: { kind: 'address', address: B } },
        { id: 'three', kind: 'deploy', contractId: 'c', args: { peer: A } },
      ]),
      frozen,
      signers: new Map([
        ['one', A],
        ['two', B],
        ['three', A],
      ]),
      client: {
        simulateBlocks: simulated,
        estimateGas: vi.fn(),
        getTransactionCount: async ({ address }) => (address === A ? 5 : 9),
        getBlockNumber: async () => 99,
      getCode: async () => undefined,
      },
      getFork: async () => undefined,
    });
    expect(outcome).toMatchObject({
      tier: 'simulateV1',
      baseBlock: 99,
      perStep: {
        one: { gasUsed: '10' },
        two: { gasUsed: '11' },
        three: { gasUsed: '12' },
      },
    });
    expect(
      (
        simulated.mock.calls[0]![0] as unknown as {
          blocks: Array<{ calls: Array<{ nonce: bigint }> }>;
        }
      ).blocks[0].calls.map((call) => call.nonce)
    ).toEqual([5n, 9n, 6n]);
  });

  it('falls through unsupported simulateV1 to the fork runner', async () => {
    const fork = {
      run: vi.fn(async () => ({
        one: { status: 'ok' as const, gasUsed: '42' },
      })),
    };
    const outcome = await simulateChain({
      chainId: 1,
      plan: plan([
        { id: 'one', kind: 'deploy', contractId: 'c', args: { peer: A } },
      ]),
      frozen,
      signers: new Map([['one', A]]),
      client: {
        simulateBlocks: async () => {
          throw new Error('method not found');
        },
        estimateGas: vi.fn(),
        getTransactionCount: async () => 0,
        getBlockNumber: async () => 1,
      getCode: async () => undefined,
      },
      getFork: async () => fork,
    });
    expect(outcome).toMatchObject({
      tier: 'fork',
      perStep: { one: { status: 'ok', gasUsed: '42' } },
    });
    expect(outcome.fallthrough[0]).toContain(
      'SIMULATION_SIMULATEV1_UNAVAILABLE'
    );
  });

  it('labels a plain-create dependent entry unestimable in the estimate fallback', async () => {
    const outcome = await simulateChain({
      chainId: 1,
      plan: plan([
        { id: 'one', kind: 'deploy', contractId: 'c', args: { peer: A } },
        {
          id: 'two',
          kind: 'deploy',
          contractId: 'c',
          args: { peer: { $ref: { kind: 'step', stepId: 'one' } } },
        },
      ]),
      frozen,
      signers: new Map([
        ['one', A],
        ['two', A],
      ]),
      client: {
        estimateGas: async () => 7n,
        getTransactionCount: async () => 0,
        getBlockNumber: async () => 1,
      getCode: async () => undefined,
      },
      getFork: async () => undefined,
    });
    expect(outcome).toMatchObject({
      tier: 'estimate',
      perStep: {
        one: { status: 'ok', gasUsed: '7' },
        two: {
          status: 'unestimable',
          reason: 'SIMULATION_UNAVAILABLE_DEPENDENT',
        },
      },
    });
  });

  it('fails loudly when a fork observes a different created address', async () => {
    await expect(
      simulateChain({
        chainId: 1,
        plan: plan([
          { id: 'one', kind: 'deploy', contractId: 'c', args: { peer: A } },
        ]),
        frozen,
        signers: new Map([['one', A]]),
        client: {
          estimateGas: vi.fn(),
          getTransactionCount: async () => 0,
          getBlockNumber: async () => 1,
      getCode: async () => undefined,
        },
        getFork: async () => ({
          run: async () => ({
            one: { status: 'ok', gasUsed: '1', createdAddress: B },
          }),
        }),
      })
    ).rejects.toMatchObject({ code: 'SIMULATION_ADDRESS_DIVERGENCE' });
  });

  it('consumes a supplied snapshot without recomputing predictions or nonces', async () => {
    const salt = `0x${'88'.repeat(32)}` as Hex;
    const candidate = plan([{ id: 'one', kind: 'deploy', contractId: 'c', args: { peer: A }, strategy: { kind: 'plugin', pluginId: 'hook' } }]);
    const snapshot: ChainPredictions = {
      predictions: { one: { salt, initcodeHash: `0x${'99'.repeat(32)}`, predictedAddress: B } },
      entries: { one: { salt, initcodeHash: `0x${'99'.repeat(32)}`, predictedAddress: B } },
      createAddresses: new Map(), baseNonces: new Map([[A, 4]]), confirmedExisting: new Set(), dynamic: new Set(),
    };
    const nonce = vi.fn(async () => { throw new Error('must not refetch'); });
    const simulated = vi.fn(async () => ({ blocks: [{ calls: [{ status: 'success', gasUsed: '5' }] }] }));
    const outcome = await simulateChain({
      chainId: 1, plan: candidate, frozen, signers: new Map([['one', A]]), predictions: snapshot,
      client: { simulateBlocks: simulated, estimateGas: vi.fn(), getTransactionCount: nonce, getBlockNumber: async () => 1, getCode: async () => undefined },
      getFork: async () => undefined,
    });
    expect(outcome).toMatchObject({ tier: 'simulateV1', perStep: { one: { status: 'ok', gasUsed: '5' } } });
    expect(nonce).not.toHaveBeenCalled();
  });
});
