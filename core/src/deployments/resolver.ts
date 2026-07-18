// Canonical deployment-plan resolution. Validation and execution share these
// rules so a per-chain preview cannot diverge from the transaction submitted.
import { encodeFunctionData, isAddress, parseAbiItem, toFunctionSignature, type AbiFunction, type AbiParameter } from 'viem';
import type {
  ArgValues,
  CallStep,
  DeploymentPlan,
  DeployStep,
  GasOverrides,
  FrozenInputs,
  SignerRef,
  Step,
  Hex,
  LibraryBinding,
} from '@ignite/api';
import { EncodedCallValueSchema, isValueRef } from '@ignite/api';
import { ErrorCodes, IgniteError } from '../types/errors.js';

export function argKeysForAbi(abiInputs: { name?: string }[]): string[] {
  return abiInputs.map((input, index) => input.name || `arg${index}`);
}

type ValueStep = Pick<DeployStep, 'args' | 'argsPerChain' | 'gasOverrides' | 'gasOverridesPerChain' | 'value' | 'valuePerChain'>;
export function mergeArgs(step: ValueStep, chainId: number): ArgValues {
  return {
    ...(step.args ?? {}),
    ...(step.argsPerChain?.[String(chainId)] ?? {}),
  };
}

export function mergeLibraries(step: DeployStep, chainId: number): Record<string, LibraryBinding> {
  return { ...(step.libraries ?? {}), ...(step.librariesPerChain?.[String(chainId)] ?? {}) };
}

export function missingArgKeys(
  abiInputs: { name?: string }[],
  merged: ArgValues
): string[] {
  return argKeysForAbi(abiInputs).filter(
    (key) => !Object.prototype.hasOwnProperty.call(merged, key)
  );
}

export function mergeGas(step: ValueStep, chainId: number): GasOverrides {
  return {
    ...(step.gasOverrides ?? {}),
    ...(step.gasOverridesPerChain?.[String(chainId)] ?? {}),
  };
}

export function effectiveValue(step: ValueStep, chainId: number): bigint {
  return BigInt(step.valuePerChain?.[String(chainId)] ?? step.value ?? '0');
}

export function collectRefs(step: Step, chainId: number): Array<{ path: string; stepId: string }> {
  const refs: Array<{ path: string; stepId: string }> = [];
  const walk = (value: unknown, path: string) => {
    if (isValueRef(value)) { refs.push({ path, stepId: value.$ref.stepId }); return; }
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') Object.entries(value as Record<string, unknown>).forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key));
  };
  walk(mergeArgs(step as DeployStep, chainId), 'args');
  if (step.kind === 'call') {
    const target = step.targetPerChain?.[String(chainId)] ?? step.target;
    if (target.kind === 'step') refs.push({ path: 'target', stepId: target.stepId });
  } else {
    for (const [key, binding] of Object.entries(mergeLibraries(step, chainId))) if (binding.kind === 'step') refs.push({ path: `libraries.${key}`, stepId: binding.stepId });
  }
  return refs;
}

export interface ResolveStepContext {
  frozen?: FrozenInputs;
  contracts?: DeploymentPlan['contracts'];
}

export function resolveStepValues(step: Step, chainId: number, resolveRef: (stepId: string) => Hex, abiInputs: readonly AbiParameter[] = [], context: ResolveStepContext = {}): { args: ArgValues; target?: Hex; libraries?: Record<string, Hex>; pointers: Record<string, Hex> } {
  const pointers: Record<string, Hex> = {};
  const resolve = (stepId: string, path: string): Hex => {
    try { const address = resolveRef(stepId); if (!address) throw new Error('missing'); pointers[path] = address; return address; }
    catch { throw new IgniteError(`Pointer ${stepId} at ${path} is unresolved`, 'POINTER_UNRESOLVED', { stepId, path }); }
  };
  const merged = mergeArgs(step as DeployStep, chainId);
  const args: ArgValues = {};
  for (let index = 0; index < abiInputs.length; index += 1) {
    const parameter = abiInputs[index]; const key = parameter.name || `arg${index}`;
    // Pointer paths use the same `args.`-rooted vocabulary as collectRefs so
    // Attempt.expected.pointers and artifact rendering line up exactly.
    if (Object.prototype.hasOwnProperty.call(merged, key)) args[key] = resolveAbiRefs(parameter, merged[key], `args.${key}`, resolve, context);
  }
  // Without ABI inputs, retain data for callers that only need target/library resolution.
  if (abiInputs.length === 0) Object.assign(args, merged);
  const result: { args: ArgValues; target?: Hex; libraries?: Record<string, Hex>; pointers: Record<string, Hex> } = { args, pointers };
  if (step.kind === 'call') {
    const target = mergeCallTarget(step, chainId);
    result.target = target.kind === 'address' ? target.address : resolve(target.stepId, 'target');
  } else {
    const libraries: Record<string, Hex> = {};
    for (const [key, binding] of Object.entries(mergeLibraries(step, chainId))) libraries[key] = binding.kind === 'address' ? binding.address : resolve(binding.stepId, `libraries.${key}`);
    if (Object.keys(libraries).length) result.libraries = libraries;
  }
  return result;
}

