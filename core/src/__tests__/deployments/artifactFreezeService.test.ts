import { describe, expect, it, vi } from 'vitest';
import type { ContractSource } from '@ignite/api';
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
