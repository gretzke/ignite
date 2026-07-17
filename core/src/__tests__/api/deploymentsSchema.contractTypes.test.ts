import { describe, expect, it } from 'vitest';
import { ContractSourceSchema, DeploymentPlanSchema, EncodedCallValueSchema } from '@ignite/api';

const repoContract = {
  id: 'implementation', repoPathOrUrl: '/repo', frameworkId: 'foundry',
  artifactPath: 'out/Implementation.json', contractName: 'Implementation', sourcePath: 'src/Implementation.sol',
};
const contractType = {
  id: 'proxy', origin: 'contract-type' as const, contractName: 'ERC1967Proxy',
  pluginId: 'oz-uups', artifactKey: 'proxy', versionLabel: '5.4.0', contentHash: 'a'.repeat(64),
};

function plan(steps: unknown[]) {
  return { schemaVersion: 1 as const, contracts: [repoContract, contractType], steps, chains: [1], signers: {} };
}

describe('contract-type deployment wire schema', () => {
  it('accepts and rejects encoded call values at the wire boundary', () => {
    expect(EncodedCallValueSchema.parse({ $encode: { contractId: 'implementation', fn: 'initialize(address,uint256)', args: { owner: '0x0000000000000000000000000000000000000001' } } })).toMatchObject({ $encode: { contractId: 'implementation' } });
    expect(EncodedCallValueSchema.safeParse({ $encode: { contractId: 'implementation' } }).success).toBe(false);
    expect(EncodedCallValueSchema.safeParse({ $encode: { contractId: '', fn: 'initialize()' } }).success).toBe(false);
    expect(EncodedCallValueSchema.safeParse({ $encode: { contractId: 'implementation', fn: 'x'.repeat(513) } }).success).toBe(false);
  });

  it('validates encoded contract references, wrapper links, and nested refs', () => {
    expect(DeploymentPlanSchema.safeParse(plan([{ id: 'wrapper', kind: 'deploy', contractId: 'proxy', args: { _data: { $encode: { contractId: 'missing', fn: 'initialize()' } } } }])).success).toBe(false);
    expect(DeploymentPlanSchema.safeParse(plan([
      { id: 'not-deploy', kind: 'call', target: { kind: 'address', address: '0x0000000000000000000000000000000000000001' } },
      { id: 'wrapper', kind: 'deploy', contractId: 'proxy', wraps: { stepId: 'not-deploy', contractTypePluginId: 'oz-uups' } },
    ])).success).toBe(false);
    expect(DeploymentPlanSchema.safeParse(plan([{
      id: 'wrapper', kind: 'deploy', contractId: 'proxy', args: {
        _data: { $encode: { contractId: 'implementation', fn: 'initialize(address)', args: { owner: { $ref: { kind: 'step', stepId: 'missing' } } } } },
      },
    }])).success).toBe(false);
  });

  it('accepts linked implementation and wrapper steps and round-trips acknowledgement', () => {
    const value = plan([
      { id: 'implementation-step', kind: 'deploy', contractId: 'implementation' },
      {
        id: 'wrapper-step', kind: 'deploy', contractId: 'proxy',
        wraps: { stepId: 'implementation-step', contractTypePluginId: 'oz-uups' },
        acknowledgeUninitialized: true,
        args: { implementation: { $ref: { kind: 'step', stepId: 'implementation-step' } }, _data: { $encode: { contractId: 'implementation', fn: 'initialize(address)' } } },
      },
    ]);
    expect(DeploymentPlanSchema.parse(value)).toEqual(value);
  });

  it('rejects nonzero wrapper value without a global encoded initializer', () => {
    expect(DeploymentPlanSchema.safeParse(plan([{
      id: 'wrapper', kind: 'deploy', contractId: 'proxy', wraps: { stepId: 'wrapper', contractTypePluginId: 'oz-uups' }, value: '1', args: { _data: '0x' },
    }])).success).toBe(false);
    expect(DeploymentPlanSchema.safeParse(plan([{
      id: 'wrapper', kind: 'deploy', contractId: 'proxy', wraps: { stepId: 'wrapper', contractTypePluginId: 'oz-uups' }, valuePerChain: { '1': '1' }, args: { _data: { $encode: { contractId: 'implementation', fn: 'initialize()' } } },
    }])).success).toBe(true);
  });

  it('keeps repo sources compatible and accepts contract-type sources', () => {
    const pin = { url: 'https://example.test/repo.git', commit: 'b'.repeat(40), ref: 'v1', refKind: 'tag' as const };
    expect(ContractSourceSchema.parse({ ...repoContract, repoPathOrUrl: pin.url, pin })).toMatchObject({ repoPathOrUrl: pin.url, pin });
    expect(ContractSourceSchema.safeParse({ ...repoContract, repoPathOrUrl: '/other', pin }).success).toBe(false);
    expect(ContractSourceSchema.parse(contractType)).toEqual(contractType);
    for (const key of ['pluginId', 'artifactKey', 'versionLabel', 'contentHash'] as const) {
      const { [key]: _missing, ...invalid } = contractType;
      expect(ContractSourceSchema.safeParse(invalid).success).toBe(false);
    }
    expect(ContractSourceSchema.parse({ ...repoContract, origin: 'repo' })).toMatchObject({ origin: 'repo' });
  });
});