function resolveAbiRefs(parameter: AbiParameter, value: unknown, path: string, resolve: (stepId: string, path: string) => Hex, context: ResolveStepContext): unknown {
  // $encode is intentionally detected by ownership, not by its type guard:
  // a malformed marker must never fall through as a tuple/object value.
  if (ownsEncode(value)) {
    const parsed = EncodedCallValueSchema.safeParse(value);
    if (!parsed.success) throw new IgniteError(`Encoded call at ${path} is malformed`, 'ENCODED_CALL_INVALID', { field: path });
    if (parameter.type !== 'bytes') throw new IgniteError(`Encoded call at ${path} is only valid for bytes ABI inputs`, 'ENCODED_CALL_NON_BYTES', { field: path });
    if (containsEncode(parsed.data.$encode.args)) throw new IgniteError(`Nested $encode is not supported at ${path}`, 'ENCODED_CALL_NESTED', { field: path });
    const contract = context.contracts?.find((candidate) => candidate.id === parsed.data.$encode.contractId);
    const abi = context.frozen?.[parsed.data.$encode.contractId]?.abi;
    if (!contract || !Array.isArray(abi)) throw new IgniteError(`Encoded call contract ${parsed.data.$encode.contractId} is not frozen`, 'ENCODED_CALL_CONTRACT_NOT_FOUND', { contractId: parsed.data.$encode.contractId, field: path });
    const fn = abi.find((entry): entry is AbiFunction => {
      if (!entry || typeof entry !== 'object' || (entry as { type?: string }).type !== 'function') return false;
      try { return toFunctionSignature(entry as AbiFunction) === parsed.data.$encode.fn; } catch { return false; }
    });
    if (!fn) throw new IgniteError(`Encoded call function ${parsed.data.$encode.fn} is not in the frozen ABI`, 'ENCODED_CALL_FUNCTION_NOT_FOUND', { contractId: contract.id, fn: parsed.data.$encode.fn, field: path });
    const rawArgs = parsed.data.$encode.args ?? {};
    const resolvedArgs: ArgValues = {};
    for (let index = 0; index < fn.inputs.length; index += 1) {
      const input = fn.inputs[index]!;
      const key = input.name || `arg${index}`;
      if (Object.prototype.hasOwnProperty.call(rawArgs, key))
        resolvedArgs[key] = resolveAbiRefs(input, rawArgs[key], `${path}.$encode.${key}`, resolve, context);
    }
    return encodeFunctionData({ abi: [fn], functionName: fn.name, args: toConstructorArgs(fn.inputs, resolvedArgs) as never });
  }
  if (isValueRef(value)) {
    if (parameter.type !== 'address') throw new IgniteError(`Pointer at ${path} is only valid for address ABI inputs`, ErrorCodes.ARG_TYPE_MISMATCH, { field: path });
    return resolve(value.$ref.stepId, path);
  }
  const array = parameter.type.match(/^(.*)\[([0-9]*)\]$/);
  if (array && Array.isArray(value)) return value.map((item, index) => resolveAbiRefs({ ...parameter, type: array[1] }, item, `${path}[${index}]`, resolve, context));
  if (parameter.type === 'tuple' && value && typeof value === 'object') {
    const components = 'components' in parameter ? parameter.components ?? [] : [];
    if (Array.isArray(value)) return value.map((item, index) => resolveAbiRefs(components[index]!, item, `${path}.${components[index]?.name || `arg${index}`}`, resolve, context));
    return Object.fromEntries(components.map((component, index) => { const key = component.name || `arg${index}`; return [key, resolveAbiRefs(component, (value as Record<string, unknown>)[key], `${path}.${key}`, resolve, context)]; }));
  }
  return value;
}

