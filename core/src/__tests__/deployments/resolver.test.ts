import { describe, expect, it } from 'vitest';
import { encodeFunctionData, type AbiParameter } from 'viem';
import type { CallStep, DeploymentPlan, DeployStep } from '@ignite/api';
import {
  argKeysForAbi,
  callAbiItem,
  effectiveValue,
  mergeArgs,
  mergeGas,
  missingArgKeys,
  resolveSigner,
  resolveStepValues,
  toConstructorArgs,
  dynamicDeterministicStepIds,
  validateDependencies,
} from '../../deployments/resolver.js';

const address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const alternateAddress = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;

function deployStep(overrides: Partial<DeployStep> = {}): DeployStep {
  return { id: 'deploy', kind: 'deploy', contractId: 'token', ...overrides };
}

describe('deployment resolver', () => {
  it('uses positional keys for unnamed ABI inputs', () => {
    const inputs = [{}, { name: '' }, { name: 'owner' }];
    expect(argKeysForAbi(inputs)).toEqual(['arg0', 'arg1', 'owner']);
    expect(missingArgKeys(inputs, { arg0: 'a', owner: address })).toEqual(['arg1']);
  });

  it('merges argument fields without deep-merging tuples or arrays', () => {
    const step = deployStep({ args: { config: { owner: address, cap: '1' }, name: 'Token' }, argsPerChain: { '1': { config: { owner: alternateAddress } } } });
    expect(mergeArgs(step, 1)).toEqual({ config: { owner: alternateAddress }, name: 'Token' });
    expect(mergeArgs(step, 2)).toEqual(step.args);
  });

  it('merges gas overrides field by field and resolves values as bigint', () => {
    const step = deployStep({ value: '2', valuePerChain: { '1': '3' }, gasOverrides: { gasLimit: '100', maxFeePerGas: '10' }, gasOverridesPerChain: { '1': { maxPriorityFeePerGas: '1' } } });
    expect(mergeGas(step, 1)).toEqual({ gasLimit: '100', maxFeePerGas: '10', maxPriorityFeePerGas: '1' });
    expect(effectiveValue(step, 1)).toBe(3n);
    expect(effectiveValue(step, 2)).toBe(2n);
    expect(effectiveValue(deployStep(), 1)).toBe(0n);
  });

  it('resolves a per-chain signer without a global default and honors step exceptions', () => {
    const chainSigner = { pluginId: 'wallet', accountId: 'one', address };
    const stepDefault = { pluginId: 'wallet', accountId: 'two', address };
    const exception = { pluginId: 'wallet', accountId: 'three', address: alternateAddress };
    const plan: DeploymentPlan = { schemaVersion: 1, contracts: [], steps: [], chains: [1, 2], signers: { perChain: { '1': chainSigner } } };
    const step = deployStep({ signerOverride: { global: stepDefault, perChain: { '1': exception } } });
    expect(resolveSigner(plan, deployStep(), 1)).toEqual(chainSigner);
    expect(resolveSigner(plan, deployStep(), 2)).toBeUndefined();
    expect(resolveSigner(plan, step, 1)).toEqual(exception);
    expect(resolveSigner(plan, step, 2)).toEqual(stepDefault);
  });

  it('orders and ABI-coerces constructor arguments recursively', () => {
    const inputs: AbiParameter[] = [
      { name: 'supply', type: 'uint256' }, { name: 'owner', type: 'address' },
      { name: 'config', type: 'tuple', components: [{ name: 'recipient', type: 'address' }, { name: 'amounts', type: 'uint256[]' }] },
      { name: 'pairs', type: 'tuple[]', components: [{ name: 'who', type: 'address' }, { name: 'amount', type: 'uint128' }] },
    ];
    expect(toConstructorArgs(inputs, { supply: '42', owner: address, config: { recipient: alternateAddress, amounts: ['1', '2'] }, pairs: [{ who: address, amount: '3' }] })).toEqual([42n, address, { recipient: alternateAddress, amounts: [1n, 2n] }, [{ who: address, amount: 3n }]]);
    expect(() => toConstructorArgs(inputs, { supply: 'not-a-number', owner: 'not-an-address', config: { recipient: alternateAddress, amounts: 'not-an-array' }, pairs: [] })).toThrow(/supply/);
  });

  it('resolves only address-typed pointer leaves', () => {
    const step = { id: 'a', kind: 'deploy' as const, contractId: 'a', args: { owner: { $ref: { kind: 'step' as const, stepId: 'b' } } } };
    expect(resolveStepValues(step, 1, () => address, [{ name: 'owner', type: 'address' }])).toMatchObject({ args: { owner: address }, pointers: { 'args.owner': address } });
    try { resolveStepValues(step, 1, () => address, [{ name: 'owner', type: 'uint256' }]); throw new Error('expected failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'ARG_TYPE_MISMATCH' }); }
  });

  it('encodes frozen initializer calls and records nested pointer provenance', () => {
    const fn = { type: 'function' as const, name: 'initialize', stateMutability: 'nonpayable' as const, inputs: [{ name: 'owner', type: 'address' as const }, { name: 'supply', type: 'uint256' as const }], outputs: [] };
    const step = deployStep({ args: { data: { $encode: { contractId: 'impl', fn: 'initialize(address,uint256)', args: { owner: { $ref: { kind: 'step', stepId: 'owner' } }, supply: '7' } } } } });
    const values = resolveStepValues(step, 1, () => address, [{ name: 'data', type: 'bytes' }], { contracts: [{ id: 'impl', repoPathOrUrl: '/r', frameworkId: 'f', artifactPath: 'a', contractName: 'Impl', sourcePath: 'I.sol' }], frozen: { impl: { abi: [fn], creationBytecode: '0x00', compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) }, artifactHash: 'a'.repeat(64), repoDirty: false } } });
    expect(values.args.data).toBe(encodeFunctionData({ abi: [fn], functionName: 'initialize', args: [address, 7n] }));
    expect(values.pointers).toEqual({ 'args.data.$encode.owner': address });
  });

  it('allows an omitted payable declaration for a nonpayable frozen ABI call', () => {
    const item = { type: 'function' as const, name: 'poke', stateMutability: 'nonpayable' as const, inputs: [], outputs: [] };
    const step: CallStep = { id: 'poke', kind: 'call', target: { kind: 'step', stepId: 'target' }, signature: 'poke()' };
    expect(callAbiItem(step, 1, [item])).toBe(item);
  });

  it('rejects a payable declaration for a nonpayable frozen ABI call', () => {
    const item = { type: 'function' as const, name: 'poke', stateMutability: 'nonpayable' as const, inputs: [], outputs: [] };
    const step: CallStep = { id: 'poke', kind: 'call', target: { kind: 'step', stepId: 'target' }, signature: 'poke()', payable: true };
    expect(() => callAbiItem(step, 1, [item])).toThrowError(expect.objectContaining({ code: 'PAYABILITY_MISMATCH' }));
  });

  it('rejects an omitted payable declaration for a payable frozen ABI call', () => {
    const item = { type: 'function' as const, name: 'fund', stateMutability: 'payable' as const, inputs: [], outputs: [] };
    const step: CallStep = { id: 'fund', kind: 'call', target: { kind: 'step', stepId: 'target' }, signature: 'fund()' };
    expect(() => callAbiItem(step, 1, [item])).toThrowError(expect.objectContaining({ code: 'PAYABILITY_MISMATCH' }));
  });

  it('allows a payable declaration for a payable frozen ABI call', () => {
    const item = { type: 'function' as const, name: 'fund', stateMutability: 'payable' as const, inputs: [], outputs: [] };
    const step: CallStep = { id: 'fund', kind: 'call', target: { kind: 'step', stepId: 'target' }, signature: 'fund()', payable: true };
    expect(callAbiItem(step, 1, [item])).toBe(item);
  });

  it('replaces a per-chain $encode wrapper wholesale and rejects invalid encode markers', () => {
    const fn = { type: 'function' as const, name: 'initialize', stateMutability: 'nonpayable' as const, inputs: [], outputs: [] };
    const context = { contracts: [{ id: 'impl', repoPathOrUrl: '/r', frameworkId: 'f', artifactPath: 'a', contractName: 'Impl', sourcePath: 'I.sol' }], frozen: { impl: { abi: [fn], creationBytecode: '0x00', compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) }, artifactHash: 'a'.repeat(64), repoDirty: false } } };
    const step = deployStep({ args: { data: { $encode: { contractId: 'impl', fn: 'initialize()' } } }, argsPerChain: { '1': { data: '0x' } } });
    expect(resolveStepValues(step, 1, () => address, [{ name: 'data', type: 'bytes' }], context).args.data).toBe('0x');
    expect(() => resolveStepValues(deployStep({ args: { data: { $encode: { contractId: 'impl' } } } }), 1, () => address, [{ name: 'data', type: 'bytes' }], context)).toThrow(/malformed/);
    expect(() => resolveStepValues(deployStep({ args: { amount: { $encode: { contractId: 'impl', fn: 'initialize()' } } } }), 1, () => address, [{ name: 'amount', type: 'uint256' }], context)).toThrow(/only valid for bytes/);
    expect(() => resolveStepValues(deployStep({ args: { data: { $encode: { contractId: 'impl', fn: 'missing()' } } } }), 1, () => address, [{ name: 'data', type: 'bytes' }], context)).toThrow(/not in the frozen ABI/);
    expect(() => resolveStepValues(deployStep({ args: { data: { $encode: { contractId: 'impl', fn: 'initialize()', args: { nested: { $encode: { contractId: 'impl', fn: 'initialize()' } } } } } } }), 1, () => address, [{ name: 'data', type: 'bytes' }], context)).toThrow(/Nested/);
  });

  it('rejects mutual create2 prediction cycles', () => {
    const plan: DeploymentPlan = { schemaVersion: 1, contracts: [], chains: [1], signers: {}, steps: [
      { id: 'a', kind: 'deploy', contractId: 'a', strategy: { kind: 'create2', salt: `0x${'01'.repeat(32)}` }, args: { owner: { $ref: { kind: 'step', stepId: 'b' } } } },
      { id: 'b', kind: 'deploy', contractId: 'b', strategy: { kind: 'create2', salt: `0x${'02'.repeat(32)}` }, args: { owner: { $ref: { kind: 'step', stepId: 'a' } } } },
    ] };
    try { validateDependencies(plan); throw new Error('expected failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'CREATE2_PREDICTION_CYCLE' }); }
  });

  it('classifies dynamic deterministic steps transitively per chain and ignores calls', () => {
    const plan: DeploymentPlan = { schemaVersion: 1, contracts: [], chains: [1, 2], signers: {}, steps: [
      { id: 'plain', kind: 'deploy', contractId: 'a' },
      { id: 'first', kind: 'deploy', contractId: 'b', strategy: { kind: 'create2', salt: `0x${'01'.repeat(32)}` }, argsPerChain: { '1': { owner: { $ref: { kind: 'step', stepId: 'plain' } } } } },
      { id: 'second', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt: `0x${'02'.repeat(32)}` }, args: { owner: { $ref: { kind: 'step', stepId: 'first' } } } },
      { id: 'call', kind: 'call', target: { kind: 'address', address }, signature: 'poke()', payable: false },
    ] };
    expect(dynamicDeterministicStepIds(plan, 1)).toEqual(new Set(['first', 'second']));
    expect(dynamicDeterministicStepIds(plan, 2)).toEqual(new Set());
  });
});

