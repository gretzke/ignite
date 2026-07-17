// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ContractSource } from '@ignite/api';
import {
  deployDraftReducer,
  addContracts,
  seedDraft,
  selectContractType,
  toggleChain,
} from '../deployDraftSlice';
import {
  DEPLOY_DRAFT_STORAGE_KEY,
  loadDraft,
  saveDraft,
} from '../deployDraftPersistence';

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

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => map.delete(key),
  };
}

function draftWithContracts() {
  let state = deployDraftReducer(
    undefined,
    addContracts([contract('token', 'Token'), contract('vault', 'Vault')])
  );
  state = deployDraftReducer(state, toggleChain(1));
  return state;
}

describe('deployDraftPersistence', () => {
  it('round-trips a draft through storage', () => {
    const storage = fakeStorage();
    const draft = draftWithContracts();

    saveDraft(draft, storage);

    expect(loadDraft(storage)).toEqual(draft);
  });

  it('round-trips synthesized wrapper state, including the explicit empty initializer choice', () => {
    const storage = fakeStorage();
    let draft = deployDraftReducer(undefined, seedDraft([contract('token', 'Token')]));
    draft = deployDraftReducer(draft, selectContractType({
      implementationStepId: 'deploy-token',
      contractType: {
        pluginId: 'transparent', label: 'Transparent proxy', description: 'test', versionLabel: 'OZ 5.3.0', contentHash: 'a'.repeat(64), params: [], artifacts: ['proxy'],
        synthesis: { artifact: 'proxy', constructorArgs: [{ name: '_logic', from: 'implementation' }, { name: '_data', from: 'initializer' }] }, validation: {}, capture: [],
      },
      artifact: { sourceIdentifier: 'Proxy.sol:TransparentUpgradeableProxy' },
    }));
    const wrapper = draft.steps.find((step) => step.kind === 'deploy' && step.wraps)!;
    draft = deployDraftReducer(draft, { type: 'deployDraft/setWrapperInitializer', payload: { stepId: wrapper.id, key: '_data', value: '0x', selection: '' } });
    saveDraft(draft, storage);
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('restores a pre-D6 v2 draft unchanged when additive workflow fields are absent', () => {
    const draft = draftWithContracts();
    const storage = fakeStorage({ [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(draft) });
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('returns undefined when nothing is stored', () => {
    expect(loadDraft(fakeStorage())).toBeUndefined();
  });

  it('returns undefined for corrupt JSON', () => {
    const storage = fakeStorage({ [DEPLOY_DRAFT_STORAGE_KEY]: '{not json' });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('discards the incompatible v1 session key', () => {
    const storage = fakeStorage({ 'ignite.deployDraft.v1': JSON.stringify(draftWithContracts()) });
    expect(loadDraft(storage)).toBeUndefined();
    expect(storage.getItem('ignite.deployDraft.v1')).toBeNull();
  });

  it('rejects parseable payloads with orphaned steps', () => {
    const draft = draftWithContracts();
    const broken = { ...draft, contracts: [draft.contracts[0]] };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(broken),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects unseen ids that reference no contract', () => {
    const draft = { ...draftWithContracts(), unseenIds: ['ghost'] };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(draft),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects configuration without contracts', () => {
    // Config-only drafts are not a session (spec edge case): they must not
    // be restored and inherited by the next deployment's first add.
    let empty = deployDraftReducer(undefined, { type: 'noop' });
    empty = deployDraftReducer(empty, toggleChain(1));
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(empty),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects duplicate step ids', () => {
    const draft = draftWithContracts();
    const broken = {
      ...draft,
      // Two distinct contracts whose steps share one id: unique-contractId
      // checks pass, but downstream step lookups and React keys would break.
      steps: draft.steps.map((step) => ({ ...step, id: 'deploy-token' })),
    };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(broken),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects duplicate contract ids', () => {
    const draft = draftWithContracts();
    const broken = {
      ...draft,
      contracts: [draft.contracts[0], draft.contracts[0]],
    };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(broken),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('swallows storage write failures', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => saveDraft(draftWithContracts(), storage)).not.toThrow();
  });
});