function ownsEncode(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '$encode'));
}

function containsEncode(value: unknown): boolean {
  if (ownsEncode(value)) return true;
  if (Array.isArray(value)) return value.some(containsEncode);
  return Boolean(value && typeof value === 'object' && Object.values(value as Record<string, unknown>).some(containsEncode));
}

export function mergeCallTarget(step: CallStep, chainId: number): CallStep['target'] {
  return step.targetPerChain?.[String(chainId)] ?? step.target;
}

/**
 * Calls sent to a wrapper execute against its implementation's interface.
 * The wrapper artifact supplies construction bytecode, but its ABI commonly
 * omits delegated functions (notably ERC1967Proxy and transparent proxies).
 */
export function callTargetAbi(plan: DeploymentPlan, step: CallStep, chainId: number, frozen: FrozenInputs): unknown {
  const target = mergeCallTarget(step, chainId);
  if (target.kind !== 'step') return undefined;
  const targetStep = plan.steps.find(
    (candidate): candidate is DeployStep => candidate.id === target.stepId && candidate.kind === 'deploy'
  );
  if (!targetStep) return undefined;
  const implementation = targetStep.wraps
    ? plan.steps.find(
        (candidate): candidate is DeployStep =>
          candidate.id === targetStep.wraps!.stepId && candidate.kind === 'deploy'
      )
    : undefined;
  return frozen[(implementation ?? targetStep).contractId]?.abi;
}

// The chain matters: targetPerChain may swap between a plan contract (frozen
// ABI is authoritative) and an arbitrary address (parsed signature).
// Signatures compare via viem's canonical form so tuple parameters match.
export function callAbiItem(step: CallStep, chainId: number, frozenAbi?: unknown): AbiFunction | undefined {
  if (!step.signature) return undefined;
  let item: AbiFunction | undefined;
  const target = mergeCallTarget(step, chainId);
  if (target.kind === 'step') {
    item = Array.isArray(frozenAbi)
      ? frozenAbi.find((entry): entry is AbiFunction => {
          if (!entry || typeof entry !== 'object' || (entry as { type?: string }).type !== 'function') return false;
          try { return toFunctionSignature(entry as AbiFunction) === step.signature; } catch { return false; }
        })
      : undefined;
    if (!item) throw new IgniteError(`Call signature ${step.signature} is not in the frozen ABI`, 'SIGNATURE_NOT_IN_ABI');
    if (step.payable !== (item.stateMutability === 'payable')) throw new IgniteError('Call payable declaration does not match the frozen ABI', 'PAYABILITY_MISMATCH');
    return item;
  }
  try { item = parseAbiItem(`function ${step.signature}`) as AbiFunction; }
  catch { throw new IgniteError(`Call signature ${step.signature} is invalid`, 'SIGNATURE_NOT_IN_ABI'); }
  return item;
}

