// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { DeployDraftState } from '../../../store/features/deployments/types';
import { eligiblePointerSteps } from '../pointerEligibility';

const draft = (): DeployDraftState => ({
  contracts: ['A', 'B', 'C'].map((id) => ({ id, repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: `${id}.json`, contractName: id, sourcePath: `${id}.sol` })),
  chains: [], rpcSelection: {}, explorerSelection: {}, signers: {}, unseenIds: [],
  steps: ['A', 'B', 'C'].map((id) => ({ id: `deploy-${id}`, kind: 'deploy' as const, contractId: id })),
  deployExtras: {},
});

describe('eligiblePointerSteps', () => {
  it('allows only earlier plain-create deploys from a plain create step', () => {
    const state = draft();
    expect(eligiblePointerSteps(state, 'deploy-B')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      { stepId: 'deploy-C', label: 'C', disabledReason: 'Later plain-create step — address unknown at prediction time' },
    ]);
  });

  it('allows deterministic targets anywhere but prevents prediction cycles', () => {
    const state = draft();
    state.deployExtras['deploy-A'] = { strategy: { kind: 'plugin', pluginId: 'deterministic' } };
    state.deployExtras['deploy-B'] = { strategy: { kind: 'plugin', pluginId: 'deterministic' } };
    state.steps[0].args = { target: { $ref: { kind: 'step', stepId: 'deploy-B' } } };
    const options = eligiblePointerSteps(state, 'deploy-B');
    expect(options.find((option) => option.stepId === 'deploy-A')?.disabledReason).toBe('Would create a prediction cycle');
  });
});
