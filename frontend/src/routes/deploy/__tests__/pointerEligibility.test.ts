// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { DeployDraftState } from '../../../store/features/deployments/types';
import {
  callArgumentPointerSteps,
  callTargetPointerSteps,
  dependentPlanStepIds,
  partitionDeterministicChains,
  eligiblePointerSteps,
} from '../pointerEligibility';

const draft = (): DeployDraftState => ({
  contracts: ['A', 'B', 'C'].map((id) => ({
    id,
    repoPathOrUrl: '/repo',
    frameworkId: 'foundry',
    artifactPath: `${id}.json`,
    contractName: id,
    sourcePath: `${id}.sol`,
  })),
  chains: [],
  rpcSelection: {},
  explorerSelection: {},
  signers: {},
  unseenIds: [],
  steps: ['A', 'B', 'C'].map((id) => ({
    id: `deploy-${id}`,
    kind: 'deploy' as const,
    contractId: id,
  })),
  deployExtras: {},
});

describe('eligiblePointerSteps', () => {
  it('allows only earlier plain-create deploys from a plain create step', () => {
    const state = draft();
    expect(eligiblePointerSteps(state, 'deploy-B')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-C',
        label: 'C',
        disabledReason:
          'Later plain-create step — address unknown at prediction time',
      },
    ]);
  });

  it('allows deterministic targets anywhere but prevents prediction cycles', () => {
    const state = draft();
    state.deployExtras['deploy-A'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[0].args = {
      target: { $ref: { kind: 'step', stepId: 'deploy-B' } },
    };
    const options = eligiblePointerSteps(state, 'deploy-B');
    expect(
      options.find((option) => option.stepId === 'deploy-A')?.disabledReason
    ).toBe('Would create a prediction cycle');
  });

  it('allows an earlier plain-create target from a deterministic step and blocks a later one', () => {
    const state = draft();
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };

    expect(eligiblePointerSteps(state, 'deploy-B')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-C',
        label: 'C',
        disabledReason: 'Later plain-create step — lands after this deployment',
      },
    ]);
  });

  it('blocks a forward deterministic target that is dynamic on a selected chain', () => {
    const state = draft();
    state.chains = [1];
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[2].args = {
      box: { $ref: { kind: 'step', stepId: 'deploy-A' } },
    };

    expect(
      eligiblePointerSteps(state, 'deploy-B').find(
        (option) => option.stepId === 'deploy-C'
      )
    ).toEqual({
      stepId: 'deploy-C',
      label: 'C',
      disabledReason:
        'Later dynamic deterministic step — lands after this deployment',
    });
  });

  it('partitions dynamic deterministic steps per chain after args and library merges', () => {
    const state = draft();
    state.chains = [1, 2];
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[1].argsPerChain = {
      '1': { box: { $ref: { kind: 'step', stepId: 'deploy-A' } } },
    };
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
      librariesPerChain: {
        '2': { 'src/Box.sol:Box': { kind: 'step', stepId: 'deploy-A' } },
      },
    };

    expect(partitionDeterministicChains(state, 'deploy-B')).toEqual({
      staticChains: [2],
      dynamicChains: [1],
    });
    expect(partitionDeterministicChains(state, 'deploy-C')).toEqual({
      staticChains: [1],
      dynamicChains: [2],
    });
  });

  it('finds plan dependents through arguments, call targets, and library bindings', () => {
    expect(
      dependentPlanStepIds(
        [
          { id: 'source', kind: 'deploy', contractId: 'A' },
          {
            id: 'args',
            kind: 'deploy',
            contractId: 'B',
            args: { owner: { $ref: { kind: 'step', stepId: 'source' } } },
          },
          {
            id: 'target',
            kind: 'call',
            target: { kind: 'step', stepId: 'source' },
          },
          {
            id: 'library',
            kind: 'deploy',
            contractId: 'C',
            libraries: { Lib: { kind: 'step', stepId: 'source' } },
          },
        ],
        'source'
      )
    ).toEqual(['args', 'target', 'library']);
  });

  it('limits call targets to earlier deploys but permits deterministic later argument pointers', () => {
    const state = draft();
    state.steps.splice(1, 0, { id: 'call', kind: 'call', target: null });
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'create2', salt: `0x${'1'.repeat(64)}` },
    };

    expect(callTargetPointerSteps(state, 'call')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
    ]);
    expect(callArgumentPointerSteps(state, 'call')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-B',
        label: 'B',
        disabledReason:
          'Later plain-create step — address unknown at prediction time',
      },
      { stepId: 'deploy-C', label: 'C' },
    ]);
  });
});
