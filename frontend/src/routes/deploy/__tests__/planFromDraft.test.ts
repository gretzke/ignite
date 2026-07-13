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
          explorerSelection: {},
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
      deployExtras: {},
      unseenIds: [],
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
          explorerSelection: {},
      signers: {},
      steps: [],
      deployExtras: {},
      unseenIds: [],
    };
    expect(() => planFromDraft(draft, [])).toThrow(
      'Missing currency metadata for chain 999'
    );
  });

  it('assembles strategies, acknowledgements, libraries, and call fields without losing plan data', () => {
    const hex = (digit: string, size = 40) => `0x${digit.repeat(size)}` as `0x${string}`;
    const draft: DeployDraftState = {
      contracts: [
        { id: 'token', repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: 'Token.json', contractName: 'Token', sourcePath: 'Token.sol' },
        { id: 'vault', repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: 'Vault.json', contractName: 'Vault', sourcePath: 'Vault.sol' },
      ],
      chains: [1], rpcSelection: {}, explorerSelection: {}, signers: { global: { pluginId: 'wallet', accountId: 'main', address: hex('a') } }, unseenIds: [],
      steps: [
        { id: 'deploy-token', kind: 'deploy', contractId: 'token', args: { owner: hex('b') }, value: '1', valuePerChain: { '1': '2' }, gasOverrides: { gasLimit: '500000' }, gasOverridesPerChain: { '1': { maxFeePerGas: '2' } }, signerOverride: { global: { pluginId: 'wallet', accountId: 'alt', address: hex('c') } } },
        { id: 'call-vault', kind: 'call', target: { kind: 'step', stepId: 'deploy-token' }, targetPerChain: { '1': { kind: 'address', address: hex('d') } }, signature: 'setOwner(address)', payable: true, args: { owner: { $ref: { kind: 'step', stepId: 'deploy-token' } } }, argsPerChain: { '1': { owner: hex('e') } }, value: '0.5', valuePerChain: { '1': '0.25' }, gasOverrides: { maxPriorityFeePerGas: '1.5' }, gasOverridesPerChain: { '1': { gasLimit: '123' } }, signerOverride: { perChain: { '1': { pluginId: 'wallet', accountId: 'alt', address: hex('c') } } } },
        { id: 'deploy-vault', kind: 'deploy', contractId: 'vault' },
      ],
      deployExtras: {
        'deploy-token': { strategy: { kind: 'create2', salt: hex('1', 64), saltPerChain: { '1': hex('2', 64) }, }, libraries: { MathLib: { kind: 'address', address: hex('f') } }, librariesPerChain: { '1': { OtherLib: { kind: 'step', stepId: 'deploy-vault' } } }, acknowledged: { '1': { predictedAddress: hex('3'), initcodeHash: hex('4', 64) } } },
        'deploy-vault': { strategy: { kind: 'plugin', pluginId: 'hook', params: { rounds: 7 } }, prepared: { '1': { salt: hex('5', 64), predictedAddress: hex('6'), initcodeHash: hex('7', 64), notes: [] } }, acknowledged: { '1': { predictedAddress: hex('6'), initcodeHash: hex('7', 64) } } },
      },
    };

    expect(planFromDraft(draft, chains)).toEqual({
      schemaVersion: 1, contracts: draft.contracts, chains: [1], signers: draft.signers,
      steps: [
        { id: 'deploy-token', kind: 'deploy', contractId: 'token', args: { owner: hex('b') }, value: '1000000000000000000', valuePerChain: { '1': '2000000000000000000' }, gasOverrides: { gasLimit: '500000' }, gasOverridesPerChain: { '1': { maxFeePerGas: '2000000000' } }, signerOverride: draft.steps[0].signerOverride, strategy: { kind: 'create2', salt: hex('1', 64), saltPerChain: { '1': hex('2', 64) }, acknowledgeDeployed: draft.deployExtras['deploy-token'].acknowledged }, libraries: draft.deployExtras['deploy-token'].libraries, librariesPerChain: draft.deployExtras['deploy-token'].librariesPerChain },
        { id: 'call-vault', kind: 'call', target: { kind: 'step', stepId: 'deploy-token' }, targetPerChain: { '1': { kind: 'address', address: hex('d') } }, signature: 'setOwner(address)', payable: true, args: { owner: { $ref: { kind: 'step', stepId: 'deploy-token' } } }, argsPerChain: { '1': { owner: hex('e') } }, value: '500000000000000000', valuePerChain: { '1': '250000000000000000' }, gasOverrides: { maxPriorityFeePerGas: '1500000000' }, gasOverridesPerChain: { '1': { gasLimit: '123' } }, signerOverride: draft.steps[1].signerOverride },
        { id: 'deploy-vault', kind: 'deploy', contractId: 'vault', strategy: { kind: 'plugin', pluginId: 'hook', params: { rounds: 7 }, salt: hex('5', 64), saltPerChain: { '1': hex('5', 64) }, prepared: { '1': { predictedAddress: hex('6'), initcodeHash: hex('7', 64) } }, acknowledgeDeployed: draft.deployExtras['deploy-vault'].acknowledged } },
      ],
    });
  });
});
