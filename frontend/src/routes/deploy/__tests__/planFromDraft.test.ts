// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ChainInfo } from '@ignite/api';
import type { DeployDraftState } from '../../../store/features/deployments/types';
import { parseUnitsDecimal, planFromDraft } from '../planFromDraft';

const chains: ChainInfo[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [],
    source: 'chainlist',
  },
  {
    chainId: 999,
    name: 'Six Decimal Chain',
    nativeCurrency: { name: 'Coin', symbol: 'COIN', decimals: 6 },
    rpc: [],
    source: 'custom',
  },
];

describe('planFromDraft', () => {
  it('converts native values per chain, preserves sparse overrides, and drops empty maps', () => {
    const draft: DeployDraftState = {
      contracts: [
        {
          id: 'token',
          repoPathOrUrl: '/repo',
          frameworkId: 'foundry',
          artifactPath: 'out/Token.sol/Token.json',
          contractName: 'Token',
          sourcePath: 'src/Token.sol',
        },
      ],
      chains: [1, 999],
      rpcSelection: {
        '1': { endpointId: 'rpc-1', label: 'RPC 1' },
        '999': { endpointId: 'rpc-999', label: 'RPC 999' },
      },
      signers: {},
      steps: [
        {
          id: 'deploy-token',
          kind: 'deploy',
          contractId: 'token',
          args: { supply: '1000' },
          argsPerChain: { '999': { supply: '2000' } },
          value: '1.25',
          gasOverrides: { gasLimit: '500000', maxFeePerGas: '2.5' },
        },
      ],
    };

    const plan = planFromDraft(draft, chains);

    expect(plan.steps[0]).toMatchObject({
      args: { supply: '1000' },
      argsPerChain: { '999': { supply: '2000' } },
      valuePerChain: {
        '1': '1250000000000000000',
        '999': '1250000',
      },
      gasOverrides: {
        gasLimit: '500000',
        maxFeePerGas: '2500000000',
      },
    });
    expect(plan.steps[0]).not.toHaveProperty('value');
    expect(plan.steps[0]).not.toHaveProperty('gasOverridesPerChain');
  });

  it('never rounds decimal units', () => {
    expect(parseUnitsDecimal('0.000001', 6)).toBe('1');
    expect(() => parseUnitsDecimal('0.0000001', 6)).toThrow();
  });

  it('refuses to guess native currency decimals', () => {
    const draft: DeployDraftState = {
      contracts: [],
      chains: [999],
      rpcSelection: {},
      signers: {},
      steps: [],
    };
    expect(() => planFromDraft(draft, [])).toThrow(
      'Missing currency metadata for chain 999'
    );
  });
});
