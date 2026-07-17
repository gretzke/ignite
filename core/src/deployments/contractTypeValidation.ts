import { toFunctionSelector, toFunctionSignature, type AbiFunction } from 'viem';
import type { ContractSource, DeploymentPlan, FrozenContractType, FrozenInputs, Hex, ValidationItem } from '@ignite/api';
import { isEncodedCallValue, isValueRef } from '@ignite/api';
import { IgniteError } from '../types/errors.js';
import { effectiveValue, mergeArgs } from './resolver.js';

/** Frozen relationship checks shared by review validation and lane edits. */
export function validateWrapsIntegrity(plan: DeploymentPlan, frozen: FrozenInputs, contractTypes: Record<string, FrozenContractType> | undefined, chainId: number): void {
  for (const wrapper of plan.steps) {
    if (wrapper.kind !== 'deploy' || !wrapper.wraps) continue;
    const source = contractFor(plan.contracts, wrapper.contractId);
    const type = contractTypes?.[wrapper.wraps.contractTypePluginId];
    if (!source || source.origin !== 'contract-type' || !type)
      throw bad(wrapper.id, 'wrapper source or frozen contract type is missing');
    if (source.pluginId !== wrapper.wraps.contractTypePluginId)
      throw bad(wrapper.id, 'wraps.contractTypePluginId does not match the wrapper source');
    const synthesis = type.descriptor.synthesis;
    if (!synthesis || source.artifactKey !== synthesis.artifact)
      throw bad(wrapper.id, 'wrapper source artifact does not match frozen synthesis');
    const impl = plan.steps.find((step) => step.id === wrapper.wraps!.stepId);
    if (!impl || impl.kind !== 'deploy') throw bad(wrapper.id, 'wrapped implementation step is missing');
    const args = mergeArgs(wrapper, chainId);
    const implementation = synthesis.constructorArgs.find((arg) => arg.from === 'implementation');
    const implementationValue = implementation ? args[implementation.name] : undefined;
    if (!implementation || !isValueRef(implementationValue) || implementationValue.$ref.stepId !== impl.id)
      throw bad(wrapper.id, 'synthesis implementation argument must reference wraps.stepId');
    const initializer = synthesis.constructorArgs.find((arg) => arg.from === 'initializer');
    if (initializer) {
      const value = args[initializer.name];
      if (value !== '0x' && !isEncodedCallValue(value)) throw bad(wrapper.id, 'synthesis initializer argument must be literal 0x or $encode');
      if (isEncodedCallValue(value) && value.$encode.contractId !== impl.contractId)
        throw bad(wrapper.id, '$encode.contractId must match the wrapped implementation contract');
    }
    for (const arg of synthesis.constructorArgs.filter((arg): arg is Extract<typeof arg, { from: 'param' }> => arg.from === 'param')) {
      if (type.descriptor.params.find((param) => param.key === arg.param)?.required && !Object.prototype.hasOwnProperty.call(args, arg.name))
        throw bad(wrapper.id, `required contract-type parameter ${arg.param} is missing`);
    }
    // Ensure the frozen ABI still agrees with the descriptor, even when this
    // function is called independently from service normalization.
    if (!frozen[wrapper.contractId]) throw bad(wrapper.id, 'wrapper frozen input is missing');
  }
}

