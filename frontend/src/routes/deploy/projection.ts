import type {
  DeploymentPlan,
  ExternalResolution,
  Hex,
  Step,
  WorkflowDocument,
  WorkflowStep,
} from '@ignite/api';

export interface WorkflowProjectionInput {
  document: WorkflowDocument;
  repoPathOrUrl: string;
  chains: number[];
  includedStepIds: Record<string, boolean>;
  resolutions: ExternalResolution[];
}

export interface UnboundWorkflowSlot {
  stepId: string;
  path: string;
  chainId: number;
  sourceStepId: string;
}

const escapePointer = (token: string) => token.replaceAll('~', '~0').replaceAll('/', '~1');
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isStepRef = (value: unknown): value is { $ref: { kind: 'step'; stepId: string } } =>
  Boolean(value && typeof value === 'object' && '$ref' in value && (value as { $ref?: { kind?: unknown } }).$ref?.kind === 'step');

function resolutionFor(resolutions: ExternalResolution[], stepId: string, path: string, chainId: number) {
  return resolutions.find((item) => item.stepId === stepId && item.path === path && item.chainId === chainId);
}

function projectValue(
  value: unknown,
  stepId: string,
  path: string,
  chainId: number,
  included: Record<string, boolean>,
  resolutions: ExternalResolution[],
  slots?: UnboundWorkflowSlot[]
): { value: unknown; changed: boolean } {
  if (isStepRef(value) && included[value.$ref.stepId] === false) {
    const resolution = resolutionFor(resolutions, stepId, path, chainId);
    if (!resolution) slots?.push({ stepId, path, chainId, sourceStepId: value.$ref.stepId });
    return { value: resolution?.address ?? value, changed: Boolean(resolution) };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const projected = projectValue(item, stepId, `${path}/${index}`, chainId, included, resolutions, slots);
      changed ||= projected.changed;
      return projected.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const projected = projectValue(item, stepId, `${path}/${escapePointer(key)}`, chainId, included, resolutions, slots);
      changed ||= projected.changed;
      return [key, projected.value];
    }));
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

function containsExcluded(value: unknown, included: Record<string, boolean>): boolean {
  if (isStepRef(value)) return included[value.$ref.stepId] === false;
  if (Array.isArray(value)) return value.some((item) => containsExcluded(item, included));
  return Boolean(value && typeof value === 'object' && Object.values(value).some((item) => containsExcluded(item, included)));
}

function projectArgs(step: WorkflowStep, chains: number[], included: Record<string, boolean>, resolutions: ExternalResolution[], slots?: UnboundWorkflowSlot[]) {
  const global = { ...(step.args ?? {}) };
  const perChain = Object.fromEntries(Object.entries(step.argsPerChain ?? {}).map(([chain, args]) => [chain, { ...args }]));
  const keys = new Set([...Object.keys(global), ...Object.values(perChain).flatMap((args) => Object.keys(args))]);
  for (const key of keys) {
    const globalValue = global[key];
    const globalOrphan = containsExcluded(globalValue, included);
    if (globalOrphan) delete global[key];
    for (const chainId of chains) {
      const chainKey = String(chainId);
      const overrides = perChain[chainKey] ?? {};
      const effective = hasOwn(overrides, key) ? overrides[key] : globalValue;
      if (effective === undefined) continue;
      const projected = projectValue(effective, step.id, `/args/${escapePointer(key)}`, chainId, included, resolutions, slots);
      if (globalOrphan || projected.changed) {
        (perChain[chainKey] ??= {})[key] = projected.value;
      }
    }
  }
  for (const [chain, args] of Object.entries(perChain)) if (Object.keys(args).length === 0) delete perChain[chain];
  return { args: Object.keys(global).length ? global : undefined, argsPerChain: Object.keys(perChain).length ? perChain : undefined };
}

