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
    },
    pinnedStore: {
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      worktreePath: vi.fn((_profileId: string, url: string, commit: string) => `/pinned/${encodeURIComponent(url)}/${commit.slice(0, 12)}`),
    },
    deleteWorktree: vi.fn(async () => {}),
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
          },
          {
            pathOrUrl: '/repo-b',
            initialized: false,
            activeJobId: 'job-9',
          },
        ],
        cloned: [],
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

  it('listRepos includes pinned clone summaries', async () => {
    const deps = makeDeps();
    deps.pinnedStore.list = vi.fn(async () => [{
      url: 'https://example.com/contracts.git',
      commit: 'a'.repeat(40),
      refLabel: 'v1.2.3',
      refKind: 'tag' as const,
      frameworks: [{ id: 'foundry', name: 'Foundry', compiledAt: 'ignored' }],
      detectedAt: '2026-07-10T00:00:00.000Z',
      lastUsedAt: '2026-07-11T00:00:00.000Z',
    }]);
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.listRepos({ params: { id: 'p1' } } as never, reply as never);
    expect((reply.body as { data: { pinned: unknown[] } }).data.pinned).toEqual([{
      url: 'https://example.com/contracts.git',
      commit: 'a'.repeat(40),
      refLabel: 'v1.2.3',
      refKind: 'tag',
      frameworks: [{ id: 'foundry', name: 'Foundry' }],
      detectedAt: '2026-07-10T00:00:00.000Z',
      lastUsedAt: '2026-07-11T00:00:00.000Z',
    }]);
  });

  it('deletePinnedRepo removes the worktree and registry entry', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.deletePinnedRepo({ params: { id: 'p1' }, query: { url: 'https://example.com/contracts.git', commit: 'a'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(204);
    const worktree = `/pinned/${encodeURIComponent('https://example.com/contracts.git')}/${'a'.repeat(12)}`;
    expect(deps.deleteWorktree).toHaveBeenCalledWith(worktree);
    expect(deps.pinnedStore.remove).toHaveBeenCalledWith('p1', 'https://example.com/contracts.git', 'a'.repeat(40));
  });

  it('deletePinnedRepo returns REPO_BUSY while its lifecycle job is active', async () => {
    const deps = makeDeps();
    deps.lifecycle.activeJobFor = vi.fn(() => 'job-pinned');
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.deletePinnedRepo({ params: { id: 'p1' }, query: { url: 'https://example.com/contracts.git', commit: 'a'.repeat(40) } } as never, reply as never);
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({ code: 'REPO_BUSY' });
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(deps.pinnedStore.remove).not.toHaveBeenCalled();
  });

  it('deletePinnedRepo returns 409 during an awaitable workflow-resolve lifecycle', async () => {
    const deps = makeDeps();
    const url = 'https://example.com/contracts.git'; const commit = 'a'.repeat(40);
    const worktree = deps.pinnedStore.worktreePath('p1', url, commit);
    let release!: () => void;
    const lifecycle = new RepoLifecycle({
      jobs: { start: vi.fn(), get: vi.fn() } as never,
      executor: { execute: vi.fn() } as never,
      registryLoader: { getPluginsByType: vi.fn(async () => []) } as never,
      repos: {
        init: vi.fn(), resolveWorkspacePath: vi.fn(async () => worktree),
        ensurePinnedClone: vi.fn(() => new Promise((resolve) => { release = () => resolve({ path: worktree }); })),
      } as never,
      registry: { list: vi.fn(), updateRepoState: vi.fn() } as never,
      sessionPath: () => null,
      pinnedStore: { worktreePath: () => worktree, get: vi.fn(), upsert: vi.fn() } as never,
    });
    deps.lifecycle.activeJobFor = vi.fn(lifecycle.activeJobFor.bind(lifecycle));
    const resolving = lifecycle.runPinnedLifecycle(url, commit, 'p1', { log: () => {}, signal: new AbortController().signal });
    const reply = makeReply();
    await createProfileHandlers(deps).deletePinnedRepo({ params: { id: 'p1' }, query: { url, commit } } as never, reply as never);
    expect(reply.statusCode).toBe(409);
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
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
