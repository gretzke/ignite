// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ContractSource } from '@ignite/api';
import {
  deployDraftReducer,
  seedDraft,
  setChainArgOverride,
  reorderSteps,
  addContracts,
  removeContract,
  markDraftSeen,
  draftLaunched,
  mintIdempotencyKey,
  toggleChain,
  setName,
  deployDraftInitialState,
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

  it('addContracts appends and dedupes by id', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      addContracts([contract('token', 'Token'), contract('vault', 'Vault')])
    );

    expect(state.contracts.map((c) => c.id)).toEqual(['token', 'vault']);
    expect(state.steps.map((s) => s.id)).toEqual([
      'deploy-token',
      'deploy-vault',
    ]);
  });

  it('first add into an empty draft records no unseen ids; later adds do', () => {
    // The first add navigates the user into the wizard, so those contracts
    // are seen by definition; only additions to an already-active draft
    // surface via the badge.
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    expect(state.unseenIds).toEqual([]);

    state = deployDraftReducer(
      state,
      addContracts([contract('token', 'Token'), contract('vault', 'Vault')])
    );
    expect(state.unseenIds).toEqual(['vault']);
  });

  it('addContracts preserves existing configuration', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, toggleChain(1));
    state = deployDraftReducer(state, addContracts([contract('vault', 'Vault')]));

    expect(state.chains).toEqual([1]);
    expect(state.contracts).toHaveLength(2);
  });

  it('markDraftSeen clears unseen ids without touching contracts', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, addContracts([contract('vault', 'Vault')]));
    expect(state.unseenIds).toEqual(['vault']);

    state = deployDraftReducer(state, markDraftSeen());

    expect(state.unseenIds).toEqual([]);
    expect(state.contracts).toHaveLength(2);
  });

  it('removeContract drops the contract, its step, and its unseen entry', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, addContracts([contract('vault', 'Vault')]));
    state = deployDraftReducer(state, removeContract('vault'));

    expect(state.contracts.map((c) => c.id)).toEqual(['token']);
    expect(state.steps.map((s) => s.contractId)).toEqual(['token']);
    expect(state.unseenIds).toEqual([]);
  });

  it('removing the last contract resets the entire draft', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, toggleChain(1));
    state = deployDraftReducer(state, setName('leftovers'));
    state = deployDraftReducer(state, removeContract('token'));

    expect(state).toEqual(deployDraftInitialState);
  });

  it('removeContract ignores unknown ids', () => {
    const seeded = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    const state = deployDraftReducer(seeded, removeContract('ghost'));

    expect(state).toEqual(seeded);
  });

  it('draftLaunched clears only the draft that was launched', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, mintIdempotencyKey());
    const launchedKey = state.idempotencyKey!;

    // A stale launch response (user discarded and started a new draft with a
    // different key) must not wipe the current draft.
    const untouched = deployDraftReducer(state, draftLaunched('other-key'));
    expect(untouched).toEqual(state);

    const cleared = deployDraftReducer(state, draftLaunched(launchedKey));
    expect(cleared).toEqual(deployDraftInitialState);
  });
});
