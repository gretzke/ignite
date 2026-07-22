import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileRepoRegistry } from '../../filesystem/ProfileRepoRegistry.js';
import type { RepoRecord } from '@ignite/api';
import { RepoKind } from '../../repos/RepoService.js';
import { KeyedMutex } from '../../utils/KeyedMutex.js';

function makeDeps(files: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(files));
  return {
    fileSystem: {
      getProfileReposPath: (id: string) => `/profiles/${id}/repos`,
      fileExists: async (p: string) => store.has(p),
      readJsonFile: async <T>(p: string) => store.get(p) as T,
      writeJsonFile: async (p: string, v: unknown) => {
        store.set(p, v);
      },
    },
    isGitRepository: vi.fn(() => true),
    removeClone: vi.fn(async () => {}),
    sessionPath: () => '/ws/session',
    _store: store,
  };
}

describe('ProfileRepoRegistry', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('lists session, local and cloned repos, defaulting to empty', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await expect(registry.list('p1')).resolves.toEqual({
      session: '/ws/session',
      local: [],
      cloned: [],
    });
  });

  it('save rejects relative local paths', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await expect(registry.save('p1', './relative')).rejects.toThrow(
      /must be absolute/
    );
  });

  it('save rejects non-git local paths', async () => {
    deps.isGitRepository.mockReturnValue(false);
    const registry = new ProfileRepoRegistry(deps);
    await expect(registry.save('p1', '/not/a/repo')).rejects.toThrow(
      /must be a git repository/
    );
  });

  it('save appends and rejects duplicates', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await registry.save('p1', 'https://github.com/a/b');
    await expect(registry.save('p1', 'https://github.com/a/b')).rejects.toThrow(
      /already exists/
    );
    expect(
      deps._store.get(`/profiles/p1/repos/${RepoKind.CLONED}.json`)
    ).toEqual([{ pathOrUrl: 'https://github.com/a/b' }]);
  });

  it('save propagates a corrupt registry file read error without overwriting', async () => {
    const key = `/profiles/p1/repos/${RepoKind.CLONED}.json`;
    const corrupt = 'not json';
    deps._store.set(key, corrupt);
    deps.fileSystem.readJsonFile = async () => {
      throw new Error(`Invalid JSON in file: ${key}`);
    };
    const registry = new ProfileRepoRegistry(deps);
    await expect(registry.save('p1', 'https://github.com/c/d')).rejects.toThrow(
      /Invalid JSON/
    );
    // The corrupt file must not have been overwritten.
    expect(deps._store.get(key)).toBe(corrupt);
  });

  it('remove filters the entry and removes the clone', async () => {
    deps._store.set(`/profiles/p1/repos/${RepoKind.CLONED}.json`, [
      { pathOrUrl: 'https://github.com/a/b' },
      { pathOrUrl: 'https://github.com/c/d' },
    ]);
    const registry = new ProfileRepoRegistry(deps);
    await registry.remove('p1', 'https://github.com/a/b');
    expect(
      deps._store.get(`/profiles/p1/repos/${RepoKind.CLONED}.json`)
    ).toEqual([{ pathOrUrl: 'https://github.com/c/d' }]);
    // profileId is threaded through so the ADDRESSED profile's clone is
    // deleted, not the currently-active profile's.
    expect(deps.removeClone).toHaveBeenCalledWith(
      'https://github.com/a/b',
      'p1'
    );
  });

  it('releases the profile mutex before deleting a clone', async () => {
    deps._store.set(`/profiles/p1/repos/${RepoKind.CLONED}.json`, [
      { pathOrUrl: 'https://github.com/a/b' },
    ]);
    const registry = new ProfileRepoRegistry(deps);
    deps.removeClone.mockImplementation(async () => {
      // This takes the same process-wide profile mutex. If remove held it
      // while acquiring the clone's repo lock, this await would deadlock.
      await registry.updateRepoState('p1', 'https://github.com/a/b', {
        detectedAt: 'after-removal',
      });
    });

    await expect(registry.remove('p1', 'https://github.com/a/b')).resolves.toBeUndefined();
  });

  it('lets a repo-locked lifecycle persist while concurrent removal waits for clone cleanup', async () => {
    const pathOrUrl = 'https://github.com/a/b';
    deps._store.set(`/profiles/p1/repos/${RepoKind.CLONED}.json`, [{ pathOrUrl }]);
    const repoMutex = new KeyedMutex();
    const order: string[] = [];
    let releaseCompile!: () => void;
    const compileMayPersist = new Promise<void>((resolve) => { releaseCompile = resolve; });
    let compileHasRepoLock!: () => void;
    const compileHoldingRepoLock = new Promise<void>((resolve) => { compileHasRepoLock = resolve; });
    let cloneStarted!: () => void;
    const cloneWaitingForRepoLock = new Promise<void>((resolve) => { cloneStarted = resolve; });
    deps.removeClone.mockImplementation(async () => {
      order.push('clone-waiting-for-repo');
      cloneStarted();
      await repoMutex.run('repo', async () => {
        order.push('clone-deleted');
      });
    });
    const registry = new ProfileRepoRegistry(deps);

    const compile = repoMutex.run('repo', async () => {
      order.push('compile-has-repo');
      compileHasRepoLock();
      await compileMayPersist;
      await registry.updateRepoState('p1', pathOrUrl, { detectedAt: 'compile-persisted' });
      order.push('compile-persisted');
    });
    await compileHoldingRepoLock;
    const removal = registry.remove('p1', pathOrUrl);
    await cloneWaitingForRepoLock;
    releaseCompile();

    await Promise.all([compile, removal]);
    expect(order).toEqual([
      'compile-has-repo',
      'clone-waiting-for-repo',
      'compile-persisted',
      'clone-deleted',
    ]);
  });

  it('remove does not call removeClone for a LOCAL repo', async () => {
    deps._store.set(`/profiles/p1/repos/${RepoKind.LOCAL}.json`, [
      { pathOrUrl: '/abs/path/repo' },
    ]);
    const registry = new ProfileRepoRegistry(deps);
    await registry.remove('p1', '/abs/path/repo');
    expect(
      deps._store.get(`/profiles/p1/repos/${RepoKind.LOCAL}.json`)
    ).toEqual([]);
    expect(deps.removeClone).not.toHaveBeenCalled();
  });

  it('remove throws when the registry file is missing', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await expect(registry.remove('p1', '/x')).rejects.toThrow(/not found/);
  });

  it('save writes a RepoRecord and updateRepoState merges onto it', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await registry.save('p1', '/abs/path/repo');
    await registry.updateRepoState('p1', '/abs/path/repo', {
      frameworks: [{ id: 'foundry', name: 'Foundry', artifactGeneration: 3 }],
      detectedAt: '2026-07-06T00:00:00.000Z',
      detectedWith: [{ pluginId: 'foundry', version: '1.2.3' }],
      originUrl: 'file:///abs/path/repo',
    });
    const { local } = await registry.list('p1');
    expect(local[0].frameworks?.[0].id).toBe('foundry');
    expect(local[0].frameworks?.[0].artifactGeneration).toBe(3);
    expect(local[0].detectedAt).toBe('2026-07-06T00:00:00.000Z');
    expect(local[0].detectedWith).toEqual([
      { pluginId: 'foundry', version: '1.2.3' },
    ]);
    expect(local[0].originUrl).toBe('file:///abs/path/repo');
  });

  it('persists and clears a live repository failure with a null lastError patch', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await registry.save('p1', '/abs/path/repo');
    const lastError = { code: 'COMPILE_FAILED', message: 'compiler failed', at: '2026-07-22T00:00:00.000Z' };

    await registry.updateRepoState('p1', '/abs/path/repo', { lastError });
    expect((await registry.list('p1')).local[0].lastError).toEqual(lastError);

    await registry.updateRepoState('p1', '/abs/path/repo', { lastError: null });
    expect((await registry.list('p1')).local[0].lastError).toBeUndefined();
  });

  it('serializes same-profile state writes across registry instances', async () => {
    const firstRegistry = new ProfileRepoRegistry(deps);
    const secondRegistry = new ProfileRepoRegistry(deps);
    await firstRegistry.save('p1', '/abs/path/repo');
    let releaseFirst!: () => void;
    const originalRead = deps.fileSystem.readJsonFile;
    let reads = 0;
    deps.fileSystem.readJsonFile = async <T>(p: string) => {
      reads += 1;
      const snapshot = await originalRead<T>(p);
      if (reads === 1)
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      return snapshot;
    };
    const first = firstRegistry.updateRepoState('p1', '/abs/path/repo', {
      frameworks: [{ id: 'foundry', name: 'Foundry' }],
    });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    const second = secondRegistry.updateRepoState('p1', '/abs/path/repo', {
      originUrl: 'file:///abs/path/repo',
    });
    releaseFirst();
    await Promise.all([first, second]);

    const { local } = await firstRegistry.list('p1');
    expect(local[0]).toMatchObject({
      frameworks: [{ id: 'foundry', name: 'Foundry' }],
      originUrl: 'file:///abs/path/repo',
    });
  });

  it('updateRepoState is a no-op for an unregistered repo', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await expect(
      registry.updateRepoState('p1', '/not/registered', {
        detectedAt: 'x',
      } as Pick<RepoRecord, 'detectedAt'>)
    ).resolves.toBeUndefined();
  });

  it('remove keeps other records intact', async () => {
    deps._store.set(`/profiles/p1/repos/${RepoKind.CLONED}.json`, [
      { pathOrUrl: 'https://github.com/a/b' },
      { pathOrUrl: 'https://github.com/c/d', detectedAt: 'x' },
    ]);
    const registry = new ProfileRepoRegistry(deps);
    await registry.remove('p1', 'https://github.com/a/b');
    const { cloned } = await registry.list('p1');
    expect(cloned).toEqual([
      { pathOrUrl: 'https://github.com/c/d', detectedAt: 'x' },
    ]);
  });
});
