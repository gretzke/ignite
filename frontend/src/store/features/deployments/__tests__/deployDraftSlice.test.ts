// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ContractSource } from '@ignite/api';
import {
  deployDraftReducer,
  seedDraft,
  setChainArgOverride,
  moveStep,
  addContracts,
  removeContract,
  markDraftSeen,
  draftLaunched,
  mintIdempotencyKey,
  toggleChain,
  setName,
  deployDraftInitialState,
  addCallStep,
  acknowledgeDeployed,
  ackStale,
  removeCallStep,
  setArg,
  setLibraries,
  setPluginParams,
  setStrategy,
  setStepSigner,
  storePrepared,
} from '../deployDraftSlice';
import { contractSourceId } from '../../../../utils/contractSourceId';

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
  const hex = (character: string) =>
    `0x${character.repeat(64)}` as `0x${string}`;
  function preparedState() {
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token'), contract('vault', 'Vault')])
    );
    state = deployDraftReducer(
      state,
      setStrategy({
        stepId: 'deploy-token',
        strategy: { kind: 'plugin', pluginId: 'deterministic' },
      })
    );
    state = deployDraftReducer(
      state,
      setLibraries({
        stepId: 'deploy-vault',
        libraries: { token: { kind: 'step', stepId: 'deploy-token' } },
      })
    );
    state = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-token',
        chains: {
          '1': {
            salt: hex('1'),
            predictedAddress: '0x1111111111111111111111111111111111111111',
            initcodeHash: hex('2'),
            notes: [],
          },
        },
      })
    );
    state = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-vault',
        chains: {
          '1': {
            salt: hex('3'),
            predictedAddress: '0x2222222222222222222222222222222222222222',
            initcodeHash: hex('4'),
            notes: [],
          },
        },
      })
    );
    state = deployDraftReducer(
      state,
      acknowledgeDeployed({
        stepId: 'deploy-token',
        chainId: 1,
        predictedAddress: '0x1111111111111111111111111111111111111111',
        initcodeHash: hex('2'),
      })
    );
    state = deployDraftReducer(
      state,
      acknowledgeDeployed({
        stepId: 'deploy-vault',
        chainId: 1,
        predictedAddress: '0x2222222222222222222222222222222222222222',
        initcodeHash: hex('4'),
      })
    );
    return state;
  }

  it('invalidates transitive prepared predictions and prunes acknowledgements', () => {
    const state = deployDraftReducer(
      preparedState(),
      setArg({
        stepId: 'deploy-token',
        key: 'owner',
        value: '0x1111111111111111111111111111111111111111',
      })
    );
    expect(state.deployExtras['deploy-token']).toMatchObject({
      needsPrepare: true,
    });
    expect(state.deployExtras['deploy-token'].prepared).toBeUndefined();
    expect(state.deployExtras['vault']).toBeUndefined();
    expect(state.deployExtras['deploy-vault'].prepared).toBeUndefined();
    expect(state.deployExtras['deploy-vault'].acknowledged).toBeUndefined();
  });

  it('invalidates strategy, salt, library, and plugin parameter edits', () => {
    for (const action of [
      setStrategy({ stepId: 'deploy-token', strategy: { kind: 'create2' } }),
      setLibraries({
        stepId: 'deploy-token',
        libraries: {
          x: {
            kind: 'address',
            address: '0x1111111111111111111111111111111111111111',
          },
        },
      }),
      setPluginParams({ stepId: 'deploy-token', params: { network: 'test' } }),
    ]) {
      const state = deployDraftReducer(preparedState(), action);
      expect(state.deployExtras['deploy-token'].prepared).toBeUndefined();
      expect(state.deployExtras['deploy-token'].acknowledged).toBeUndefined();
    }
  });

  it('removing a referenced call nulls dangling refs and invalidates dependents', () => {
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, addCallStep(0));
    const call = state.steps[1];
    state = deployDraftReducer(
      state,
      setArg({
        stepId: 'deploy-token',
        key: 'recipient',
        value: { $ref: { kind: 'step', stepId: call.id } },
      })
    );
    state = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-token',
        chains: {
          '1': {
            salt: hex('1'),
            predictedAddress: '0x1111111111111111111111111111111111111111',
            initcodeHash: hex('2'),
            notes: [],
          },
        },
      })
    );
    state = deployDraftReducer(state, removeCallStep(call.id));
    expect(state.steps[0].args?.recipient).toBeUndefined();
    expect(state.deployExtras['deploy-token']?.prepared).toBeUndefined();
  });

  it('reports acknowledgement staleness from the current prepared commitment', () => {
    const state = preparedState();
    expect(ackStale(state, 'deploy-token', 1)).toBe(false);
    const changed = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-token',
        chains: {
          '1': {
            salt: hex('1'),
            predictedAddress: '0x3333333333333333333333333333333333333333',
            initcodeHash: hex('2'),
            notes: [],
          },
        },
      })
    );
    expect(ackStale(changed, 'deploy-token', 1)).toBe(true);
  });
  it('seeds two contracts and their deployment steps in source order', () => {
    const contracts = [contract('token', 'Token'), contract('vault', 'Vault')];

    const state = deployDraftReducer(undefined, seedDraft(contracts));

    expect(state.contracts).toEqual(contracts);
    expect(state.steps).toEqual([
      { id: 'deploy-token', kind: 'deploy', contractId: 'token' },
      { id: 'deploy-vault', kind: 'deploy', contractId: 'vault' },
    ]);
  });

  it('keeps two pinned versions of the same contract as separate draft rows', () => {
    const pinned = (commit: string): ContractSource => {
      const source = {
        repoPathOrUrl: 'https://example.test/contracts.git',
        frameworkId: 'foundry',
        artifactPath: 'out/Token.sol/Token.json',
        contractName: 'Token',
        sourcePath: 'src/Token.sol',
        pin: { url: 'https://example.test/contracts.git', commit },
      };
      return { id: contractSourceId(source), ...source };
    };
    const first = pinned('a'.repeat(40));
    const second = pinned('b'.repeat(40));

    let state = deployDraftReducer(undefined, addContracts([first]));
    state = deployDraftReducer(state, addContracts([second]));

    expect(state.contracts).toEqual([first, second]);
    expect(state.contracts.map((contract) => contract.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(state.steps.map((step) => step.contractId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('retains a pinned source when adding it to a deployment draft', () => {
    const source = {
      repoPathOrUrl: 'https://example.test/contracts.git', frameworkId: 'foundry',
      artifactPath: 'out/Token.sol/Token.json', contractName: 'Token', sourcePath: 'src/Token.sol',
      pin: { url: 'https://example.test/contracts.git', commit: 'c'.repeat(40), ref: 'v1.2.3' },
    };
    const contract = { id: contractSourceId(source), ...source };
    const state = deployDraftReducer(undefined, addContracts([contract]));
    expect(state.contracts[0]).toMatchObject({ id: contract.id, pin: source.pin });
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

  it('stores a step signer cascade with per-chain entries', () => {
    const signer = {
      pluginId: 'wallet',
      accountId: 'main',
      address: '0x1111111111111111111111111111111111111111',
    } as const;
    const cascade = { perChain: { '1': signer, '10': signer } };
    const state = deployDraftReducer(
      deployDraftReducer(undefined, seedDraft([contract('token', 'Token')])),
      setStepSigner({ stepId: 'deploy-token', cascade })
    );

    expect(state.steps[0].signerOverride).toEqual(cascade);
  });

  it('removing a chain prunes step signer overrides for that chain', () => {
    const signer = {
      pluginId: 'wallet',
      accountId: 'main',
      address: '0x1111111111111111111111111111111111111111',
    } as const;
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, addCallStep(0));
    state = deployDraftReducer(state, toggleChain(1));
    state = deployDraftReducer(state, toggleChain(10));
    state = deployDraftReducer(
      state,
      setStepSigner({
        stepId: 'deploy-token',
        cascade: { perChain: { '1': signer } },
      })
    );
    state = deployDraftReducer(
      state,
      setStepSigner({
        stepId: state.steps[1].id,
        cascade: { global: signer, perChain: { '1': signer, '10': signer } },
      })
    );

    state = deployDraftReducer(state, toggleChain(1));

    expect(state.steps[0].signerOverride).toBeUndefined();
    expect(state.steps[1].signerOverride).toEqual({
      global: signer,
      perChain: { '10': signer },
    });
  });

  it('moves execution steps without changing the contract inventory', () => {
    const contracts = [contract('token', 'Token'), contract('vault', 'Vault')];
    const state = deployDraftReducer(
      deployDraftReducer(undefined, seedDraft(contracts)),
      moveStep({ fromIndex: 1, toIndex: 0 })
    );

    expect(state.steps.map((step) => step.contractId)).toEqual([
      'vault',
      'token',
    ]);
    expect(state.contracts.map((contract) => contract.id)).toEqual([
      'token',
      'vault',
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
    state = deployDraftReducer(
      state,
      addContracts([contract('vault', 'Vault')])
    );

    expect(state.chains).toEqual([1]);
    expect(state.contracts).toHaveLength(2);
  });

  it('markDraftSeen clears unseen ids without touching contracts', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      addContracts([contract('vault', 'Vault')])
    );
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
    state = deployDraftReducer(
      state,
      addContracts([contract('vault', 'Vault')])
    );
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
