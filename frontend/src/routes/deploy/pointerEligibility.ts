import type { Step } from '@ignite/api';
import type { DraftStep, DeployDraftState } from '../../store/features/deployments/types';

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
    (value as { $ref?: { kind?: string; stepId?: string } }).$ref?.kind === 'step'
  )
    return (value as { $ref: { stepId: string } }).$ref.stepId === id;
  if (Array.isArray(value)) return value.some((entry) => referencesStep(entry, id));
  if (value && typeof value === 'object')
    return Object.values(value).some((entry) => referencesStep(entry, id));
  return false;
}

function predictionDependencies(draft: DeployDraftState, step: DraftStep): string[] {
  if (step.kind !== 'deploy') return [];
  const extras = draft.deployExtras[step.id];
  return draft.steps.flatMap((candidate) => {
    if (candidate.kind !== 'deploy') return [];
    const id = candidate.id;
    const linked =
      referencesStep(step.args, id) ||
      referencesStep(step.argsPerChain, id) ||
      Object.values(extras?.libraries ?? {}).some(
        (binding) => binding.kind === 'step' && binding.stepId === id
      ) ||
      Object.values(extras?.librariesPerChain ?? {}).some((bindings) =>
        Object.values(bindings).some(
          (binding) => binding.kind === 'step' && binding.stepId === id
        )
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
      (step.target.kind === 'step' && step.target.stepId === stepId ||
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
    return argsReference || targetReference || libraryReference ? [step.id] : [];
  });
}

function reaches(draft: DeployDraftState, fromId: string, targetId: string, seen = new Set<string>()): boolean {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const step = draft.steps.find((candidate) => candidate.id === fromId);
  return Boolean(step && predictionDependencies(draft, step).some((id) => reaches(draft, id, targetId, seen)));
}

export function eligiblePointerSteps(
  draft: DeployDraftState,
  sourceStepId: string
): EligiblePointerStep[] {
  const sourceIndex = draft.steps.findIndex((step) => step.id === sourceStepId);
  const source = draft.steps[sourceIndex];
  if (!source || source.kind !== 'deploy') return [];
  const sourceStrategy = draft.deployExtras[source.id]?.strategy.kind ?? 'create';
  return draft.steps.flatMap((target, targetIndex) => {
    if (target.kind !== 'deploy' || target.id === source.id) return [];
    const targetStrategy = draft.deployExtras[target.id]?.strategy.kind ?? 'create';
    const label = draft.contracts.find((contract) => contract.id === target.contractId)?.contractName ?? target.id;
    if (targetStrategy === 'create') {
      if (sourceStrategy !== 'create')
        return [{ stepId: target.id, label, disabledReason: 'Plain-create address is unknown at prediction time' }];
      if (targetIndex >= sourceIndex)
        return [{ stepId: target.id, label, disabledReason: 'Later plain-create step — address unknown at prediction time' }];
      return [{ stepId: target.id, label }];
    }
    if (sourceStrategy !== 'create' && reaches(draft, target.id, source.id))
      return [{ stepId: target.id, label, disabledReason: 'Would create a prediction cycle' }];
    return [{ stepId: target.id, label }];
  });
}

export function earlierDeploySteps(draft: DeployDraftState, stepId: string): EligiblePointerStep[] {
  const until = draft.steps.findIndex((step) => step.id === stepId);
  return draft.steps.slice(0, Math.max(0, until)).flatMap((step) => {
    if (step.kind !== 'deploy') return [];
    return [{
      stepId: step.id,
      label: draft.contracts.find((contract) => contract.id === step.contractId)?.contractName ?? step.id,
    }];
  });
}

/** Call targets are executed immediately at their place in the plan, so only
 * a deployment which has already run can be selected as a target. */
export function callTargetPointerSteps(
  draft: DeployDraftState,
  stepId: string
): EligiblePointerStep[] {
  return earlierDeploySteps(draft, stepId);
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
    return [
      {
        stepId: target.id,
        label,
        ...(strategy === 'create' && targetIndex > sourceIndex
          ? {
              disabledReason:
                'Later plain-create step — address unknown at prediction time',
            }
          : {}),
      },
    ];
  });
}
