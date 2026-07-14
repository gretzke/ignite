// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { WorkflowDocument } from '@ignite/api';
import {
  confirmExternalResolution,
  deployDraftReducer,
  hydrateWorkflowDraft,
  toggleWorkflowStep,
  setStepSigner,
  setArg,
  acceptWorkflowPinUpdate,
} from '../deployDraftSlice';
import { workflowDocumentFromDraft, workflowDraftIsDirty } from '../workflowDraft';

const document: WorkflowDocument = {
  schemaVersion: 1,
  description: 'A release',
  sources: [{ id: 'token', repo: { url: 'https://example.com/token.git', commit: '1'.repeat(40), ref: 'v1.0.0', refKind: 'tag' }, frameworkId: 'foundry', sourcePath: 'src/Token.sol', contractName: 'Token', artifactPath: 'out/Token.sol/Token.json', artifactHash: 'a'.repeat(64) }],
  steps: [
    { id: 'deploy-a', kind: 'deploy', contractId: 'token', strategy: { kind: 'create2', salt: `0x${'0'.repeat(64)}`, acknowledgeDeployed: { '1': { predictedAddress: '0x1111111111111111111111111111111111111111', initcodeHash: `0x${'2'.repeat(64)}` } } } },
    { id: 'deploy-b', kind: 'deploy', contractId: 'token' },
    { id: 'call-a', kind: 'call', target: { kind: 'step', stepId: 'deploy-a' } },
  ],
  defaultChains: [1, 10],
  requiredPlugins: [{ id: 'foundry', version: '1' }],
  outputs: { hooks: ['chronicles-logger'] },
};

describe('workflow deploy drafts', () => {
  it('hydrates pins, multiple deploy steps per source, strategies, outputs, and step-keyed inclusion', () => {
    const state = deployDraftReducer(undefined, hydrateWorkflowDraft({ repoPathOrUrl: '/workspace', name: 'release', docHash: 'b'.repeat(64), document }));
    expect(state.contracts[0]).toMatchObject({ id: 'token', repoPathOrUrl: 'https://example.com/token.git', pin: document.sources[0].repo });
    expect(state.steps.map((step) => step.id)).toEqual(['deploy-a', 'deploy-b', 'call-a']);
    expect(state.deployExtras['deploy-a'].strategy.kind).toBe('create2');
    expect(state.workflowRef).toMatchObject({ repoPathOrUrl: '/workspace', name: 'release', baseDocHash: 'b'.repeat(64) });
    expect(state.workflowIncludedStepIds).toEqual({ 'deploy-a': true, 'deploy-b': true, 'call-a': true });
    expect(state.chains).toEqual([1, 10]);
    expect(state.workflowOutputs).toEqual({ hooks: ['chronicles-logger'] });
  });

  it('toggles inclusion by step id and records a confirmed external resolution', () => {
    let state = deployDraftReducer(undefined, hydrateWorkflowDraft({ repoPathOrUrl: '/workspace', name: 'release', docHash: 'b'.repeat(64), document }));
    state = deployDraftReducer(state, toggleWorkflowStep('deploy-a'));
    state = deployDraftReducer(state, confirmExternalResolution({ stepId: 'call-a', path: '/target', chainId: 1, address: '0x3333333333333333333333333333333333333333', source: 'manual' }));
    expect(state.workflowIncludedStepIds?.['deploy-a']).toBe(false);
    expect(state.externalResolutions).toEqual([{ stepId: 'call-a', path: '/target', chainId: 1, address: '0x3333333333333333333333333333333333333333', source: 'manual' }]);
  });

  it('serializes a signer-free workflow document and detects drift', () => {
    let state = deployDraftReducer(undefined, hydrateWorkflowDraft({ repoPathOrUrl: '/workspace', name: 'release', docHash: 'b'.repeat(64), document }));
    expect(workflowDraftIsDirty(state)).toBe(false);
    state = deployDraftReducer(state, setStepSigner({ stepId: 'deploy-a', cascade: { global: { pluginId: 'wallet', accountId: 'one', address: '0x4444444444444444444444444444444444444444' } } }));
    state = deployDraftReducer(state, setArg({ stepId: 'deploy-b', key: 'owner', value: '0x5555555555555555555555555555555555555555' }));
    const serialized = workflowDocumentFromDraft(state);
    expect(serialized.steps[0]).not.toHaveProperty('signerOverride');
    expect(serialized.steps[1]).toHaveProperty('args.owner', '0x5555555555555555555555555555555555555555');
    expect(workflowDraftIsDirty(state)).toBe(true);
  });

  it('accepts an update by rewriting the source pin in the editable draft', () => {
    let state = deployDraftReducer(undefined, hydrateWorkflowDraft({ repoPathOrUrl: '/workspace', name: 'release', docHash: 'b'.repeat(64), document }));
    state = deployDraftReducer(state, acceptWorkflowPinUpdate({ sourceId: 'token', commit: '9'.repeat(40), ref: 'v2.0.0', refKind: 'tag' }));
    expect(state.contracts[0].pin).toMatchObject({ commit: '9'.repeat(40), ref: 'v2.0.0' });
    expect(workflowDocumentFromDraft(state).sources[0].repo).toMatchObject({ commit: '9'.repeat(40), ref: 'v2.0.0' });
  });
});