export function validateDependencies(plan: DeploymentPlan): void {
  const byId = new Map(plan.steps.map((step, index) => [step.id, { step, index }]));
  // Per-chain: per-chain overrides can introduce refs/targets that the first
  // chain's merge never sees, and libraries may differ per chain.
  for (const chainId of plan.chains.length ? plan.chains : [1]) {
    const dynamic = dynamicDeterministicStepIds(plan, chainId);
    const graph = new Map<string, string[]>();
    for (const [id, current] of byId) {
      if (current.step.kind === 'call') {
        const target = mergeCallTarget(current.step, chainId);
        if (target.kind === 'step' && (byId.get(target.stepId)?.index ?? Infinity) >= current.index) throw new IgniteError(`Call target ${target.stepId} is not deployed yet`, 'CALL_TARGET_NOT_DEPLOYED', { stepId: target.stepId });
        // Call ARGS resolve at execution time: any earlier step works, and a
        // later create2/plugin step resolves via its predicted address — but
        // a later plain-create step can never resolve.
        for (const ref of collectRefs(current.step, chainId).filter((entry) => entry.path !== 'target')) {
          const refTarget = byId.get(ref.stepId);
          if (!refTarget || refTarget.step.kind !== 'deploy') throw new IgniteError(`Pointer target ${ref.stepId} is not a deploy step`, 'POINTER_TARGET_NOT_DEPLOY', { stepId: ref.stepId });
          const refStrategy = refTarget.step.strategy ?? { kind: 'create' as const };
          if (refStrategy.kind === 'create' && refTarget.index >= current.index) throw new IgniteError(`Call argument ${ref.path} references later create step ${ref.stepId}`, 'POINTER_FORWARD_CREATE', { stepId: ref.stepId, path: ref.path });
          if (dynamic.has(ref.stepId) && refTarget.index >= current.index) throw new IgniteError(`Call argument ${ref.path} references later dynamic step ${ref.stepId}`, 'POINTER_FORWARD_CREATE', { stepId: ref.stepId, path: ref.path });
        }
        continue;
      }
      const strategy = current.step.strategy ?? { kind: 'create' as const };
      const refs = collectRefs(current.step, chainId).filter((ref) => ref.path !== 'target');
      for (const ref of refs) {
        const target = byId.get(ref.stepId);
        if (!target || target.step.kind !== 'deploy') throw new IgniteError(`Pointer target ${ref.stepId} is not a deploy step`, 'POINTER_TARGET_NOT_DEPLOY', { stepId: ref.stepId });
        const targetStrategy = target.step.strategy ?? { kind: 'create' as const };
        if (strategy.kind === 'create' && dynamic.has(ref.stepId) && target.index >= current.index)
          throw new IgniteError(`Create step references later dynamic step ${ref.stepId}`, 'POINTER_FORWARD_CREATE', { stepId: ref.stepId, path: ref.path });
        if (strategy.kind !== 'create' && targetStrategy.kind === 'create' && target.index >= current.index) throw new IgniteError(`Create2 input ${ref.path} references non-concrete create step ${ref.stepId} (later in this lane)`, 'CREATE2_POINTER_NOT_CONCRETE', { stepId: ref.stepId, path: ref.path });
        if (strategy.kind === 'create' && targetStrategy.kind === 'create' && target.index >= current.index) throw new IgniteError(`Create step references later create step ${ref.stepId}`, 'POINTER_FORWARD_CREATE', { stepId: ref.stepId, path: ref.path });
        if (strategy.kind !== 'create' && targetStrategy.kind !== 'create' && dynamic.has(id) && dynamic.has(ref.stepId) && target.index >= current.index)
          throw new IgniteError(`Create2 input ${ref.path} references later dynamic step ${ref.stepId}`, 'CREATE2_POINTER_NOT_CONCRETE', { stepId: ref.stepId, path: ref.path });
        if (strategy.kind !== 'create' && targetStrategy.kind !== 'create') graph.set(id, [...(graph.get(id) ?? []), ref.stepId]);
      }
    }
    const visiting = new Set<string>(); const visited = new Set<string>(); const stack: string[] = [];
    const visit = (id: string) => { if (visiting.has(id)) { const cycle = [...stack.slice(stack.indexOf(id)), id]; throw new IgniteError(`Create2 prediction cycle: ${cycle.join(' -> ')}`, 'CREATE2_PREDICTION_CYCLE', { cycle }); } if (visited.has(id)) return; visiting.add(id); stack.push(id); for (const next of graph.get(id) ?? []) visit(next); stack.pop(); visiting.delete(id); visited.add(id); };
    for (const id of graph.keys()) visit(id);
  }
}

/** Deterministic inputs that cannot be committed before this chain's lane runs. */
export function dynamicDeterministicStepIds(plan: DeploymentPlan, chainId: number): Set<string> {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const dynamic = (id: string): boolean => {
    const known = memo.get(id); if (known !== undefined) return known;
    const step = byId.get(id);
    if (!step || step.kind !== 'deploy' || !step.strategy || step.strategy.kind === 'create') return false;
    // A deterministic-only cycle remains the existing prediction-cycle error;
    // it is not evidence that either input is runtime-dynamic.
    if (visiting.has(id)) return false;
    visiting.add(id);
    const result = collectRefs(step, chainId).some((ref) => {
      const target = byId.get(ref.stepId);
      if (!target || target.kind !== 'deploy') return false;
      return !target.strategy || target.strategy.kind === 'create' || dynamic(target.id);
    });
    visiting.delete(id); memo.set(id, result); return result;
  };
  for (const step of plan.steps) if (step.kind === 'deploy' && step.strategy && step.strategy.kind !== 'create' && dynamic(step.id)) memo.set(step.id, true);
  return new Set([...memo].flatMap(([id, value]) => value ? [id] : []));
}

