import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactListingCache, artifactListingCacheKey } from '../../repos/ArtifactListingCache.js';
import { finalizeCompile } from '../../repos/finalizeCompile.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-finalize-'));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, 'src'));
  await fs.mkdir(path.join(dir, 'artifacts'));
  await fs.writeFile(path.join(dir, 'src', 'A.sol'), 'contract A {}');
  return dir;
}

describe('finalizeCompile', () => {
  it('persists a new generation and fingerprint before warming its cache', async () => {
    const dir = await workspace();
    const cache = new ArtifactListingCache();
    const persisted: unknown[] = [];
    const executor = { execute: vi.fn(async () => ({ success: true as const, data: { artifacts: [{ contractName: 'A', sourcePath: 'src/A.sol', artifactPath: 'artifacts/A.json' }] } })) };
    const framework = await finalizeCompile({
      workspacePath: dir, pathOrUrl: '/repo', framework: { id: 'hardhat', name: 'Hardhat', watchPaths: { config: [], sources: ['src'], artifacts: ['artifacts'] } },
      identity: '/repo', profileId: 'p1', pluginId: 'hardhat', pluginVersion: '1.0.0',
      sourceFingerprint: 'pre-compile-source-fingerprint', executor, artifactCache: cache,
      persist: async (value) => { persisted.push(value); },
    });
    expect(framework).toMatchObject({ artifactGeneration: 1, fingerprint: { sources: 'pre-compile-source-fingerprint' } });
    expect(persisted).toEqual([framework]);
    expect(cache.get(artifactListingCacheKey({ profileId: 'p1', canonicalIdentity: '/repo', frameworkId: 'hardhat', pluginId: 'hardhat', pluginVersion: '1.0.0', generation: 1 }))).toHaveLength(1);
  });

  it('logs a list failure without failing a successful compile finalization', async () => {
    const dir = await workspace();
    const log = vi.fn();
    await expect(finalizeCompile({
      workspacePath: dir, pathOrUrl: '/repo', framework: { id: 'stub', name: 'Stub' },
      identity: '/repo', pluginId: 'stub', pluginVersion: '1.0.0',
      executor: { execute: vi.fn(async () => ({ success: false as const, error: { code: 'LIST_FAILED', message: 'list failed' } })) },
      artifactCache: new ArtifactListingCache(), persist: async () => {}, log,
    })).resolves.toMatchObject({ artifactGeneration: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('artifact cache warm failed'));
  });
});
