import { describe, it, expect, vi } from 'vitest';
import type { RepoRecord } from '@ignite/api';
import { createProfileHandlers } from '../../api/profiles.js';
import { RepoLifecycle } from '../../repos/RepoLifecycle.js';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

const profile = {
  id: 'p1',
  name: 'One',
  color: '#fff',
  icon: 'flame',
  created: '2024-01-01T00:00:00.000Z',
  lastUsed: '2024-01-01T00:00:00.000Z',
};

function makeDeps() {
  return {
    getProfileManager: async () => ({
      getCurrentProfile: () => 'p1',
      getCurrentProfileConfig: async () => profile,
      getProfileConfig: async (id: string) => ({ ...profile, id }),
      listProfiles: async () => [profile],
      listArchivedProfiles: async () => [],
      createProfile: async () => profile,
      switchProfile: vi.fn(async () => {}),
      updateProfile: async () => ({ ...profile, name: 'Two' }),
      archiveProfile: vi.fn(async () => {}),
      restoreProfile: vi.fn(async () => {}),
      deleteProfile: vi.fn(async () => {}),
    }),
    repoRegistry: {
      list: async (): Promise<{
        session: string | null;
        local: RepoRecord[];
        cloned: RepoRecord[];
      }> => ({ session: null, local: [], cloned: [] }),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    lifecycle: {
      startLifecycle: vi.fn(() => ({
        id: 'job-add-0',
        type: 'repo.lifecycle',
        params: {},
        state: 'queued' as const,
        createdAt: new Date().toISOString(),
        events: [],
      })),
      activeJobFor: vi.fn(
        (_pathOrUrl: string): string | undefined => undefined
      ),
      ensureProfileSwept: vi.fn(),
      sessionState: vi.fn((): RepoRecord | null => null),
      runPinnedLifecycle: vi.fn(async () => ({ pathOrUrl: '/versions/version', frameworks: [] })),
    },
    versionStore: {
      removeUserMembershipAndDeleteIfUnreferenced: vi.fn(async (_profileId: string, _url: string, _commit: string, remove: () => Promise<void>) => { await remove(); return true; }),
      checkoutPath: vi.fn((url: string, commit: string) => `/versions/${encodeURIComponent(url)}/${commit}`),
      list: vi.fn(async () => []),
      listMemberships: vi.fn(async () => ({})),
      isOriginApproved: vi.fn(async () => true),
      addMembership: vi.fn(async () => {}),
    },
    repos: {
      removeVersionCheckout: vi.fn(async (_url: string, _commit: string, beforeDelete: (remove: () => Promise<void>) => Promise<boolean>) => beforeDelete(async () => {})),
      getVersionSource: vi.fn(async (pathOrUrl: string) => ({ url: `file://${pathOrUrl}`, workspacePath: pathOrUrl, localFallbackPath: pathOrUrl })),
      resolveLocalVersionCommit: vi.fn(async () => ({ commit: 'a'.repeat(40), refKind: 'branch' as 'branch' | 'tag' | 'commit' })),
      ensureVersion: vi.fn(async () => ({ checkout: '/versions/version' })),
    },
    jobs: { start: vi.fn((type: string, params: Record<string, unknown>) => ({ id: 'job-version-0', type, params, state: 'queued' as const, createdAt: new Date().toISOString(), events: [] })) },
    inspectGitRemote: vi.fn(async () => ({ defaultBranch: 'main', branches: ['main'], branchHeads: { main: 'a'.repeat(40) }, tagHeads: {}, releases: [] })),
    hasWorkspace: vi.fn(async () => true),
  };
}

describe('profile handlers', () => {
  it('listProfiles returns currentId and profiles', async () => {
    const handlers = createProfileHandlers(makeDeps());
    const reply = makeReply();
    await handlers.listProfiles({} as never, reply as never);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      data: { currentId: 'p1', profiles: [profile] },
    });
  });

  it('maps thrown errors to the legacy 500 body', async () => {
    const deps = makeDeps();
    deps.getProfileManager = async () => {
      throw new Error('disk gone');
    };
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.listProfiles({} as never, reply as never);
    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'PROFILE_LIST_ERROR',
      message: 'Failed to list profiles',
      details: { error: 'disk gone' },
    });
  });

  it('saveRepo delegates to the registry (now returning the pipeline job)', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.saveRepo(
      { params: { id: 'p1' }, body: { pathOrUrl: '/repo' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.repoRegistry.save).toHaveBeenCalledWith('p1', '/repo');
  });

  it('deleteRepo failure keeps code PROFILE_REPO_DELETE_ERROR', async () => {
    const deps = makeDeps();
    deps.repoRegistry.remove = vi.fn(async () => {
      throw new Error('nope');
    });
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.deleteRepo(
      { params: { id: 'p1' }, query: { pathOrUrl: '/repo' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(500);
    expect((reply.body as { code: string }).code).toBe(
      'PROFILE_REPO_DELETE_ERROR'
    );
  });

  it('listRepos returns enriched entries with initialized, cached frameworks and activeJobId', async () => {
    const deps = makeDeps();
    deps.repoRegistry.list = async () => ({
      session: null,
      local: [
        {
          pathOrUrl: '/repo-a',
          frameworks: [{ id: 'foundry', name: 'Foundry' }],
          detectedAt: '2026-07-06T00:00:00.000Z',
        },
        { pathOrUrl: '/repo-b' },
      ],
      cloned: [],
    });
    deps.hasWorkspace = vi.fn(
      async (pathOrUrl: string) => pathOrUrl === '/repo-a'
    );
    deps.lifecycle.activeJobFor = vi.fn((pathOrUrl: string) =>
      pathOrUrl === '/repo-b' ? 'job-9' : undefined
    );
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.listRepos({ params: { id: 'p1' } } as never, reply as never);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      data: {
        session: null,
        local: [
          {
            pathOrUrl: '/repo-a',
            frameworks: [{ id: 'foundry', name: 'Foundry' }],
            detectedAt: '2026-07-06T00:00:00.000Z',
            initialized: true,
            activeJobId: undefined,
            versions: [],
          },
          {
            pathOrUrl: '/repo-b',
            initialized: false,
            activeJobId: 'job-9',
            versions: [],
          },
        ],
        cloned: [],
        versionGroups: [],
        pinned: [],
      },
    });
    // initialized is computed against the ADDRESSED profile.
    expect(deps.hasWorkspace).toHaveBeenCalledWith('/repo-a', 'p1');
  });

  it('listRepos includes the session workspace entry from lifecycle state', async () => {
    const deps = makeDeps();
    deps.lifecycle.sessionState = vi.fn(() => ({
      pathOrUrl: '/ws/session',
      frameworks: [{ id: 'foundry', name: 'Foundry' }],
    }));
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.listRepos({ params: { id: 'p1' } } as never, reply as never);
    expect(reply.statusCode).toBe(200);
    expect(
      (reply.body as { data: { session: { pathOrUrl: string } } }).data.session
        .pathOrUrl
    ).toBe('/ws/session');
  });

  it('keeps the legacy pinned response field empty', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.listRepos({ params: { id: 'p1' } } as never, reply as never);
    expect((reply.body as { data: { pinned: unknown[] } }).data.pinned).toEqual([]);
  });

  it('adds a remote ref version through a job, then lists it under its matching repository', async () => {
    const deps = makeDeps();
    const url = 'https://example.com/contracts.git'; const commit = 'a'.repeat(40);
    let runner!: (ctx: { log: (line: string) => void; signal: AbortSignal }) => Promise<unknown>;
    deps.jobs = { start: vi.fn((_type: string, _params: Record<string, unknown>, value: typeof runner) => { runner = value; return { id: 'job-version-1', type: 'repo.version.add', params: {}, state: 'queued' as const, createdAt: new Date().toISOString(), events: [] }; }) };
    deps.inspectGitRemote = vi.fn(async () => ({ defaultBranch: 'main', branches: ['main'], branchHeads: { main: commit }, tagHeads: {}, releases: [] }));
    deps.repoRegistry.list = async () => ({ session: null, local: [{ pathOrUrl: '/repo-a' }], cloned: [] });
    deps.repos.getVersionSource = vi.fn(async () => ({ url, workspacePath: '/repo-a', localFallbackPath: '/repo-a' }));
    const memberships: Record<string, Array<{ commit: string; addedAt: string; source: 'user' | 'workflow' }>> = {};
    deps.versionStore.addMembership = vi.fn(async (_profileId: string, membershipUrl: string, membershipCommit: string) => { memberships[membershipUrl] = [{ commit: membershipCommit, addedAt: '2026-07-18T00:00:00.000Z', source: 'user' }]; });
    deps.versionStore.listMemberships = vi.fn(async () => memberships);
    deps.versionStore.list = vi.fn(async () => [{ url, commit, refLabel: 'main', refKind: 'branch' as const, frameworks: [{ id: 'foundry', name: 'Foundry' }], createdAt: '2026-07-18T00:00:00.000Z', lastUsedAt: '2026-07-18T00:00:00.000Z' }]);
    const handlers = createProfileHandlers(deps); const addReply = makeReply();
    await handlers.addRepoVersion({ params: { id: 'p1' }, body: { url, ref: 'main' } } as never, addReply as never);
    expect(addReply.body).toEqual({ data: { jobId: 'job-version-1' } });
    await runner({ log: () => {}, signal: new AbortController().signal });
    expect(deps.repos.ensureVersion).toHaveBeenCalledWith('p1', url, commit, expect.objectContaining({ ref: 'main', refKind: 'branch' }));
    expect(deps.lifecycle.runPinnedLifecycle).toHaveBeenCalledWith(url, commit, 'p1', expect.any(Object), expect.any(Object));
    const listReply = makeReply(); await handlers.listRepos({ params: { id: 'p1' } } as never, listReply as never);
    expect((listReply.body as { data: { local: Array<{ versions: Array<{ commit: string }> }> } }).data.local[0].versions).toEqual([expect.objectContaining({ commit })]);
  });

  it('resolves a local ref through RepoService and keeps the local fallback path', async () => {
    const deps = makeDeps(); const url = 'https://example.com/contracts.git'; const commit = 'b'.repeat(40);
    let runner!: (ctx: { log: (line: string) => void; signal: AbortSignal }) => Promise<unknown>;
    deps.repos.getVersionSource = vi.fn(async () => ({ url, workspacePath: '/repo-a', localFallbackPath: '/repo-a' }));
    deps.repos.resolveLocalVersionCommit = vi.fn(async () => ({ commit, refKind: 'tag' as const }));
    deps.jobs = { start: vi.fn((_type: string, _params: Record<string, unknown>, value: typeof runner) => { runner = value; return { id: 'job-local', type: 'repo.version.add', params: {}, state: 'queued' as const, createdAt: new Date().toISOString(), events: [] }; }) };
    const handlers = createProfileHandlers(deps);
    await handlers.addRepoVersion({ params: { id: 'p1' }, body: { repoPathOrUrl: '/repo-a', ref: 'feature' } } as never, makeReply() as never);
    await runner({ log: () => {}, signal: new AbortController().signal });
    expect(deps.repos.resolveLocalVersionCommit).toHaveBeenCalledWith('/repo-a', 'feature', 'p1');
    expect(deps.repos.ensureVersion).toHaveBeenCalledWith('p1', url, commit, expect.objectContaining({ localFallbackPath: '/repo-a', refKind: 'tag', refLabel: 'feature' }));
  });

  it('adds user membership before lifecycle failure so the version remains visible', async () => {
    const deps = makeDeps();
    const url = 'https://example.com/contracts.git';
    const commit = 'c'.repeat(40);
    let runner!: (ctx: { log: (line: string) => void; signal: AbortSignal }) => Promise<unknown>;
    deps.jobs = {
      start: vi.fn((_type: string, _params: Record<string, unknown>, value: typeof runner) => {
        runner = value;
        return { id: 'job-fail', type: 'repo.version.add', params: {}, state: 'queued' as const, createdAt: new Date().toISOString(), events: [] };
      }),
    };
    deps.lifecycle.runPinnedLifecycle = vi.fn(async () => {
      throw new Error('compile failed');
    });

    await createProfileHandlers(deps).addRepoVersion(
      { params: { id: 'p1' }, body: { url, commit } } as never,
      makeReply() as never
    );
    await expect(runner({ log: () => {}, signal: new AbortController().signal })).rejects.toThrow('compile failed');
    expect(deps.versionStore.addMembership).toHaveBeenCalledWith('p1', url, commit, 'user');
    expect((deps.repos.ensureVersion as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (deps.versionStore.addMembership as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    );
    expect((deps.versionStore.addMembership as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (deps.lifecycle.runPinnedLifecycle as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    );
  });

  it('returns the reusable origin-approval error shape before starting a version job', async () => {
    const deps = makeDeps(); deps.versionStore.isOriginApproved = vi.fn(async () => false);
    const reply = makeReply(); await createProfileHandlers(deps).addRepoVersion({ params: { id: 'p1' }, body: { url: 'https://example.com/contracts.git', commit: 'c'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({ code: 'VERSION_ORIGIN_UNAPPROVED', details: { origins: ['https://example.com'] } });
    expect(deps.jobs.start).not.toHaveBeenCalled();
  });

  it('removes the last user reference and its checkout through the atomic version path', async () => {
    const deps = makeDeps(); const reply = makeReply();
    await createProfileHandlers(deps).removeRepoVersion({ params: { id: 'p1' }, body: { url: 'https://example.com/contracts.git', commit: 'd'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(204);
    expect(deps.repos.removeVersionCheckout).toHaveBeenCalledWith('https://example.com/contracts.git', 'd'.repeat(40), expect.any(Function));
  });

  it('returns VERSION_IN_USE after removing the user membership when a workflow still references it', async () => {
    const deps = makeDeps(); deps.versionStore.removeUserMembershipAndDeleteIfUnreferenced = vi.fn(async () => false);
    const reply = makeReply(); await createProfileHandlers(deps).removeRepoVersion({ params: { id: 'p1' }, body: { url: 'https://example.com/contracts.git', commit: 'e'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(409); expect(reply.body).toMatchObject({ code: 'VERSION_IN_USE' });
  });

  it('returns memberships without a registered-origin match as orphan version groups', async () => {
    const deps = makeDeps(); const url = 'https://orphan.example/contracts.git'; const commit = 'f'.repeat(40);
    deps.versionStore.listMemberships = vi.fn(async () => ({ [url]: [{ commit, addedAt: '2026-07-18T00:00:00.000Z', source: 'workflow' as const }] }));
    deps.versionStore.list = vi.fn(async () => [{ url, commit, createdAt: '2026-07-18T00:00:00.000Z', lastUsedAt: '2026-07-18T00:00:00.000Z' }]);
    const reply = makeReply(); await createProfileHandlers(deps).listRepos({ params: { id: 'p1' } } as never, reply as never);
    expect((reply.body as { data: { versionGroups: unknown[] } }).data.versionGroups).toEqual([{ url, versions: [expect.objectContaining({ commit })] }]);
  });

  it('deletePinnedRepo removes the checkout and registry entry under the version lock', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.deletePinnedRepo({ params: { id: 'p1' }, query: { url: 'https://example.com/contracts.git', commit: 'a'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(204);
    expect(deps.repos.removeVersionCheckout).toHaveBeenCalledWith('https://example.com/contracts.git', 'a'.repeat(40), expect.any(Function));
    expect(deps.versionStore.removeUserMembershipAndDeleteIfUnreferenced).toHaveBeenCalledWith('p1', 'https://example.com/contracts.git', 'a'.repeat(40), expect.any(Function));
  });

  it('deletePinnedRepo returns REPO_BUSY while its lifecycle job is active', async () => {
    const deps = makeDeps();
    deps.lifecycle.activeJobFor = vi.fn(() => 'job-pinned');
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.deletePinnedRepo({ params: { id: 'p1' }, query: { url: 'https://example.com/contracts.git', commit: 'a'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({ code: 'REPO_BUSY' });
    expect(deps.repos.removeVersionCheckout).not.toHaveBeenCalled();
    expect(deps.versionStore.removeUserMembershipAndDeleteIfUnreferenced).not.toHaveBeenCalled();
  });

  it('deletePinnedRepo returns 409 during an awaitable workflow-resolve lifecycle', async () => {
    const deps = makeDeps();
    const url = 'https://example.com/contracts.git'; const commit = 'a'.repeat(40);
    const worktree = deps.versionStore.checkoutPath(url, commit);
    let release!: () => void;
    const lifecycle = new RepoLifecycle({
      jobs: { start: vi.fn(), get: vi.fn() } as never,
      executor: { execute: vi.fn() } as never,
      registryLoader: { getPluginsByType: vi.fn(async () => []) } as never,
      repos: {
        init: vi.fn(), resolveWorkspacePath: vi.fn(async () => worktree),
        withVersionMaterialized: vi.fn((_profileId, _url, _commit, _opts, fn) => new Promise((resolve) => { release = () => resolve(fn({ checkout: worktree, rematerialize: async () => ({ checkout: worktree }) })); })),
      } as never,
      registry: { list: vi.fn(), updateRepoState: vi.fn() } as never,
      sessionPath: () => null,
      versionStore: { checkoutPath: () => worktree, get: vi.fn(), updateState: vi.fn() } as never,
    });
    deps.lifecycle.activeJobFor = vi.fn(lifecycle.activeJobFor.bind(lifecycle));
    const resolving = lifecycle.runPinnedLifecycle(url, commit, 'p1', { log: () => {}, signal: new AbortController().signal });
    const reply = makeReply();
    await createProfileHandlers(deps).deletePinnedRepo({ params: { id: 'p1' }, query: { url, commit } } as never, reply as never);
    expect(reply.statusCode).toBe(409);
    expect(deps.repos.removeVersionCheckout).not.toHaveBeenCalled();
    release();
    await resolving.catch(() => undefined);
  });

  it('saveRepo starts an add-mode lifecycle job and returns { jobId }', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.saveRepo(
      { params: { id: 'p1' }, body: { pathOrUrl: '/repo' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ data: { jobId: 'job-add-0' } });
    expect(deps.lifecycle.startLifecycle).toHaveBeenCalledWith(
      '/repo',
      'p1',
      'add'
    );
  });

  it('saveRepo does NOT start a pipeline when the save is rejected', async () => {
    const deps = makeDeps();
    deps.repoRegistry.save = vi.fn(async () => {
      throw Object.assign(new Error('Repository /repo already exists'), {
        code: 'REPO_ALREADY_EXISTS',
      });
    });
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.saveRepo(
      { params: { id: 'p1' }, body: { pathOrUrl: '/repo' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(409);
    expect(deps.lifecycle.startLifecycle).not.toHaveBeenCalled();
  });

  it('switchProfile triggers the lazy per-profile sweep', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.switchProfile(
      { params: { id: 'p2' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.lifecycle.ensureProfileSwept).toHaveBeenCalledWith('p2');
  });
});