export function resolveSigner(
  plan: DeploymentPlan,
  step: Step,
  chainId: number
): SignerRef | undefined {
  const key = String(chainId);
  return (
    step.signerOverride?.perChain?.[key] ??
    step.signerOverride?.global ??
    plan.signers.perChain?.[key] ??
    plan.signers.global
  );
}

export function toConstructorArgs(
  abiInputs: readonly AbiParameter[],
  merged: ArgValues
): unknown[] {
  return abiInputs.map((input, index) => {
    const key = input.name || `arg${index}`;
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      throw argError(key, 'is required');
    }
    return coerceAbiValue(input, merged[key], key);
  });
}

function coerceAbiValue(
  parameter: AbiParameter,
  value: unknown,
  field: string
): unknown {
  const arrayMatch = parameter.type.match(/^(.*)\[([0-9]*)\]$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) {
      throw argError(field, 'must be an array');
    }
    const [, elementType, fixedLength] = arrayMatch;
    if (fixedLength && value.length !== Number(fixedLength)) {
      throw argError(field, `must contain exactly ${fixedLength} items`);
    }
    return value.map((item, index) =>
      coerceAbiValue(
        { ...parameter, type: elementType },
        item,
        `${field}[${index}]`
      )
    );
  }

  if (parameter.type === 'tuple') {
    return coerceTuple(parameter, value, field);
  }

  if (/^u?int(?:[0-9]+)?$/.test(parameter.type)) {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw argError(field, 'must be a decimal integer string');
    }
    if (parameter.type.startsWith('uint') && value.startsWith('-')) {
      throw argError(field, 'must not be negative');
    }
    try {
      return BigInt(value);
    } catch {
      throw argError(field, 'must be a decimal integer string');
    }
  }

  if (parameter.type === 'address') {
    if (typeof value !== 'string' || !isAddress(value)) {
      throw argError(field, 'must be a valid address');
    }
    return value;
  }

  if (parameter.type === 'bool') {
    if (typeof value !== 'boolean') throw argError(field, 'must be a boolean');
    return value;
  }

  if (parameter.type === 'string') {
    if (typeof value !== 'string') throw argError(field, 'must be a string');
    return value;
  }

  if (
    parameter.type === 'bytes' ||
    /^bytes(?:[1-9]|[12][0-9]|3[0-2])$/.test(parameter.type)
  ) {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      throw argError(field, 'must be hex data');
    }
    const fixedBytes = parameter.type.match(/^bytes([0-9]+)$/)?.[1];
    if (fixedBytes && value.length !== 2 + Number(fixedBytes) * 2) {
      throw argError(field, `must be exactly ${fixedBytes} bytes`);
    }
    return value;
  }

  throw argError(field, `uses unsupported ABI type ${parameter.type}`);
}

function coerceTuple(
  parameter: AbiParameter,
  value: unknown,
  field: string
): unknown {
  const components =
    'components' in parameter ? (parameter.components ?? []) : [];
  if (Array.isArray(value)) {
    if (value.length !== components.length) {
      throw argError(field, `must contain exactly ${components.length} fields`);
    }
    return components.map((component, index) =>
      coerceAbiValue(
        component,
        value[index],
        `${field}.${component.name || `arg${index}`}`
      )
    );
  }
  if (typeof value !== 'object' || value === null) {
    throw argError(field, 'must be a tuple object or array');
  }

  const record = value as Record<string, unknown>;
  const allUnnamed = components.every((component) => !component.name);
  const result: Record<string, unknown> = {};
  const positional: unknown[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const key = component.name || `arg${index}`;
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw argError(`${field}.${key}`, 'is required');
    }
    const coerced = coerceAbiValue(component, record[key], `${field}.${key}`);
    if (allUnnamed) positional.push(coerced);
    else result[key] = coerced;
  }
  return allUnnamed ? positional : result;
}

function argError(field: string, detail: string): IgniteError {
  return new IgniteError(
    `Constructor argument ${field} ${detail}`,
    ErrorCodes.ARG_TYPE_MISMATCH,
    { field }
  );
}
