import type { Step } from '@ignite/api';
import type {
  DraftStep,
  DeployDraftState,
} from '../../store/features/deployments/types';

export interface EligiblePointerStep {
  stepId: string;
  label: string;
  disabledReason?: string;
}

export function referencesStep(value: unknown, id: string): boolean {
  if (
    value &&
    typeof value === 'object' &&
    '$ref' in value &&
    (value as { $ref?: { kind?: string; stepId?: string } }).$ref?.kind ===
      'step'
  )
    return (value as { $ref: { stepId: string } }).$ref.stepId === id;
  if (Array.isArray(value))
    return value.some((entry) => referencesStep(entry, id));
  if (value && typeof value === 'object')
    return Object.values(value).some((entry) => referencesStep(entry, id));
  return false;
}

/**
 * Returns deployment inputs after the same per-chain override merge used by
 * the deployment resolver. This graph intentionally excludes calls: they do
 * not produce deterministic deployment addresses.
 */
export function predictionDependencies(
  draft: DeployDraftState,
  step: DraftStep,
  chainId: number
): string[] {
  if (step.kind !== 'deploy') return [];
  const extras = draft.deployExtras[step.id];
  const args = {
    ...(step.args ?? {}),
    ...(step.argsPerChain?.[String(chainId)] ?? {}),
  };
  const libraries = {
    ...(extras?.libraries ?? {}),
    ...(extras?.librariesPerChain?.[String(chainId)] ?? {}),
  };
  return draft.steps.flatMap((candidate) => {
    if (candidate.kind !== 'deploy') return [];
    const id = candidate.id;
    const linked =
      referencesStep(args, id) ||
      Object.values(libraries).some(
        (binding) => binding.kind === 'step' && binding.stepId === id
      );
    return linked ? [id] : [];
  });
}

/** Steps whose inputs require the address produced by `stepId`.  This is
 * deliberately plan-shaped as well as draft-shaped: the run resolver needs
 * the identical graph walk before allowing a skip. */
export function dependentPlanStepIds(steps: Step[], stepId: string): string[] {
  return steps.flatMap((step) => {
    const argsReference =
      referencesStep(step.args, stepId) ||
      referencesStep(step.argsPerChain, stepId);
    const targetReference =
      step.kind === 'call' &&
      ((step.target.kind === 'step' && step.target.stepId === stepId) ||
        Object.values(step.targetPerChain ?? {}).some(
          (target) => target.kind === 'step' && target.stepId === stepId
        ));
    const libraryReference =
      step.kind === 'deploy' &&
      (Object.values(step.libraries ?? {}).some(
        (binding) => binding.kind === 'step' && binding.stepId === stepId
      ) ||
        Object.values(step.librariesPerChain ?? {}).some((bindings) =>
          Object.values(bindings).some(
            (binding) => binding.kind === 'step' && binding.stepId === stepId
          )
        ));
    return argsReference || targetReference || libraryReference
      ? [step.id]
      : [];
  });
}

export function reaches(
  draft: DeployDraftState,
  fromId: string,
  targetId: string,
  chainId: number,
  seen = new Set<string>()
): boolean {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const step = draft.steps.find((candidate) => candidate.id === fromId);
  return Boolean(
    step &&
    predictionDependencies(draft, step, chainId).some((id) =>
      reaches(draft, id, targetId, chainId, seen)
    )
  );
}

function draftStrategyKind(
  draft: DeployDraftState,
  stepId: string
): 'create' | 'create2' | 'plugin' {
  return draft.deployExtras[stepId]?.strategy.kind ?? 'create';
}

/** Draft-shaped counterpart to core's dynamicDeterministicStepIds. */
export function dynamicDeterministicDraftStepIds(
  draft: DeployDraftState,
  chainId: number
): Set<string> {
  const byId = new Map(draft.steps.map((step) => [step.id, step]));
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const dynamic = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const step = byId.get(id);
    if (
      !step ||
      step.kind !== 'deploy' ||
      draftStrategyKind(draft, id) === 'create'
    )
      return false;
    // Deterministic-only cycles remain prediction cycles, rather than making
    // either side dynamic. This matches the resolver's cycle-safe walk.
    if (visiting.has(id)) return false;
    visiting.add(id);
    const result = predictionDependencies(draft, step, chainId).some(
      (targetId) => {
        const target = byId.get(targetId);
        return Boolean(
          target &&
          target.kind === 'deploy' &&
          (draftStrategyKind(draft, target.id) === 'create' ||
            dynamic(target.id))
        );
      }
    );
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const step of draft.steps) {
    if (
      step.kind === 'deploy' &&
      draftStrategyKind(draft, step.id) !== 'create'
    )
      dynamic(step.id);
  }
  return new Set(
    [...memo].flatMap(([id, isDynamic]) => (isDynamic ? [id] : []))
  );
}

export function partitionDeterministicChains(
  draft: DeployDraftState,
  stepId: string
): { staticChains: number[]; dynamicChains: number[] } {
  return draft.chains.reduce(
    (partition, chainId) => {
      if (dynamicDeterministicDraftStepIds(draft, chainId).has(stepId))
        partition.dynamicChains.push(chainId);
      else partition.staticChains.push(chainId);
      return partition;
    },
    { staticChains: [] as number[], dynamicChains: [] as number[] }
  );
}

