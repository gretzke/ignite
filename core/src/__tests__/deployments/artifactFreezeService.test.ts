import { describe, expect, it, vi } from 'vitest';
import { RunRecordSchema, type ContractSource, type FrozenContractType } from '@ignite/api';
import { ArtifactFreezeService, canonicalJson, sha256 } from '../../deployments/ArtifactFreezeService.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ getLogger: () => logger }));

const contract: ContractSource = { id: 'token', repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: 'out/Token.json', contractName: 'Token', sourcePath: 'src/Token.sol' };
const base = { solidityVersion: '0.8.0', optimizer: false, optimizerRuns: 0, viaIR: false, bytecodeHash: 'ipfs', abi: [], creationCode: '0x6000', deployedBytecode: '0x6001' };

async function freeze(artifact: Record<string, unknown>) {
  return new ArtifactFreezeService({
    getArtifactData: async () => artifact as never,
    getPluginConfig: async () => ({ metadata: { version: '1.0.0' } }) as never,
    repoDirty: async () => false,
  }).freezeInputs('p', [contract]);
}

describe('ArtifactFreezeService runtime bytecode', () => {
  it('freezes contract-type artifacts, rejects descriptor drift, and preserves repoDirty false', async () => {
    const source: ContractSource = { id: 'proxy', origin: 'contract-type', pluginId: 'ct', artifactKey: 'proxy', versionLabel: 'v1', contentHash: 'b'.repeat(64), contractName: 'Proxy' };
    const descriptor: FrozenContractType = { pluginId: 'ct', versionLabel: 'v1', contentHash: 'b'.repeat(64), descriptor: { label: 'CT', description: 'd', versionLabel: 'v1', params: [], artifacts: ['proxy'], synthesis: null, validation: {}, capture: [] }, artifacts: { proxy: { abi: [], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput: { language: 'Solidity', sources: { 'P.sol': { content: 'contract P {}' } }, settings: {} }, sourceIdentifier: 'P.sol:P' } } };
    const service = new ArtifactFreezeService({ contractTypes: { frozenDescriptor: async () => descriptor }, getPluginConfig: async () => ({ origin: 'builtin', metadata: { version: 'x' } }) as never });
    const frozen = await service.freezeInputs('p', [source]);
    expect(frozen.proxy).toMatchObject({ creationBytecode: '0x6000', runtimeBytecode: '0x6001', repoDirty: false, compiler: { pluginId: 'ct', version: '0.8.29' } });
    await expect(new ArtifactFreezeService({ contractTypes: { frozenDescriptor: async () => ({ ...descriptor, contentHash: 'c'.repeat(64) }) } }).freezeInputs('p', [source])).rejects.toMatchObject({ code: 'CONTRACT_TYPE_DRIFT', details: { expected: 'b'.repeat(64), actual: 'c'.repeat(64) } });
    const item = { ok: true, blocking: false, message: 'ok' };
    expect(RunRecordSchema.safeParse({ schemaVersion: 1, id: 'r', profileId: 'p', name: 'n', idempotencyKey: 'k', createdAt: 'now', updatedAt: 'now', plan: { schemaVersion: 1, contracts: [source], steps: [{ id: 's', kind: 'deploy', contractId: 'proxy' }], chains: [1], signers: { global: { pluginId: 'p', accountId: 'a', address: `0x${'11'.repeat(20)}` } } }, inputs: frozen, contractTypes: { ct: descriptor }, rpcSelection: { '1': { endpointId: 'rpc', label: 'rpc', urlFingerprint: 'a'.repeat(64) } }, validation: { chains: { '1': { rpc: item, signers: item, args: item, estimation: item, balance: item, inputs: item } } }, lanes: { '1': { chainId: 1, status: 'completed', currentStepIndex: 1, steps: [{ stepId: 's', status: 'confirmed', attempts: [] }] } }, status: 'completed' }).success).toBe(true);
  });
  it('marks installed contract-type verification bundles as unverified provenance', async () => {
    const source: ContractSource = { id: 'proxy', origin: 'contract-type', pluginId: 'ct', artifactKey: 'proxy', versionLabel: 'v1', contentHash: 'b'.repeat(64), contractName: 'Proxy' };
    const descriptor: FrozenContractType = { pluginId: 'ct', versionLabel: 'v1', contentHash: 'b'.repeat(64), descriptor: { label: 'CT', description: 'd', versionLabel: 'v1', params: [], artifacts: ['proxy'], synthesis: null, validation: {}, capture: [] }, artifacts: { proxy: { abi: [], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput: { language: 'Solidity', sources: { 'P.sol': { content: 'contract P {}' } }, settings: {} }, sourceIdentifier: 'P.sol:P' } } };
    const write = vi.fn(async () => 'd'.repeat(64));
    const service = new ArtifactFreezeService({ contractTypes: { frozenDescriptor: async () => descriptor }, getPluginConfig: async () => ({ origin: 'installed', metadata: { version: 'x' } }) as never, bundleStore: { write } });
    const types = await service.freezeContractTypes([source]);
    expect(types.ct).toMatchObject({ unverifiedProvenance: true });
    const frozen = await service.freezeInputs('p', [source], types);
    await service.captureBundles(frozen, [source], 'p', types);
    expect(write).toHaveBeenCalledWith('p', expect.objectContaining({ unverifiedProvenance: true, solcVersion: '0.8.29', contractIdentifier: 'P.sol:P' }));
  });
  it('uses the caller supplied contract-type snapshot without fetching a second descriptor', async () => {
    const source: ContractSource = { id: 'proxy', origin: 'contract-type', pluginId: 'ct', artifactKey: 'proxy', versionLabel: 'v1', contentHash: 'b'.repeat(64), contractName: 'Proxy' };
    const first: FrozenContractType = { pluginId: 'ct', versionLabel: 'v1', contentHash: 'b'.repeat(64), descriptor: { label: 'CT', description: 'd', versionLabel: 'v1', params: [], artifacts: ['proxy'], synthesis: null, validation: {}, capture: [] }, artifacts: { proxy: { abi: [], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput: { language: 'Solidity', sources: { 'P.sol': { content: 'contract P {}' } }, settings: {} }, sourceIdentifier: 'P.sol:P' } } };
    const second: FrozenContractType = { ...first, artifacts: { proxy: { ...first.artifacts.proxy, creationBytecode: '0x6002' as `0x${string}` } } };
    const frozenDescriptor = vi.fn(async () => frozenDescriptor.mock.calls.length === 1 ? first : second);
    const service = new ArtifactFreezeService({ contractTypes: { frozenDescriptor }, getPluginConfig: async () => ({ origin: 'builtin', metadata: { version: 'x' } }) as never });
    const types = await service.freezeContractTypes([source]);
    const inputs = await service.freezeInputs('p', [source], types);
    expect(frozenDescriptor).toHaveBeenCalledOnce();
    expect(inputs.proxy.creationBytecode).toBe('0x6000');
  });
  it('passes the full pinned source to artifact reads and structurally forces repoDirty false', async () => {
    const pinned: ContractSource = { ...contract, repoPathOrUrl: 'https://example.test/repo.git', pin: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) } };
    const getArtifactData = vi.fn(async () => base as never);
    const repoDirty = vi.fn(async () => true);
    const frozen = await new ArtifactFreezeService({
      getArtifactData,
      getPluginConfig: async () => ({ metadata: { version: '1.0.0' } }) as never,
      repoDirty,
    }).freezeInputs('p1', [pinned]);
    expect(getArtifactData).toHaveBeenCalledWith({ contract: pinned, profileId: 'p1' });
    expect(repoDirty).not.toHaveBeenCalled();
    expect(frozen.token.repoDirty).toBe(false);
    expect(frozen.token.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('captures valid runtime code and binds it into the artifact hash', async () => {
    const captured = await freeze(base);
    expect(captured.token).toMatchObject({ runtimeBytecode: '0x6001' });
    expect(captured.token.artifactHash).toBe(sha256(canonicalJson({ abi: [], creationCode: '0x6000', runtimeCode: '0x6001' })));
    const legacy = await freeze({ ...base, deployedBytecode: '0x' });
    expect(legacy.token.artifactHash).toBe(sha256(canonicalJson({ abi: [], creationCode: '0x6000' })));
    expect(captured.token.artifactHash).not.toBe(legacy.token.artifactHash);
    expect((await freeze({ ...base, deployedBytecode: '0x6002' })).token.artifactHash).not.toBe(captured.token.artifactHash);
  });

  it('captures runtime link references and binds their map into the artifact hash', async () => {
    const bytecode = `0x${'zz'.repeat(20)}00`;
    const left = await freeze({ ...base, deployedBytecode: bytecode, deployedBytecodeLinkReferences: { 'src/L.sol': { L: [{ start: 0, length: 20 }] } } });
    const right = await freeze({ ...base, deployedBytecode: bytecode, deployedBytecodeLinkReferences: { 'src/Other.sol': { L: [{ start: 0, length: 20 }] } } });
    expect(left.token.runtimeBytecodeLinkReferences).toBeDefined();
    expect(left.token.artifactHash).not.toBe(right.token.artifactHash);
  });

  it('omits invalid runtime code without failing the freeze', async () => {
    const frozen = await freeze({ ...base, deployedBytecode: '0x0' });
    expect(frozen.token.runtimeBytecode).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Runtime bytecode omitted for token (out/Token.json)'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid runtime bytecode'));
  });

  it('omits runtime code over the 1 MiB byte ceiling', async () => {
    const frozen = await freeze({ ...base, deployedBytecode: `0x${'00'.repeat(1024 * 1024 + 1)}` });
    expect(frozen.token.runtimeBytecode).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds 1 MiB'));
  });
});
