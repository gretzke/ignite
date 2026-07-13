import { describe, expect, it } from 'vitest';
import type { AbiParameter } from 'viem';
import type { DeploymentPlan, DeployStep } from '@ignite/api';
import {
  argKeysForAbi,
  effectiveValue,
  mergeArgs,
  mergeGas,
  missingArgKeys,
  resolveSigner,
  resolveStepValues,
  toConstructorArgs,
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
    expect(resolveStepValues(step, 1, () => address, [{ name: 'owner', type: 'address' }])).toMatchObject({ args: { owner: address }, pointers: { owner: address } });
    try { resolveStepValues(step, 1, () => address, [{ name: 'owner', type: 'uint256' }]); throw new Error('expected failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'ARG_TYPE_MISMATCH' }); }
  });

  it('rejects mutual create2 prediction cycles', () => {
    const plan: DeploymentPlan = { schemaVersion: 1, contracts: [], chains: [1], signers: {}, steps: [
      { id: 'a', kind: 'deploy', contractId: 'a', strategy: { kind: 'create2', salt: `0x${'01'.repeat(32)}` }, args: { owner: { $ref: { kind: 'step', stepId: 'b' } } } },
      { id: 'b', kind: 'deploy', contractId: 'b', strategy: { kind: 'create2', salt: `0x${'02'.repeat(32)}` }, args: { owner: { $ref: { kind: 'step', stepId: 'a' } } } },
    ] };
    try { validateDependencies(plan); throw new Error('expected failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'CREATE2_PREDICTION_CYCLE' }); }
  });
});