function projectStep(step: WorkflowStep, chains: number[], included: Record<string, boolean>, resolutions: ExternalResolution[], slots?: UnboundWorkflowSlot[]): Step {
  const args = projectArgs(step, chains, included, resolutions, slots);
  const result: Record<string, unknown> = { ...step, ...args };
  if (!args.args) delete result.args;
  if (!args.argsPerChain) delete result.argsPerChain;
  if (step.kind === 'call') {
    const globalOrphan = step.target.kind === 'step' && included[step.target.stepId] === false;
    const targetPerChain = { ...(step.targetPerChain ?? {}) };
    for (const chainId of chains) {
      const chainKey = String(chainId);
      const target = targetPerChain[chainKey] ?? step.target;
      if (target.kind !== 'step' || included[target.stepId] !== false) continue;
      const path = '/target';
      const resolution = resolutionFor(resolutions, step.id, path, chainId);
      if (!resolution) slots?.push({ stepId: step.id, path, chainId, sourceStepId: target.stepId });
      if (resolution) targetPerChain[chainKey] = { kind: 'address', address: resolution.address };
    }
    if (globalOrphan) {
      const first = targetPerChain[String(chains[0])];
      if (first && (first.kind === 'address' || included[first.stepId] !== false)) result.target = first;
    }
    if (Object.keys(targetPerChain).length) result.targetPerChain = targetPerChain;
  } else {
    const libraries = { ...(step.libraries ?? {}) };
    const perChain = Object.fromEntries(Object.entries(step.librariesPerChain ?? {}).map(([chain, entries]) => [chain, { ...entries }]));
    const keys = new Set([...Object.keys(libraries), ...Object.values(perChain).flatMap((entries) => Object.keys(entries))]);
    for (const key of keys) {
      const global = libraries[key];
      const globalOrphan = global?.kind === 'step' && included[global.stepId] === false;
      if (globalOrphan) delete libraries[key];
      for (const chainId of chains) {
        const chainKey = String(chainId);
        const binding = perChain[chainKey]?.[key] ?? global;
        if (binding?.kind !== 'step' || included[binding.stepId] !== false) continue;
        const path = `/libraries/${escapePointer(key)}`;
        const resolution = resolutionFor(resolutions, step.id, path, chainId);
        if (!resolution) slots?.push({ stepId: step.id, path, chainId, sourceStepId: binding.stepId });
        if (resolution) (perChain[chainKey] ??= {})[key] = { kind: 'address', address: resolution.address as Hex };
      }
    }
    if (Object.keys(libraries).length) result.libraries = libraries; else delete result.libraries;
    if (Object.keys(perChain).length) result.librariesPerChain = perChain; else delete result.librariesPerChain;
  }
  return result as unknown as Step;
}

export function collectUnboundWorkflowSlots(input: Omit<WorkflowProjectionInput, 'resolutions'> & { resolutions?: ExternalResolution[] }): UnboundWorkflowSlot[] {
  const slots: UnboundWorkflowSlot[] = [];
  for (const step of input.document.steps) {
    if (input.includedStepIds[step.id] === false) continue;
    projectStep(step, input.chains, input.includedStepIds, input.resolutions ?? [], slots);
  }
  return slots.filter((slot, index, all) => all.findIndex((item) => item.stepId === slot.stepId && item.path === slot.path && item.chainId === slot.chainId) === index);
}

export function projectWorkflowPlan(input: WorkflowProjectionInput): DeploymentPlan {
  const steps = input.document.steps
    .filter((step) => input.includedStepIds[step.id] !== false)
    .map((step) => projectStep(step, input.chains, input.includedStepIds, input.resolutions));
  const usedSources = new Set(steps.filter((step) => step.kind === 'deploy').map((step) => step.contractId));
  return {
    schemaVersion: 1,
    contracts: input.document.sources.filter((source) => usedSources.has(source.id)).map((source) => {
      if (source.origin === 'contract-type') throw new Error('contract-type sources are not supported here yet (contract-types plan phase 13)');
      return {
        id: source.id, repoPathOrUrl: source.repo.url, frameworkId: source.frameworkId,
        sourcePath: source.sourcePath, contractName: source.contractName, artifactPath: source.artifactPath, pin: { ...source.repo },
      };
    }),
    steps,
    chains: [...input.chains],
    signers: {},
  };
}
