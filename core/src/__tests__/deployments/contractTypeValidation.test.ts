import { describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import type { DeploymentPlan, FrozenContractType, FrozenInputs } from '@ignite/api';
import { contractTypeStaticItems, estimateWrapperItems, validateWrapsIntegrity } from '../../deployments/contractTypeValidation.js';

const owner = '0x0000000000000000000000000000000000000001';
const fn = (name: string, inputs: unknown[] = [], stateMutability = 'nonpayable') => ({ type: 'function', name, inputs, outputs: [], stateMutability });

function fixture(overrides: { wrapper?: Record<string, unknown>; type?: Partial<FrozenContractType['descriptor']>; abi?: unknown[]; runtimeBytecode?: `0x${string}`; wrapperSource?: Record<string, unknown> } = {}) {
  const wrapper = {
    id: 'proxy', kind: 'deploy' as const, contractId: 'proxy',
    wraps: { stepId: 'implementation', contractTypePluginId: 'transparent' },
    args: { implementation: { $ref: { kind: 'step' as const, stepId: 'implementation' } }, initialOwner: owner, _data: '0x' },
    ...overrides.wrapper,
  } as any;
  const plan: DeploymentPlan = {
    schemaVersion: 1, chains: [1], signers: {},
    contracts: [
      { id: 'implementation', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'impl', contractName: 'Implementation', sourcePath: 'Implementation.sol' },
      { id: 'proxy', origin: 'contract-type', contractName: 'TransparentUpgradeableProxy', pluginId: 'transparent', artifactKey: 'proxy', versionLabel: 'v1', contentHash: 'a'.repeat(64), ...overrides.wrapperSource },
    ] as any,
    steps: [{ id: 'implementation', kind: 'deploy', contractId: 'implementation' }, wrapper],
  };
  const descriptor = {
    label: 'Transparent', description: 'test', versionLabel: 'v1',
    params: [{ key: 'initialOwner', label: 'Initial owner', type: 'address', required: true }], artifacts: ['proxy'],
    synthesis: { artifact: 'proxy', constructorArgs: [
      { name: 'implementation', from: 'implementation' as const },
      { name: 'initialOwner', from: 'param' as const, param: 'initialOwner' },
      { name: '_data', from: 'initializer' as const },
    ] }, validation: {}, capture: [], ...overrides.type,
  } as FrozenContractType['descriptor'];
  const type: FrozenContractType = { pluginId: 'transparent', versionLabel: 'v1', contentHash: 'b'.repeat(64), descriptor, artifacts: { proxy: { abi: [], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput: { language: 'Solidity', sources: { 'Proxy.sol': { content: 'contract Proxy {}' } }, settings: {} }, sourceIdentifier: 'Proxy.sol:Proxy' } } };
  const frozen: FrozenInputs = {
    implementation: { abi: overrides.abi ?? [], creationBytecode: '0x6000', runtimeBytecode: overrides.runtimeBytecode ?? '0x6001', compiler: { pluginId: 'f', version: '1', settingsHash: 'c'.repeat(64) }, artifactHash: 'd'.repeat(64), repoDirty: false },
    proxy: { abi: [], creationBytecode: '0x6000', compiler: { pluginId: 'f', version: '1', settingsHash: 'c'.repeat(64) }, artifactHash: 'e'.repeat(64), repoDirty: false },
  } as any;
  return { plan, frozen, contractTypes: { transparent: type } };
}

describe('contract type validation', () => {
  it('accepts linked transparent and UUPS wrapper shapes', () => {
    const transparent = fixture();
    expect(() => validateWrapsIntegrity(transparent.plan, transparent.frozen, transparent.contractTypes, 1)).not.toThrow();
    const uups = fixture({ type: { params: [], synthesis: { artifact: 'proxy', constructorArgs: [{ name: 'implementation', from: 'implementation' }, { name: '_data', from: 'initializer' }] } }, wrapper: { wraps: { stepId: 'implementation', contractTypePluginId: 'transparent' }, args: { implementation: { $ref: { kind: 'step', stepId: 'implementation' } }, _data: { $encode: { contractId: 'implementation', fn: 'initialize()' } } } } });
    expect(() => validateWrapsIntegrity(uups.plan, uups.frozen, uups.contractTypes, 1)).not.toThrow();
  });

  it.each([
    ['wrong artifact', undefined, { artifactKey: 'admin' }, /artifact/],
    ['implementation not a ref', { args: { implementation: owner, initialOwner: owner, _data: '0x' } }, undefined, /implementation argument/],
    ['implementation ref points elsewhere', { args: { implementation: { $ref: { kind: 'step', stepId: 'other' } }, initialOwner: owner, _data: '0x' } }, undefined, /implementation argument/],
    ['encode targets another contract', { args: { implementation: { $ref: { kind: 'step', stepId: 'implementation' } }, initialOwner: owner, _data: { $encode: { contractId: 'proxy', fn: 'initialize()' } } } }, undefined, /contractId/],
    ['missing required parameter', { args: { implementation: { $ref: { kind: 'step', stepId: 'implementation' } }, _data: '0x' } }, undefined, /initialOwner is missing/],
    ['invalid initializer form', { args: { implementation: { $ref: { kind: 'step', stepId: 'implementation' } }, initialOwner: owner, _data: '0x1234' } }, undefined, /initializer argument/],
  ])('rejects %s', (_label, wrapper, wrapperSource, message) => {
    const value = fixture({ wrapper: wrapper as any, wrapperSource: wrapperSource as any });
    expect(() => validateWrapsIntegrity(value.plan, value.frozen, value.contractTypes, 1)).toThrow(message);
  });

  it('rejects wraps.contractTypePluginId even when that frozen type exists', () => {
    const value = fixture({ wrapper: { wraps: { stepId: 'implementation', contractTypePluginId: 'other' } } });
    (value.contractTypes as Record<string, FrozenContractType>).other = { ...value.contractTypes.transparent, pluginId: 'other' };
    expect(() => validateWrapsIntegrity(value.plan, value.frozen, value.contractTypes, 1)).toThrow(/wraps\.contractTypePluginId/);
  });

  it('reports plugin-declared ABI and runtime requirements and unavailable runtime', () => {
    const required = 'upgradeToAndCall(address,bytes)';
    const missing = fixture({ type: { validation: { requiredFunctions: [required] } } });
    expect(contractTypeStaticItems(missing.plan, missing.frozen, missing.contractTypes, 1)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_REQUIREMENTS', blocking: true, details: expect.objectContaining({ 'plugin-declared': true }) })]));
    const selectorMissing = fixture({ type: { validation: { requiredFunctions: [required] } }, abi: [fn('upgradeToAndCall', [{ name: 'to', type: 'address' }, { name: 'data', type: 'bytes' }])] });
    expect(contractTypeStaticItems(selectorMissing.plan, selectorMissing.frozen, selectorMissing.contractTypes, 1)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_REQUIREMENTS', message: expect.stringContaining('runtime bytecode') })]));
    const runtime = `0x6000${toFunctionSelector(required as never).slice(2)}` as `0x${string}`;
    const available = fixture({ type: { validation: { requiredFunctions: [required] } }, abi: [fn('upgradeToAndCall', [{ name: 'to', type: 'address' }, { name: 'data', type: 'bytes' }])], runtimeBytecode: runtime });
    expect(contractTypeStaticItems(available.plan, available.frozen, available.contractTypes, 1).filter((item) => item.code === 'CONTRACT_TYPE_REQUIREMENTS')).toEqual([]);
    delete (available.frozen.implementation as any).runtimeBytecode;
    expect(contractTypeStaticItems(available.plan, available.frozen, available.contractTypes, 1)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_RUNTIME_UNAVAILABLE', blocking: false })]));
  });

  it('emits declared, empty-initializer, deterministic, and value-rule items', () => {
    const uups = fn('upgradeToAndCall', [{ name: 'to', type: 'address' }, { name: 'data', type: 'bytes' }]);
    const initialize = fn('initialize', [], 'nonpayable');
    const base = fixture({ type: { validation: { warnings: [{ when: 'impl-has-function', fn: 'upgradeToAndCall(address,bytes)', message: 'dual path' }] } }, abi: [uups, initialize] });
    let items = contractTypeStaticItems(base.plan, base.frozen, base.contractTypes, 1);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_DECLARED_WARNING', details: expect.objectContaining({ 'plugin-declared': true }) }), expect.objectContaining({ code: 'EMPTY_PROXY_INITIALIZER' }), expect.objectContaining({ code: 'UNINITIALIZED_PROXY_ACK_REQUIRED', blocking: true })]));
    (base.plan.steps[1] as any).strategy = { kind: 'create2', salt: `0x${'11'.repeat(32)}` };
    items = contractTypeStaticItems(base.plan, base.frozen, base.contractTypes, 1);
    expect(items.find((item) => item.code === 'UNINITIALIZED_PROXY_ACK_REQUIRED')?.message).toContain('front-run');
    (base.plan.steps[1] as any).strategy = { kind: 'create' };
    (base.plan.steps[1] as any).acknowledgeUninitialized = true;
    expect(contractTypeStaticItems(base.plan, base.frozen, base.contractTypes, 1).some((item) => item.code === 'UNINITIALIZED_PROXY_ACK_REQUIRED')).toBe(false);
    (base.plan.steps[1] as any).args._data = { $encode: { contractId: 'implementation', fn: 'initialize()' } };
    (base.plan.steps[1] as any).strategy = { kind: 'create2', salt: `0x${'12'.repeat(32)}` };
    expect(contractTypeStaticItems(base.plan, base.frozen, base.contractTypes, 1)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DETERMINISTIC_INITIALIZER_SENDER' })]));
    (base.plan.steps[1] as any).value = '1';
    expect(contractTypeStaticItems(base.plan, base.frozen, base.contractTypes, 1)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_VALUE_NOT_PAYABLE', blocking: true })]));
    (base.frozen.implementation as any).abi = [fn('initialize', [], 'payable')];
    expect(contractTypeStaticItems(base.plan, base.frozen, base.contractTypes, 1).some((item) => item.code === 'CONTRACT_TYPE_VALUE_NOT_PAYABLE')).toBe(false);
  });

  it('requires third-party bytecode provenance acknowledgement but exempts builtin plugins', () => {
    const thirdParty = fixture();
    let items = contractTypeStaticItems(thirdParty.plan, thirdParty.frozen, thirdParty.contractTypes, 1, { transparent: 'installed' });
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_PROVENANCE_ACK_REQUIRED', blocking: true })]));
    (thirdParty.plan.steps[1] as any).acknowledgeUnverifiedBytecode = true;
    items = contractTypeStaticItems(thirdParty.plan, thirdParty.frozen, thirdParty.contractTypes, 1, { transparent: 'installed' });
    expect(items.some((item) => item.code === 'CONTRACT_TYPE_PROVENANCE_ACK_REQUIRED')).toBe(false);
    const builtin = fixture();
    expect(contractTypeStaticItems(builtin.plan, builtin.frozen, builtin.contractTypes, 1, { transparent: 'builtin' }).some((item) => item.code === 'CONTRACT_TYPE_PROVENANCE_ACK_REQUIRED')).toBe(false);
  });

  it('applies the value rule per chain and only notes estimate-tier plain-create wrappers', () => {
    const value = fixture({ wrapper: { valuePerChain: { '1': '0', '2': '1' }, argsPerChain: { '2': { implementation: { $ref: { kind: 'step', stepId: 'implementation' } }, initialOwner: owner, _data: '0x' } } } });
    expect(contractTypeStaticItems(value.plan, value.frozen, value.contractTypes, 1).some((item) => item.code === 'CONTRACT_TYPE_VALUE_NOT_PAYABLE')).toBe(false);
    expect(contractTypeStaticItems(value.plan, value.frozen, value.contractTypes, 2)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRACT_TYPE_VALUE_NOT_PAYABLE' })]));
    expect(estimateWrapperItems(value.plan, 1, 'estimate')).toEqual([expect.objectContaining({ code: 'INITIALIZER_NOT_SIMULATED' })]);
    expect(estimateWrapperItems(value.plan, 1, 'fork')).toEqual([]);
    (value.plan.steps[0] as any).strategy = { kind: 'create2', salt: `0x${'13'.repeat(32)}` };
    expect(estimateWrapperItems(value.plan, 1, 'estimate')).toEqual([]);
  });
});
