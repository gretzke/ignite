import { describe, expect, it, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { ContractTypeService, contractTypeContentHash } from '../../deployments/ContractTypeService.js';

const config: PluginConfig = { origin: 'installed', repoRead: false, metadata: { id: 'proxy', types: [PluginType.CONTRACT_TYPE], name: 'Proxy', version: '1', baseImage: 'ignite/proxy', operations: ['describeContractType', 'getContractArtifact'] } };
const standardJsonInput = { language: 'Solidity', sources: { 'Proxy.sol': { content: 'contract Proxy {}' } }, settings: { optimizer: { enabled: true, runs: 200 } } };
const artifact = (inputs: Array<{ name: string; type: string }> = [{ name: 'implementation', type: 'address' }, { name: '_data', type: 'bytes' }]) => ({ abi: [{ type: 'constructor', inputs }], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput, sourceIdentifier: 'Proxy.sol:Proxy' });
const descriptor = (overrides: Record<string, unknown> = {}) => ({
  label: 'Proxy', description: 'Test proxy', versionLabel: 'Test 1', params: [], artifacts: ['proxy'],
  synthesis: { artifact: 'proxy', constructorArgs: [{ name: 'implementation', from: 'implementation' }, { name: '_data', from: 'initializer' }] },
  validation: {}, capture: [], ...overrides,
});

function service(raw: unknown = descriptor(), artifactRaw: unknown = artifact(), granted = true) {
  const execute = vi.fn(async (_id: string, operation: string) => ({ success: true as const, data: operation === 'describeContractType' ? raw : artifactRaw }));
  return { execute, service: new ContractTypeService({ getProviders: async () => [config], execute, getGrant: async () => ({ contractBytecode: granted }) }) };
}

describe('ContractTypeService', () => {
  it('strictly parses a descriptor and artifact', async () => {
    const { service: subject } = service();
    await expect(subject.list()).resolves.toMatchObject([{ pluginId: 'proxy', label: 'Proxy' }]);
    await expect(subject.frozenDescriptor('proxy')).resolves.toMatchObject({ pluginId: 'proxy', artifacts: { proxy: { creationBytecode: '0x6000' } } });
  });

  it.each([
    ['unknown synthesis artifact', descriptor({ synthesis: { artifact: 'missing', constructorArgs: [] } }), artifact()],
    ['non-bytes initializer', descriptor(), artifact([{ name: 'implementation', type: 'address' }, { name: '_data', type: 'address' }])],
    ['capture artifact reference', descriptor({ capture: [{ slot: `0x${'11'.repeat(32)}`, expectCodeOf: 'missing' }] }), artifact()],
    ['oversized capture list', descriptor({ capture: Array.from({ length: 9 }, () => ({ slot: `0x${'11'.repeat(32)}` })) }), artifact()],
    ['bad parameter shape', descriptor({ params: [{ key: 'owner', label: 'Owner', type: 'wat' }] }), artifact()],
    ['assertCalls target has no recorded capture', descriptor({ params: [{ key: 'owner', label: 'Owner', type: 'address' }], capture: [{ slot: `0x${'11'.repeat(32)}`, assertCalls: [{ call: 'owner()', on: 'proxy', expectParam: 'owner' }] }] }), artifact()],
    ['forward assertCalls reference', descriptor({ params: [{ key: 'owner', label: 'Owner', type: 'address' }], capture: [{ slot: `0x${'11'.repeat(32)}`, assertCalls: [{ call: 'owner()', on: 'admin', expectParam: 'owner' }] }, { slot: `0x${'22'.repeat(32)}`, record: 'admin' }] }), artifact()],
    ['verifyAs has no recorded capture', descriptor({ capture: [{ slot: `0x${'11'.repeat(32)}`, verifyAs: 'proxy' }] }), artifact()],
    ['verify constructor arg count differs', descriptor({ capture: [{ slot: `0x${'11'.repeat(32)}`, record: 'proxy', verifyAs: 'proxy', constructorArgs: [] }] }), artifact()],
    ['hostile ABI leaf type', descriptor(), artifact([{ name: 'implementation', type: 'uint7' }, { name: '_data', type: 'bytes' }])],
  ])('rejects %s', async (_label, raw, artifactRaw) => {
    const { service: subject } = service(raw, artifactRaw);
    await expect(subject.frozenDescriptor('proxy')).rejects.toMatchObject({ code: 'CONTRACT_TYPE_OP_FAILED' });
  });

  it('rejects malformed artifact hex and standard-json bundles', async () => {
    const badHex = { ...artifact(), creationBytecode: '0x0' };
    await expect(service(descriptor(), badHex).service.getArtifact('proxy', 'proxy')).rejects.toMatchObject({ code: 'CONTRACT_TYPE_OP_FAILED' });
    const badBundle = { ...artifact(), standardJsonInput: { language: 'Solidity', sources: { '/Proxy.sol': { content: 'x' } }, settings: {} } };
    await expect(service(descriptor(), badBundle).service.getArtifact('proxy', 'proxy')).rejects.toMatchObject({ code: 'CONTRACT_TYPE_OP_FAILED' });
  });

  it('hashes frozen content canonically regardless of object key order', () => {
    const one = { pluginId: 'proxy', versionLabel: 'Test 1', descriptor: descriptor(), artifacts: { proxy: artifact() } } as any;
    const two = { artifacts: { proxy: artifact() }, descriptor: descriptor(), versionLabel: 'Test 1', pluginId: 'proxy' } as any;
    expect(contractTypeContentHash(one)).toBe(contractTypeContentHash(two));
  });

  it('fails closed before any contract artifact plugin execute', async () => {
    const { service: subject, execute } = service(descriptor(), artifact(), false);
    await expect(subject.getArtifact('proxy', 'proxy')).rejects.toMatchObject({ code: 'CONTRACT_BYTECODE_NOT_GRANTED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a non-zero-argument assertCall target ABI', async () => {
    const raw = descriptor({ params: [{ key: 'owner', label: 'Owner', type: 'address' }], capture: [{ slot: `0x${'11'.repeat(32)}`, record: 'proxy', assertCalls: [{ call: 'owner(address)', on: 'proxy', expectParam: 'owner' }] }] });
    const withOwner = { ...artifact(), abi: [...artifact().abi, { type: 'function', name: 'owner', inputs: [{ name: 'who', type: 'address' }], outputs: [{ name: '', type: 'address' }] }] };
    await expect(service(raw, withOwner).service.frozenDescriptor('proxy')).rejects.toMatchObject({ code: 'CONTRACT_TYPE_OP_FAILED' });
  });

  it('keeps valid providers listed when another provider returns malformed describe data', async () => {
    const bad = { ...config, metadata: { ...config.metadata, id: 'broken' } };
    const execute = vi.fn(async (id: string, operation: string) => ({ success: true as const, data: operation === 'describeContractType' ? id === 'broken' ? { nope: true } : descriptor() : artifact() }));
    const subject = new ContractTypeService({ getProviders: async () => [config, bad], execute, getGrant: async () => ({ contractBytecode: true }) });
    await expect(subject.list()).resolves.toMatchObject([{ pluginId: 'proxy' }]);
    await expect(subject.frozenDescriptor('broken')).rejects.toMatchObject({ code: 'CONTRACT_TYPE_OP_FAILED' });
  });
});
