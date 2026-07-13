import { encodeDeployData, encodeFunctionData, getContractAddress, type Abi, type AbiParameter } from 'viem';
import { CREATE2_PROXY_ADDRESS, type DeploymentPlan, type DeployStep, type FrozenInputs, type Hex, type Hex32 } from '@ignite/api';
import { effectiveSalt, initcodeHashOf, predictCreate2Address, create2Calldata } from './create2.js';
import { callAbiItem, effectiveValue, mergeCallTarget, resolveSigner, resolveStepValues, toConstructorArgs, validateDependencies } from './resolver.js';
import { linkBytecode } from './linking.js';

export interface ScheduleEntry { stepId: string; kind: 'tx' | 'existing'; from?: Hex; to?: Hex | null; data?: Hex; value?: bigint; address?: Hex; predictedAddress?: Hex; }
export type Predictions = Record<string, { predictedAddress: Hex; initcodeHash: Hex32; salt: Hex32 }>;

function constructorInputs(abi: unknown): AbiParameter[] {
  return Array.isArray(abi) ? ((abi.find((entry) => entry && typeof entry === 'object' && (entry as { type?: string }).type === 'constructor') as { inputs?: AbiParameter[] } | undefined)?.inputs ?? []) : [];
}
function linkedCode(step: DeployStep, input: FrozenInputs[string], libraries: Record<string, Hex> | undefined): Hex {
  return input.creationCodeLinkReferences ? linkBytecode(input.creationBytecode, input.creationCodeLinkReferences, libraries ?? {}) : input.creationBytecode as Hex;
}
export function buildInitcode(step: DeployStep, input: FrozenInputs[string], chainId: number, resolveRef: (stepId: string) => Hex): Hex {
  const ctor = constructorInputs(input.abi);
  const values = resolveStepValues(step, chainId, resolveRef, ctor);
  return encodeDeployData({ abi: input.abi as Abi, bytecode: linkedCode(step, input, values.libraries), args: toConstructorArgs(ctor, values.args) });
}

export function predictPlanAddresses(plan: DeploymentPlan, frozen: FrozenInputs, chainId: number): Predictions {
  validateDependencies(plan);
  const predicted: Predictions = {};
  const remaining = plan.steps.filter((step): step is DeployStep => step.kind === 'deploy' && (step.strategy?.kind === 'create2' || step.strategy?.kind === 'plugin'));
  while (remaining.length) {
    let firstRealError: unknown;
    const next = remaining.find((step) => {
      try {
        buildInitcode(step, frozen[step.contractId]!, chainId, (id) => predicted[id]?.predictedAddress ?? (() => { throw new Error('unresolved'); })());
        return true;
      } catch (error) {
        // A pointer at a not-yet-predicted create2 step means "try later";
        // anything else (missing library binding, arg mismatch) is real.
        if ((error as { code?: string }).code !== 'POINTER_UNRESOLVED') firstRealError ??= error;
        return false;
      }
    });
    if (!next && firstRealError) throw firstRealError;
    if (!next) throw new Error('Unable to resolve create2 predictions after dependency validation');
    const strategy = next.strategy!;
    const salt = effectiveSalt(strategy as Extract<typeof strategy, { kind: 'create2' | 'plugin' }>, chainId);
    if (!salt) throw new Error(`No salt is available for ${next.id}`);
    const code = buildInitcode(next, frozen[next.contractId]!, chainId, (id) => predicted[id]!.predictedAddress);
    const hash = initcodeHashOf(code);
    predicted[next.id] = { salt, initcodeHash: hash, predictedAddress: predictCreate2Address(salt, hash) };
    remaining.splice(remaining.indexOf(next), 1);
  }
  return predicted;
}

export function ackIsFresh(strategy: Exclude<NonNullable<DeployStep['strategy']>, { kind: 'create' }>, chainId: number, current: { predictedAddress: Hex; initcodeHash: Hex32 }): boolean {
  const ack = strategy.acknowledgeDeployed?.[String(chainId)];
  return Boolean(ack && ack.predictedAddress.toLowerCase() === current.predictedAddress.toLowerCase() && ack.initcodeHash.toLowerCase() === current.initcodeHash.toLowerCase());
}

