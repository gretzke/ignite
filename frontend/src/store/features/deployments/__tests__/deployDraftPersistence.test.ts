// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ContractSource } from '@ignite/api';
import {
  deployDraftReducer,
  addContracts,
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
