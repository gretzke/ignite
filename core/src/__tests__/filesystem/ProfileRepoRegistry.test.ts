import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileRepoRegistry } from '../../filesystem/ProfileRepoRegistry.js';
import { RepoContainerKind } from '../../plugins/utils/RepoContainerUtils.js';

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
    removeRepoContainers: vi.fn(async () => {}),
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
    await expect(
      registry.save('p1', 'https://github.com/a/b')
    ).rejects.toThrow(/already exists/);
    expect(
      deps._store.get(`/profiles/p1/repos/${RepoContainerKind.CLONED}.json`)
    ).toEqual(['https://github.com/a/b']);
  });

  it('save propagates a corrupt registry file read error without overwriting', async () => {
    const key = `/profiles/p1/repos/${RepoContainerKind.CLONED}.json`;
    const corrupt = 'not json';
    deps._store.set(key, corrupt);
    deps.fileSystem.readJsonFile = async () => {
      throw new Error(`Invalid JSON in file: ${key}`);
    };
    const registry = new ProfileRepoRegistry(deps);
    await expect(
      registry.save('p1', 'https://github.com/c/d')
    ).rejects.toThrow(/Invalid JSON/);
    // The corrupt file must not have been overwritten.
    expect(deps._store.get(key)).toBe(corrupt);
  });

  it('remove filters the entry and removes containers', async () => {
    deps._store.set(`/profiles/p1/repos/${RepoContainerKind.CLONED}.json`, [
      'https://github.com/a/b',
      'https://github.com/c/d',
    ]);
    const registry = new ProfileRepoRegistry(deps);
    await registry.remove('p1', 'https://github.com/a/b');
    expect(
      deps._store.get(`/profiles/p1/repos/${RepoContainerKind.CLONED}.json`)
    ).toEqual(['https://github.com/c/d']);
    expect(deps.removeRepoContainers).toHaveBeenCalledWith(
      RepoContainerKind.CLONED,
      'https://github.com/a/b'
    );
  });

  it('remove throws when the registry file is missing', async () => {
    const registry = new ProfileRepoRegistry(deps);
    await expect(registry.remove('p1', '/x')).rejects.toThrow(/not found/);
  });
});
