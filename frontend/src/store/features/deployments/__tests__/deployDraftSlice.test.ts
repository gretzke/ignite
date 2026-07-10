// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ContractSource } from '@ignite/api';
import {
  deployDraftReducer,
  seedDraft,
  setChainArgOverride,
  reorderSteps,
} from '../deployDraftSlice';

function contract(id: string, contractName: string): ContractSource {
  return {
    id,
    repoPathOrUrl: '/repo',
    frameworkId: 'foundry',
    artifactPath: `out/${contractName}.sol/${contractName}.json`,
    contractName,
    sourcePath: `src/${contractName}.sol`,
  };
}

describe('deployDraftSlice', () => {
  it('seeds two contracts and their deployment steps in source order', () => {
    const contracts = [contract('token', 'Token'), contract('vault', 'Vault')];

    const state = deployDraftReducer(undefined, seedDraft(contracts));

    expect(state.contracts).toEqual(contracts);
    expect(state.steps).toEqual([
      { id: 'deploy-token', kind: 'deploy', contractId: 'token' },
      { id: 'deploy-vault', kind: 'deploy', contractId: 'vault' },
    ]);
  });

  it('sets and clears sparse per-chain argument overrides', () => {
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      setChainArgOverride({
        stepId: 'deploy-token',
        chainId: 11155111,
        key: 'owner',
        value: '0x1111111111111111111111111111111111111111',
      })
    );
    expect(state.steps[0].argsPerChain).toEqual({
      '11155111': {
        owner: '0x1111111111111111111111111111111111111111',
      },
    });

    state = deployDraftReducer(
      state,
      setChainArgOverride({
        stepId: 'deploy-token',
        chainId: 11155111,
        key: 'owner',
        value: undefined,
      })
    );
    expect(state.steps[0].argsPerChain).toBeUndefined();
  });

  it('keeps the visible contract order aligned with execution steps', () => {
    const contracts = [contract('token', 'Token'), contract('vault', 'Vault')];
    const state = deployDraftReducer(
      deployDraftReducer(undefined, seedDraft(contracts)),
      reorderSteps({ fromIndex: 1, toIndex: 0 })
    );

    expect(state.steps.map((step) => step.contractId)).toEqual([
      'vault',
      'token',
    ]);
    expect(state.contracts.map((contract) => contract.id)).toEqual([
      'vault',
      'token',
    ]);
  });
});
