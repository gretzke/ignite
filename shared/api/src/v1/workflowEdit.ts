import { makeWorkflowDocumentSchema, validateWorkflowClosure, type WorkflowDocument, type WorkflowPin, type WorkflowSource } from './workflows.js';

export interface ClearedWorkflowRef { stepId: string; path: string }

function clone<T>(value: T): T { return globalThis.structuredClone(value); }

function pathPart(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function normalizeName(contractName: string): string {
  return contractName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'contract';
}

function mintId(contractName: string, used: Set<string>): string {
  const name = normalizeName(contractName);
  let counter = 1;
  while (used.has(`${name}-${counter}`)) counter += 1;
  return `${name}-${counter}`;
}

function assertValid(doc: WorkflowDocument): WorkflowDocument {
  const parsed = makeWorkflowDocumentSchema().parse(doc);
  const missing = validateWorkflowClosure(parsed);
  if (missing.length) throw new Error(`workflow closure is missing required plugins: ${missing.join(', ')}`);
  return parsed;
}

function requiredStepRefs(step: WorkflowDocument['steps'][number]): string[] {
  if (step.kind === 'deploy') return step.wraps ? [step.wraps.stepId] : [];
  return [step.target, ...Object.values(step.targetPerChain ?? {})].flatMap((target) => target.kind === 'step' ? [target.stepId] : []);
}

function clearArgReferences(value: unknown, path: string, removedStepIds: Set<string>, removedSourceId: string, clearedRefs: ClearedWorkflowRef[], clearStepRefs: boolean): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const entry = value[index];
      if (clearStepRefs && isRemovedStepRef(entry, removedStepIds)) {
        clearedRefs.push({ stepId: '', path: `${pathPart(path, index)}.$ref.stepId` });
        value.splice(index, 1);
      } else if (isEncodeForSource(entry, removedSourceId)) {
        clearedRefs.push({ stepId: '', path: `${pathPart(path, index)}.$encode.contractId` });
        value[index] = null;
      } else clearArgReferences(entry, pathPart(path, index), removedStepIds, removedSourceId, clearedRefs, clearStepRefs);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const entryPath = pathPart(path, key);
    if (clearStepRefs && isRemovedStepRef(entry, removedStepIds)) {
      clearedRefs.push({ stepId: '', path: `${entryPath}.$ref.stepId` });
      delete record[key];
    } else if (isEncodeForSource(entry, removedSourceId)) {
      clearedRefs.push({ stepId: '', path: `${entryPath}.$encode.contractId` });
      delete record[key];
    } else clearArgReferences(entry, entryPath, removedStepIds, removedSourceId, clearedRefs, clearStepRefs);
  }
}

function isRemovedStepRef(value: unknown, removedStepIds: Set<string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = (value as Record<string, unknown>).$ref;
  return !!ref && typeof ref === 'object' && !Array.isArray(ref) && (ref as Record<string, unknown>).kind === 'step' && typeof (ref as Record<string, unknown>).stepId === 'string' && removedStepIds.has((ref as Record<string, unknown>).stepId as string);
}

function isEncodeForSource(value: unknown, sourceId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const encode = (value as Record<string, unknown>).$encode;
  return !!encode && typeof encode === 'object' && !Array.isArray(encode) && (encode as Record<string, unknown>).contractId === sourceId;
}

function clearLibraries(step: Extract<WorkflowDocument['steps'][number], { kind: 'deploy' }>, path: string, removedStepIds: Set<string>, clearedRefs: ClearedWorkflowRef[]): void {
  for (const [name, binding] of Object.entries(step.libraries ?? {})) {
    if (binding.kind === 'step' && removedStepIds.has(binding.stepId)) {
      clearedRefs.push({ stepId: step.id, path: `${pathPart(pathPart(path, 'libraries'), name)}.stepId` });
      delete step.libraries![name];
    }
  }
  for (const [chain, libraries] of Object.entries(step.librariesPerChain ?? {})) for (const [name, binding] of Object.entries(libraries)) {
    if (binding.kind === 'step' && removedStepIds.has(binding.stepId)) {
      clearedRefs.push({ stepId: step.id, path: `${pathPart(pathPart(pathPart(path, 'librariesPerChain'), chain), name)}.stepId` });
      delete libraries[name];
    }
  }
}

export function mintSourceId(doc: WorkflowDocument, contractName: string): string {
  return mintId(contractName, new Set(doc.sources.map((source) => source.id)));
}

export function cascadeRemoveSource(doc: WorkflowDocument, sourceId: string): { doc: WorkflowDocument; removedStepIds: string[]; clearedRefs: ClearedWorkflowRef[] } {
  const next = clone(doc);
  const removed = new Set(next.steps.filter((step) => step.kind === 'deploy' && step.contractId === sourceId).map((step) => step.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of next.steps) if (!removed.has(step.id) && requiredStepRefs(step).some((id) => removed.has(id))) {
      removed.add(step.id);
      changed = true;
    }
  }
  next.sources = next.sources.filter((source) => source.id !== sourceId);
  next.steps = next.steps.filter((step) => !removed.has(step.id));
  const clearedRefs: ClearedWorkflowRef[] = [];
  for (let index = 0; index < next.steps.length; index += 1) {
    const step = next.steps[index];
    const stepPath = `$.steps[${index}]`;
    if (step.kind === 'deploy') clearLibraries(step, stepPath, removed, clearedRefs);
    clearArgReferences(step.args, `${stepPath}.args`, removed, sourceId, clearedRefs, true);
    clearArgReferences(step.argsPerChain, `${stepPath}.argsPerChain`, removed, sourceId, clearedRefs, true);
    if (step.kind === 'deploy' && step.strategy?.kind === 'plugin') clearArgReferences(step.strategy.params, `${stepPath}.strategy.params`, removed, sourceId, clearedRefs, false);
  }
  for (const cleared of clearedRefs) if (!cleared.stepId) {
    const match = /^\$\.steps\[(\d+)\]/.exec(cleared.path);
    cleared.stepId = match ? next.steps[Number(match[1])].id : '';
  }
  return { doc: assertValid(next), removedStepIds: [...removed], clearedRefs };
}

export function appendSource(doc: WorkflowDocument, source: WorkflowSource, requiredPlugin: { id: string; version: string; source?: { kind: 'local'; contextDir: string; dockerfile?: string } | { kind: 'git'; url: string; ref?: string; track?: { mode: 'release'; version: string } | { mode: 'branch'; branch: string } | { mode: 'commit' }; commit?: string } }): { doc: WorkflowDocument; sourceId: string; stepId: string } {
  const next = clone(doc);
  const sourceId = mintSourceId(next, source.contractName);
  const stepId = mintId(`deploy-${sourceId}`, new Set(next.steps.map((step) => step.id)));
  next.sources.push({ ...clone(source), id: sourceId });
  next.steps.push({ id: stepId, kind: 'deploy', contractId: sourceId });
  if (!next.requiredPlugins.some((plugin) => plugin.id === requiredPlugin.id)) next.requiredPlugins.push(clone(requiredPlugin));
  return { doc: assertValid(next), sourceId, stepId };
}

export function changeSourceVersion(doc: WorkflowDocument, sourceId: string, pin: WorkflowPin): WorkflowDocument {
  const next = clone(doc);
  const source = next.sources.find((candidate) => candidate.id === sourceId);
  if (!source || source.origin === 'contract-type') throw new Error(`repo workflow source not found: ${sourceId}`);
  source.repo = clone(pin);
  delete source.artifactHash;
  return assertValid(next);
}
