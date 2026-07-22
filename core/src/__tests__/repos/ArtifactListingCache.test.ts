import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ArtifactListingCache,
  artifactListingCacheKey,
} from '../../repos/ArtifactListingCache.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const location = { contractName: 'A', sourcePath: 'src/A.sol', artifactPath: 'artifacts/A.json' };

function key(overrides: Partial<Parameters<typeof artifactListingCacheKey>[0]> = {}): string {
  return artifactListingCacheKey({
    profileId: 'p1', canonicalIdentity: 'repo', frameworkId: 'hardhat',
    pluginId: 'hardhat', pluginVersion: '1.0.0', generation: 1, ...overrides,
  });
}

describe('ArtifactListingCache', () => {
  it('separates every key component', () => {
    const cache = new ArtifactListingCache();
    const variants = [
      key({ profileId: 'p2' }), key({ canonicalIdentity: 'other' }),
      key({ frameworkId: 'foundry' }), key({ pluginId: 'other' }),
      key({ pluginVersion: '2.0.0' }), key({ generation: 2 }),
    ];
    cache.set(key(), [location]);
    for (const variant of variants) expect(cache.get(variant)).toBeUndefined();
  });

  it('returns a hit without loading', async () => {
    const cache = new ArtifactListingCache();
    cache.set(key(), [location]);
    const load = vi.fn(async () => []);
    await expect(cache.getOrLoad({ key: key(), workspacePath: '/missing', artifactPaths: [], load })).resolves.toEqual([location]);
    expect(load).not.toHaveBeenCalled();
  });

  it('caches a stable miss and invalidates every identity entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-artifact-cache-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, 'artifacts'));
    const cache = new ArtifactListingCache();
    const load = vi.fn(async () => [location]);
    await expect(cache.getOrLoad({ key: key(), workspacePath: dir, artifactPaths: ['artifacts'], load })).resolves.toEqual([location]);
    await cache.getOrLoad({ key: key(), workspacePath: dir, artifactPaths: ['artifacts'], load });
    expect(load).toHaveBeenCalledTimes(1);
    cache.set(key({ frameworkId: 'foundry' }), [location]);
    cache.invalidate('repo');
    expect(cache.get(key())).toBeUndefined();
    expect(cache.get(key({ frameworkId: 'foundry' }))).toBeUndefined();
  });

  it('returns but does not cache a listing when artifacts change during load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-artifact-cache-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, 'artifacts'));
    await fs.writeFile(path.join(dir, 'artifacts', 'A.json'), '{}');
    const cache = new ArtifactListingCache();
    const load = vi.fn(async () => {
      await fs.writeFile(path.join(dir, 'artifacts', 'A.json'), '{"changed":true}');
      return [location];
    });
    await expect(cache.getOrLoad({ key: key(), workspacePath: dir, artifactPaths: ['artifacts'], load })).resolves.toEqual([location]);
    expect(cache.get(key())).toBeUndefined();
  });

  it('mints strictly increasing generations', () => {
    const cache = new ArtifactListingCache();
    expect([cache.nextGeneration(), cache.nextGeneration(), cache.nextGeneration()]).toEqual([1, 2, 3]);
  });

  it('clears cached entries and resets generations', () => {
    const cache = new ArtifactListingCache();
    cache.set(key(), [location]);
    cache.nextGeneration();
    cache.clear();
    expect(cache.get(key())).toBeUndefined();
    expect(cache.nextGeneration()).toBe(1);
  });
});