export function contractTypeStaticItems(plan: DeploymentPlan, frozen: FrozenInputs, contractTypes: Record<string, FrozenContractType> | undefined, chainId: number): ValidationItem[] {
  const out: ValidationItem[] = [];
  try { validateWrapsIntegrity(plan, frozen, contractTypes, chainId); }
  catch (error) { return [failure('CONTRACT_TYPE_REQUIREMENTS', error instanceof Error ? error.message : 'Contract-type relationship is invalid')]; }
  for (const wrapper of plan.steps) {
    if (wrapper.kind !== 'deploy' || !wrapper.wraps) continue;
    const type = contractTypes?.[wrapper.wraps.contractTypePluginId]!;
    const impl = plan.steps.find((step) => step.id === wrapper.wraps!.stepId) as Extract<typeof wrapper, { kind: 'deploy' }>;
    const input = frozen[impl.contractId];
    const abi = Array.isArray(input?.abi) ? input.abi : [];
    for (const signature of type.descriptor.validation.requiredFunctions ?? []) {
      const found = abi.some((entry): entry is AbiFunction => Boolean(entry && typeof entry === 'object' && (entry as { type?: string }).type === 'function') && safeSignature(entry as AbiFunction) === signature);
      if (!found) out.push(failure('CONTRACT_TYPE_REQUIREMENTS', `Implementation is missing plugin-required function ${signature}`, { 'plugin-declared': true, pluginId: type.pluginId, signature }));
      const runtime = input?.runtimeBytecode;
      if (!runtime || input.runtimeBytecodeLinkReferences) {
        out.push(note('CONTRACT_TYPE_RUNTIME_UNAVAILABLE', `Static selector check for ${signature} skipped because runtime bytecode is unavailable or linked`, { 'plugin-declared': true, pluginId: type.pluginId, signature }));
      } else if (!runtime.toLowerCase().includes(toFunctionSelector(signature as never).slice(2).toLowerCase())) {
        out.push(failure('CONTRACT_TYPE_REQUIREMENTS', `Implementation runtime bytecode is missing selector for ${signature}`, { 'plugin-declared': true, pluginId: type.pluginId, signature }));
      }
    }
    for (const declared of type.descriptor.validation.warnings ?? []) {
      const found = abi.some((entry): entry is AbiFunction => Boolean(entry && typeof entry === 'object' && (entry as { type?: string }).type === 'function') && safeSignature(entry as AbiFunction) === declared.fn);
      if (found) out.push(note('CONTRACT_TYPE_DECLARED_WARNING', declared.message, { 'plugin-declared': true, pluginId: type.pluginId, signature: declared.fn }));
    }
    const synthesis = type.descriptor.synthesis!;
    const initializer = synthesis.constructorArgs.find((arg) => arg.from === 'initializer');
    const value = initializer ? mergeArgs(wrapper, chainId)[initializer.name] : undefined;
    const empty = value === '0x';
    if (empty) {
      out.push(note('EMPTY_PROXY_INITIALIZER', 'Empty proxy initializer calldata selected; unconventional initializer names are undetectable.'));
      const hasInitialize = abi.some((entry) => Boolean(entry && typeof entry === 'object' && (entry as { type?: string; name?: string }).type === 'function' && (entry as { name?: string }).name === 'initialize'));
      if (hasInitialize && wrapper.acknowledgeUninitialized !== true) {
        const deterministic = wrapper.strategy?.kind === 'create2' || wrapper.strategy?.kind === 'plugin';
        out.push(failure('UNINITIALIZED_PROXY_ACK_REQUIRED', `This proxy can be initialized post-deploy by anyone.${deterministic ? ' A deterministic deployment can be front-run: an attacker can deploy the identical proxy first, initialize it, and Ignite will only see a CREATE2 collision.' : ''}`, { stepId: wrapper.id }));
      }
    }
    if (isEncodedCallValue(value) && (wrapper.strategy?.kind === 'create2' || wrapper.strategy?.kind === 'plugin'))
      out.push(note('DETERMINISTIC_INITIALIZER_SENDER', 'During the constructor-time initializer delegatecall, msg.sender is the CREATE2 factory 0x4e59b44847b379578588920cA78FbF26c0B4956C, not the signer.'));
    if (effectiveValue(wrapper, chainId) !== 0n) {
      if (!initializer || !isEncodedCallValue(value)) out.push(failure('CONTRACT_TYPE_VALUE_NOT_PAYABLE', 'A nonzero wrapper value requires a nonempty payable initializer.'));
      else {
        const implAbi = Array.isArray(input?.abi) ? input.abi : [];
        const fn = implAbi.find((entry): entry is AbiFunction => Boolean(entry && typeof entry === 'object' && (entry as { type?: string }).type === 'function') && safeSignature(entry as AbiFunction) === value.$encode.fn);
        if (!fn || fn.stateMutability !== 'payable') out.push(failure('CONTRACT_TYPE_VALUE_NOT_PAYABLE', 'A nonzero wrapper value requires a payable initializer.'));
      }
    }
  }
  return out;
}

export function estimateWrapperItems(plan: DeploymentPlan, _chainId: number, tier: 'simulateV1' | 'fork' | 'estimate' | undefined): ValidationItem[] {
  if (tier !== 'estimate') return [];
  return plan.steps.flatMap((step) => {
    if (step.kind !== 'deploy' || !step.wraps) return [];
    const implementation = plan.steps.find((candidate) => candidate.id === step.wraps!.stepId);
    return implementation?.kind === 'deploy' && (!implementation.strategy || implementation.strategy.kind === 'create')
      ? [note('INITIALIZER_NOT_SIMULATED', 'Initializer not simulated on this chain.')]
      : [];
  });
}

function contractFor(contracts: ContractSource[], id: string) { return contracts.find((contract) => contract.id === id); }
function safeSignature(fn: AbiFunction): string | undefined { try { return toFunctionSignature(fn); } catch { return undefined; } }
function bad(stepId: string, message: string) { return new IgniteError(`Wrapper ${stepId}: ${message}`, 'CONTRACT_TYPE_REQUIREMENTS', { stepId }); }
function failure(code: string, message: string, details?: Record<string, unknown>): ValidationItem { return { ok: false, blocking: true, code, message, ...(details ? { details } : {}) }; }
function note(code: string, message: string, details?: Record<string, unknown>): ValidationItem { return { ok: true, blocking: false, code, message, ...(details ? { details } : {}) }; }
