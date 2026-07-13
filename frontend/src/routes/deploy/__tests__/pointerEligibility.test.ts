// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { DeployDraftState } from '../../../store/features/deployments/types';
import {
  callArgumentPointerSteps,
  callTargetPointerSteps,
  dependentPlanStepIds,
  eligiblePointerSteps,
} from '../pointerEligibility';

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

  it('finds plan dependents through arguments, call targets, and library bindings', () => {
    expect(dependentPlanStepIds([
      { id: 'source', kind: 'deploy', contractId: 'A' },
      { id: 'args', kind: 'deploy', contractId: 'B', args: { owner: { $ref: { kind: 'step', stepId: 'source' } } } },
      { id: 'target', kind: 'call', target: { kind: 'step', stepId: 'source' } },
      { id: 'library', kind: 'deploy', contractId: 'C', libraries: { Lib: { kind: 'step', stepId: 'source' } } },
    ], 'source')).toEqual(['args', 'target', 'library']);
  });

  it('limits call targets to earlier deploys but permits deterministic later argument pointers', () => {
    const state = draft();
    state.steps.splice(1, 0, { id: 'call', kind: 'call', target: null });
    state.deployExtras['deploy-C'] = { strategy: { kind: 'create2', salt: `0x${'1'.repeat(64)}` } };

    expect(callTargetPointerSteps(state, 'call')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
    ]);
    expect(callArgumentPointerSteps(state, 'call')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      { stepId: 'deploy-B', label: 'B', disabledReason: 'Later plain-create step — address unknown at prediction time' },
      { stepId: 'deploy-C', label: 'C' },
    ]);
  });
});