export function eligiblePointerSteps(
  draft: DeployDraftState,
  sourceStepId: string
): EligiblePointerStep[] {
  const sourceIndex = draft.steps.findIndex((step) => step.id === sourceStepId);
  const source = draft.steps[sourceIndex];
  if (!source || source.kind !== 'deploy') return [];
  const sourceStrategy = draftStrategyKind(draft, source.id);
  // An unselected draft is validated by the server with its conventional
  // chain context. The ordinary UI path has at least one selected chain.
  const chainIds = draft.chains.length ? draft.chains : [1];
  return draft.steps.flatMap((target, targetIndex) => {
    if (target.kind !== 'deploy' || target.id === source.id) return [];
    const targetStrategy = draftStrategyKind(draft, target.id);
    const label =
      draft.contracts.find((contract) => contract.id === target.contractId)
        ?.contractName ?? target.id;
    if (targetStrategy === 'create') {
      if (sourceStrategy !== 'create')
        return targetIndex < sourceIndex
          ? [{ stepId: target.id, label }]
          : [
              {
                stepId: target.id,
                label,
                disabledReason:
                  'Later plain-create step — lands after this deployment',
              },
            ];
      if (targetIndex >= sourceIndex)
        return [
          {
            stepId: target.id,
            label,
            disabledReason:
              'Later plain-create step — address unknown at prediction time',
          },
        ];
      return [{ stepId: target.id, label }];
    }
    if (
      sourceStrategy !== 'create' &&
      chainIds.some((chainId) => reaches(draft, target.id, source.id, chainId))
    )
      return [
        {
          stepId: target.id,
          label,
          disabledReason: 'Would create a prediction cycle',
        },
      ];
    if (
      targetIndex >= sourceIndex &&
      chainIds.some((chainId) =>
        dynamicDeterministicDraftStepIds(draft, chainId).has(target.id)
      )
    )
      return [
        {
          stepId: target.id,
          label,
          disabledReason:
            'Later dynamic deterministic step — lands after this deployment',
        },
      ];
    return [{ stepId: target.id, label }];
  });
}

export function earlierDeploySteps(
  draft: DeployDraftState,
  stepId: string
): EligiblePointerStep[] {
  const until = draft.steps.findIndex((step) => step.id === stepId);
  return draft.steps.slice(0, Math.max(0, until)).flatMap((step) => {
    if (step.kind !== 'deploy') return [];
    return [
      {
        stepId: step.id,
        label:
          draft.contracts.find((contract) => contract.id === step.contractId)
            ?.contractName ?? step.id,
      },
    ];
  });
}

/** Call targets are executed immediately at their place in the plan, so only
 * a deployment which has already run can be selected as a target. */
export function callTargetPointerSteps(
  draft: DeployDraftState,
  stepId: string
): EligiblePointerStep[] {
  const sourceIndex = draft.steps.findIndex((step) => step.id === stepId);
  if (sourceIndex === -1) return [];
  const chainIds = draft.chains.length ? draft.chains : [1];
  return draft.steps.flatMap((target, targetIndex) => {
    if (target.kind !== 'deploy') return [];
    const label =
      draft.contracts.find((contract) => contract.id === target.contractId)
        ?.contractName ?? target.id;
    if (targetIndex < sourceIndex) return [{ stepId: target.id, label }];
    const dynamic = chainIds.some((chainId) =>
      dynamicDeterministicDraftStepIds(draft, chainId).has(target.id)
    );
    const strategy = draftStrategyKind(draft, target.id);
    return [{
      stepId: target.id,
      label,
      disabledReason: dynamic
        ? 'Later dynamic deterministic step — lands after this call'
        : strategy === 'create'
          ? 'Later plain-create step — lands after this call'
          : 'Later deterministic step — lands after this call',
    }];
  });
}

/** A call argument may point at any deterministic deployment. A later plain
 * CREATE has no address at the time this call is encoded, however, so leave it
 * visible but unavailable and explain why. */
export function callArgumentPointerSteps(
  draft: DeployDraftState,
  stepId: string
): EligiblePointerStep[] {
  const sourceIndex = draft.steps.findIndex((step) => step.id === stepId);
  if (sourceIndex === -1) return [];
  return draft.steps.flatMap((target, targetIndex) => {
    if (target.kind !== 'deploy') return [];
    const label =
      draft.contracts.find((contract) => contract.id === target.contractId)
        ?.contractName ?? target.id;
    const strategy = draft.deployExtras[target.id]?.strategy.kind ?? 'create';
    const dynamic = (draft.chains.length ? draft.chains : [1]).some(
      (chainId) =>
        dynamicDeterministicDraftStepIds(draft, chainId).has(target.id)
    );
    return [
      {
        stepId: target.id,
        label,
        ...(dynamic && targetIndex > sourceIndex
          ? {
              disabledReason:
                'Later dynamic deterministic step — lands after this call',
            }
          : strategy === 'create' && targetIndex > sourceIndex
          ? {
              disabledReason:
                'Later plain-create step — address unknown at prediction time',
            }
          : {}),
      },
    ];
  });
}