describe('call-arg and per-chain dependency validation', () => {
  const contract = { id: 'c', repoPathOrUrl: '/r', frameworkId: 'f', artifactPath: 'a', contractName: 'C', sourcePath: 'C.sol' };
  const base = { schemaVersion: 1 as const, contracts: [contract], chains: [1, 2], signers: {} };

  it('rejects call args referencing a later plain-create step', () => {
    const plan = {
      ...base,
      steps: [
        { id: 'ping', kind: 'call' as const, target: { kind: 'address' as const, address: `0x${'11'.repeat(20)}` as `0x${string}` }, signature: 'poke(address)', payable: false, args: { who: { $ref: { kind: 'step', stepId: 'late' } } } },
        { id: 'late', kind: 'deploy' as const, contractId: 'c' },
      ],
    };
    expect(() => validateDependencies(plan)).toThrowError(/references later create step/);
  });

  it('orders $encode-nested refs exactly like ordinary refs', () => {
    const encode = { $encode: { contractId: 'c', fn: 'initialize(address)', args: { owner: { $ref: { kind: 'step' as const, stepId: 'late' } } } } };
    expect(() => validateDependencies({ ...base, steps: [
      { id: 'wrapper', kind: 'deploy' as const, contractId: 'c', args: { data: encode } },
      { id: 'late', kind: 'deploy' as const, contractId: 'c' },
    ] })).toThrow(/later create step/);
    const dynamic = { ...base, steps: [
      { id: 'impl', kind: 'deploy' as const, contractId: 'c' },
      { id: 'wrapper', kind: 'deploy' as const, contractId: 'c', strategy: { kind: 'create2' as const, salt: `0x${'77'.repeat(32)}` as `0x${string}` }, args: {
        data: { $encode: { contractId: 'c', fn: 'initialize(address)', args: { owner: { $ref: { kind: 'step' as const, stepId: 'impl' } } } } },
      } },
    ] };
    expect(dynamicDeterministicStepIds(dynamic, 1)).toEqual(new Set(['wrapper']));
  });

  it('catches refs that only exist in a non-first chain override', () => {
    const plan = {
      ...base,
      steps: [
        { id: 'a', kind: 'deploy' as const, contractId: 'c', strategy: { kind: 'create2' as const, salt: `0x${'22'.repeat(32)}` as `0x${string}` }, argsPerChain: { '2': { owner: { $ref: { kind: 'step', stepId: 'b' } } } } },
        { id: 'b', kind: 'deploy' as const, contractId: 'c' },
      ],
    };
    expect(() => validateDependencies(plan)).toThrowError(/non-concrete create step/);
  });

  it('allows earlier creates, rejects forward dynamic refs, and preserves static forward commitments', () => {
    const salt = `0x${'55'.repeat(32)}` as const;
    expect(() => validateDependencies({ ...base, steps: [
      { id: 'plain', kind: 'deploy', contractId: 'c' },
      { id: 'dynamic', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt }, args: { owner: { $ref: { kind: 'step', stepId: 'plain' } } } },
    ] })).not.toThrow();
    expect(() => validateDependencies({ ...base, steps: [
      { id: 'plain', kind: 'deploy', contractId: 'c' },
      { id: 'early', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt }, args: { owner: { $ref: { kind: 'step', stepId: 'late' } } } },
      { id: 'late', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt }, args: { owner: { $ref: { kind: 'step', stepId: 'plain' } } } },
    ] })).toThrow(/later dynamic step/);
    expect(() => validateDependencies({ ...base, steps: [
      { id: 'early', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt }, args: { owner: { $ref: { kind: 'step', stepId: 'late' } } } },
      { id: 'late', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt } },
    ] })).not.toThrow();
  });

  it('rejects a plain-create or call that points forward to a dynamic deterministic deployment', () => {
    const salt = `0x${'56'.repeat(32)}` as const;
    const laterHook = { id: 'hook', kind: 'deploy' as const, contractId: 'c', strategy: { kind: 'create2' as const, salt }, args: { owner: { $ref: { kind: 'step' as const, stepId: 'seed' } } } };
    expect(() => validateDependencies({ ...base, steps: [
      { id: 'seed', kind: 'deploy' as const, contractId: 'c' },
      { id: 'consumer', kind: 'deploy' as const, contractId: 'c', args: { owner: { $ref: { kind: 'step' as const, stepId: 'hook' } } } },
      laterHook,
    ] })).toThrowError(/Create step references later dynamic step/);
    expect(() => validateDependencies({ ...base, steps: [
      { id: 'seed', kind: 'deploy' as const, contractId: 'c' },
      { id: 'consumer', kind: 'call' as const, target: { kind: 'address' as const, address }, signature: 'poke(address)', payable: false, args: { owner: { $ref: { kind: 'step' as const, stepId: 'hook' } } } },
      laterHook,
    ] })).toThrowError(/Call argument args.owner references later dynamic step/);
  });
});