export function computeCreateAddresses(plan: DeploymentPlan, _frozen: FrozenInputs, chainId: number, signers: Map<string, Hex>, baseNonces: Map<Hex, number>, skipTx: Set<string> = new Set()): Map<string, Hex> {
  const next = new Map([...baseNonces.entries()].map(([address, nonce]) => [address.toLowerCase() as Hex, nonce]));
  const addresses = new Map<string, Hex>();
  for (const step of plan.steps) {
    // Acknowledged-existing steps broadcast nothing and consume no nonce.
    if (skipTx.has(step.id)) continue;
    const from = signers.get(step.id) ?? resolveSigner(plan, step, chainId)?.address as Hex | undefined;
    if (!from) continue;
    const key = from.toLowerCase() as Hex; const nonce = next.get(key) ?? 0;
    // Every scheduled tx advances the signer's nonce — calls and create2
    // proxy txs included; only plain creates yield a nonce-derived address.
    if (step.kind === 'deploy' && (!step.strategy?.kind || step.strategy.kind === 'create')) {
      addresses.set(step.id, getContractAddress({ from, nonce: BigInt(nonce) }));
    }
    next.set(key, nonce + 1);
  }
  return addresses;
}

export function buildSchedule(plan: DeploymentPlan, frozen: FrozenInputs, chainId: number, opts: { signers: Map<string, Hex>; createAddresses?: Map<string, Hex>; confirmedExisting?: Set<string> }): ScheduleEntry[] {
  const predictions = predictPlanAddresses(plan, frozen, chainId);
  const creates = opts.createAddresses ?? new Map<string, Hex>();
  const addresses = (id: string) => predictions[id]?.predictedAddress ?? creates.get(id) ?? (() => { throw new Error(`No resolved address for ${id}`); })();
  return plan.steps.map((step) => {
    const from = opts.signers.get(step.id);
    if (step.kind === 'call') {
      const target = mergeCallTarget(step, chainId);
      const targetStep = target.kind === 'step' ? plan.steps.find((item): item is DeployStep => item.id === target.stepId && item.kind === 'deploy') : undefined;
      const fn = callAbiItem(step, chainId, targetStep ? frozen[targetStep.contractId]?.abi : undefined);
      const values = resolveStepValues(step, chainId, addresses, fn?.inputs ?? []);
      const data = fn ? encodeFunctionData({ abi: [fn], functionName: fn.name, args: toConstructorArgs(fn.inputs, values.args) }) : '0x';
      return { stepId: step.id, kind: 'tx', from, to: values.target!, data, value: effectiveValue(step, chainId) };
    }
    const strategy = step.strategy ?? { kind: 'create' as const };
    const data = buildInitcode(step, frozen[step.contractId]!, chainId, addresses);
    // 'existing' requires OBSERVED code, not just a fresh acknowledgment —
    // the caller (simulation) verifies via eth_getCode; execution deploys
    // when code is absent, so the schedule must include that tx (F7). When
    // no confirmation set is provided, fall back to acknowledgment freshness
    // (pure callers that cannot read the chain).
    const existing = opts.confirmedExisting
      ? opts.confirmedExisting.has(step.id)
      : strategy.kind !== 'create' && ackIsFresh(strategy, chainId, predictions[step.id]!);
    if (strategy.kind !== 'create' && existing) return { stepId: step.id, kind: 'existing', address: predictions[step.id]!.predictedAddress, predictedAddress: predictions[step.id]!.predictedAddress };
    return strategy.kind === 'create'
      ? { stepId: step.id, kind: 'tx', from, to: null, data, value: effectiveValue(step, chainId), address: creates.get(step.id) }
      : { stepId: step.id, kind: 'tx', from, to: CREATE2_PROXY_ADDRESS, data: create2Calldata(predictions[step.id]!.salt, data), value: effectiveValue(step, chainId), predictedAddress: predictions[step.id]!.predictedAddress };
  });
}
