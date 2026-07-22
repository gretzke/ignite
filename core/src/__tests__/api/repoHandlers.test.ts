import { describe, it, expect, vi } from 'vitest';
import {
  createRepoHandlers,
  type RepoServiceLike,
  type RepoJobManagerLike,
} from '../../api/plugins/repo-manager/index.js';
import { ErrorCodes } from '../../types/errors.js';
import type { RepoResult } from '../../repos/RepoService.js';
import type { JobContext, JobRunner } from '../../jobs/JobManager.js';
import type { RepoLifecycle } from '../../repos/RepoLifecycle.js';

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

function makeCtx(log: (line: string) => void = () => {}): JobContext {
  return { log, signal: new AbortController().signal };
}

interface StartedJob {
  type: string;
  params: Record<string, unknown>;
  runner: JobRunner;
}

function makeFakeJobs(): RepoJobManagerLike & { started: StartedJob[] } {
  const started: StartedJob[] = [];
  return {
    started,
    start: vi.fn(
      (type: string, params: Record<string, unknown>, runner: JobRunner) => {
        started.push({ type, params, runner });
        return {
          id: `job-${started.length - 1}`,
          type,
          params,
          state: 'queued' as const,
          createdAt: new Date().toISOString(),
          events: [],
        };
      }
    ) as RepoJobManagerLike['start'],
  };
}

function ok<T>(data: T): RepoResult<T> {
  return { success: true, data };
}

function fail(code: string, message = 'boom'): RepoResult<never> {
  return { success: false, error: { code, message } };
}

function makeFakeRepos(overrides?: Partial<RepoServiceLike>): RepoServiceLike {
  return {
    init: vi.fn(async () => ok(null)),
    getBranches: vi.fn(async () => ok({ branches: [] })),
    checkoutBranch: vi.fn(async () => ok(null)),
    checkoutCommit: vi.fn(async () => ok(null)),
    pullChanges: vi.fn(async () => ok(null)),
    reset: vi.fn(async () => ok(null)),
    getRepoInfo: vi.fn(async () =>
      ok({ branch: 'main', commit: 'abc123', dirty: false, upToDate: true })
    ),
    getFile: vi.fn(async () => ok({ content: 'hello' })),
    withVersionMaterialized: vi.fn(async (_profileId, _url, _commit, _opts, fn) =>
      fn({ checkout: '/pinned', rematerialize: async () => ({ checkout: '/pinned' }) })
    ),
    ...overrides,
  };
}

function makeFakeLifecycle(
  overrides?: Partial<
    Pick<
      RepoLifecycle,
      'activeJobFor' | 'beginRepoActivity' | 'startLifecycle' | 'checkAndRecompile'
    >
  >
) {
  return {
    activeJobFor: vi.fn(() => undefined),
    beginRepoActivity: vi.fn(() => vi.fn()),
    startLifecycle: vi.fn(() => ({
      id: 'lifecycle-1',
      type: 'repo.lifecycle',
      params: {},
      state: 'queued' as const,
      createdAt: new Date().toISOString(),
      events: [],
    })),
    checkAndRecompile: vi.fn(async () => ({ started: [] })),
    ...overrides,
  };
}

describe('repo-manager API handlers', () => {
  describe('init', () => {
    it('starts a repo.init job and returns { data: { jobId } } immediately', async () => {
      const repos = makeFakeRepos();
      const jobs = makeFakeJobs();
      const handlers = createRepoHandlers({ repos, jobs });
      const reply = makeReply();

      await handlers.init(
        { body: { pathOrUrl: '/local/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { jobId: 'job-0' } });
      expect(repos.init).not.toHaveBeenCalled();
      expect(jobs.start).toHaveBeenCalledWith(
        'repo.init',
        { pathOrUrl: '/local/repo' },
        expect.any(Function)
      );
    });

    it('runner calls repos.init and resolves null on success', async () => {
      const repos = makeFakeRepos();
      const jobs = makeFakeJobs();
      const handlers = createRepoHandlers({ repos, jobs });
      const reply = makeReply();

      await handlers.init(
        { body: { pathOrUrl: '/local/repo' } } as never,
        reply as never
      );

      const { runner } = jobs.started[0];
      const result = await runner(makeCtx());
      expect(result).toBeNull();
      expect(repos.init).toHaveBeenCalledWith('/local/repo', {
        signal: expect.any(AbortSignal),
      });
    });

    it('runner rejects with { code, message } when RepoService.init fails', async () => {
      const repos = makeFakeRepos({
        init: vi.fn(async () => fail('CLONE_FAILED', 'network unreachable')),
      });
      const jobs = makeFakeJobs();
      const handlers = createRepoHandlers({ repos, jobs });
      const reply = makeReply();

      await handlers.init(
        { body: { pathOrUrl: 'https://example.com/a/b.git' } } as never,
        reply as never
      );

      const { runner } = jobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        code: 'CLONE_FAILED',
        message: 'network unreachable',
      });
    });

    it('rejects a bad cloned URL scheme synchronously with 400 INIT_ERROR, no job created', async () => {
      const repos = makeFakeRepos();
      const jobs = makeFakeJobs();
      const handlers = createRepoHandlers({ repos, jobs });
      const reply = makeReply();

      await handlers.init(
        { body: { pathOrUrl: 'ext://evil.example/x' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(400);
      expect((reply.body as { code: string }).code).toBe(ErrorCodes.INIT_ERROR);
      expect(jobs.start).not.toHaveBeenCalled();
      expect(repos.init).not.toHaveBeenCalled();
    });

    it('allows a LOCAL path through pre-flight even though it is not a clone URL', async () => {
      const repos = makeFakeRepos();
      const jobs = makeFakeJobs();
      const handlers = createRepoHandlers({ repos, jobs });
      const reply = makeReply();

      await handlers.init(
        { body: { pathOrUrl: '/some/local/path' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(jobs.start).toHaveBeenCalled();
    });
  });

  describe('getBranches', () => {
    it('returns 200 with branches on success', async () => {
      const repos = makeFakeRepos({
        getBranches: vi.fn(async () => ok({ branches: ['main', 'dev'] })),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getBranches(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { branches: ['main', 'dev'] } });
    });

    it('maps failure to 500 GET_BRANCHES_ERROR', async () => {
      const repos = makeFakeRepos({
        getBranches: vi.fn(async () => fail('NOT_GIT_REPO', 'not a repo')),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getBranches(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({
        statusCode: 500,
        code: 'NOT_GIT_REPO',
        message: 'not a repo',
      });
    });
  });

  describe('checkoutBranch', () => {
    it('returns a switch lifecycle job id on success', async () => {
      const repos = makeFakeRepos();
      const lifecycle = makeFakeLifecycle();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { jobId: 'lifecycle-1' } });
      expect(repos.checkoutBranch).toHaveBeenCalledWith('/repo', 'main', 'p1');
      expect(lifecycle.startLifecycle).toHaveBeenCalledWith('/repo', 'p1', 'switch');
    });

    it('captures the profile before a mutation can overlap a profile switch', async () => {
      let finishFirst!: () => void;
      const repos = makeFakeRepos({
        checkoutBranch: vi.fn((pathOrUrl: string) =>
          pathOrUrl === '/repo-a'
            ? new Promise<RepoResult<null>>((resolve) => {
                finishFirst = () => resolve(ok(null));
              })
            : Promise.resolve(ok(null))
        ),
      });
      const lifecycle = makeFakeLifecycle();
      const getProfileId = vi
        .fn()
        .mockResolvedValueOnce('A')
        .mockResolvedValueOnce('B');
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId,
      });

      const first = handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo-a', branch: 'main' } } as never,
        makeReply() as never
      );
      await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo-b', branch: 'main' } } as never,
        makeReply() as never
      );
      finishFirst();
      await first;

      expect(repos.checkoutBranch).toHaveBeenCalledWith(
        '/repo-a',
        'main',
        'A'
      );
      expect(lifecycle.startLifecycle).toHaveBeenNthCalledWith(
        1,
        '/repo-b',
        'B',
        'switch'
      );
      expect(lifecycle.startLifecycle).toHaveBeenNthCalledWith(
        2,
        '/repo-a',
        'A',
        'switch'
      );
    });

    it('rejects a concurrent checkout while the first checkout holds its reservation', async () => {
      let resolveCheckout!: () => void;
      const repos = makeFakeRepos({
        checkoutBranch: vi.fn(
          () => new Promise<RepoResult<null>>((resolve) => {
            resolveCheckout = () => resolve(ok(null));
          })
        ),
      });
      const busy = new Set<string>();
      const lifecycle = makeFakeLifecycle({
        activeJobFor: vi.fn((path) => (busy.has(path) ? `direct:${path}` : undefined)),
        beginRepoActivity: vi.fn((path) => {
          busy.add(path);
          return () => busy.delete(path);
        }),
      });
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const firstReply = makeReply();
      const first = handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        firstReply as never
      );
      await Promise.resolve();
      const secondReply = makeReply();
      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'other' } } as never,
        secondReply as never
      );

      expect(secondReply.statusCode).toBe(409);
      expect(secondReply.body).toMatchObject({ code: 'REPO_BUSY' });
      expect(repos.checkoutBranch).toHaveBeenCalledTimes(1);

      resolveCheckout();
      await first;
    });

    it('rejects checkout while a lifecycle job is active', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle: makeFakeLifecycle({ activeJobFor: vi.fn(() => 'lifecycle-active') }),
      });
      const reply = makeReply();

      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body).toMatchObject({ code: 'REPO_BUSY' });
      expect(repos.checkoutBranch).not.toHaveBeenCalled();
    });

    it('does not start a lifecycle job after a checkout failure or leave the repo busy', async () => {
      const release = vi.fn();
      const lifecycle = makeFakeLifecycle({ beginRepoActivity: vi.fn(() => release) });
      const handlers = createRepoHandlers({
        repos: makeFakeRepos({
          checkoutBranch: vi.fn(async () => fail('DIRTY_REPO', 'uncommitted changes')),
        }),
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(lifecycle.startLifecycle).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it('maps DIRTY_REPO failure to 500 CHECKOUT_BRANCH_ERROR fallback code preserved from result', async () => {
      const repos = makeFakeRepos({
        checkoutBranch: vi.fn(async () =>
          fail('DIRTY_REPO', 'uncommitted changes')
        ),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'DIRTY_REPO' });
    });
  });

  describe('checkoutCommit', () => {
    it('returns a switch lifecycle job id on success', async () => {
      const repos = makeFakeRepos();
      const lifecycle = makeFakeLifecycle();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.checkoutCommit(
        { body: { pathOrUrl: '/repo', commit: 'abc123' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { jobId: 'lifecycle-1' } });
      expect(repos.checkoutCommit).toHaveBeenCalledWith('/repo', 'abc123', 'p1');
      expect(lifecycle.startLifecycle).toHaveBeenCalledWith('/repo', 'p1', 'switch');
    });

    it('maps failure to 500 CHECKOUT_COMMIT_ERROR', async () => {
      const repos = makeFakeRepos({
        checkoutCommit: vi.fn(async () =>
          fail('CHECKOUT_COMMIT_ERROR', 'bad commit')
        ),
      });
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle: makeFakeLifecycle(),
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.checkoutCommit(
        { body: { pathOrUrl: '/repo', commit: 'zzz' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'CHECKOUT_COMMIT_ERROR' });
    });
  });

  describe('pullChanges', () => {
    it('starts a recompile lifecycle and returns its job id on success', async () => {
      const repos = makeFakeRepos();
      const lifecycle = makeFakeLifecycle();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.pullChanges(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { jobId: 'lifecycle-1' } });
      expect(repos.pullChanges).toHaveBeenCalledWith('/repo', 'p1');
      expect(lifecycle.startLifecycle).toHaveBeenCalledWith('/repo', 'p1', 'recompile');
    });

    it('maps failure to 500 PULL_ERROR', async () => {
      const repos = makeFakeRepos({
        pullChanges: vi.fn(async () => fail('PULL_ERROR', 'diverged')),
      });
      const release = vi.fn();
      const lifecycle = makeFakeLifecycle({ beginRepoActivity: vi.fn(() => release) });
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.pullChanges(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'PULL_ERROR' });
      expect(lifecycle.startLifecycle).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it('rejects pull during an active lifecycle without mutating the repository', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle: makeFakeLifecycle({ activeJobFor: vi.fn(() => 'lifecycle-active') }),
      });
      const reply = makeReply();

      await handlers.pullChanges(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body).toMatchObject({ code: 'REPO_BUSY' });
      expect(repos.pullChanges).not.toHaveBeenCalled();
    });

    it('rejects checkout while a pull holds its reservation', async () => {
      let resolvePull!: () => void;
      const repos = makeFakeRepos({
        pullChanges: vi.fn(
          () => new Promise<RepoResult<null>>((resolve) => {
            resolvePull = () => resolve(ok(null));
          })
        ),
      });
      const busy = new Set<string>();
      const lifecycle = makeFakeLifecycle({
        activeJobFor: vi.fn((path) => (busy.has(path) ? `direct:${path}` : undefined)),
        beginRepoActivity: vi.fn((path) => {
          busy.add(path);
          return () => busy.delete(path);
        }),
      });
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const pullReply = makeReply();
      const pull = handlers.pullChanges(
        { body: { pathOrUrl: '/repo' } } as never,
        pullReply as never
      );
      await Promise.resolve();
      const checkoutReply = makeReply();
      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        checkoutReply as never
      );

      expect(checkoutReply.statusCode).toBe(409);
      expect(repos.checkoutBranch).not.toHaveBeenCalled();

      resolvePull();
      await pull;
    });
  });

  describe('resetRepo', () => {
    it('starts a recompile lifecycle and returns its job id on success', async () => {
      const repos = makeFakeRepos();
      const lifecycle = makeFakeLifecycle();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.resetRepo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { jobId: 'lifecycle-1' } });
      expect(repos.reset).toHaveBeenCalledWith('/repo', 'p1');
      expect(lifecycle.startLifecycle).toHaveBeenCalledWith('/repo', 'p1', 'recompile');
    });

    it('maps failure to 500 RESET_ERROR', async () => {
      const repos = makeFakeRepos({
        reset: vi.fn(async () => fail('RESET_ERROR', 'failed to reset')),
      });
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle: makeFakeLifecycle(),
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();

      await handlers.resetRepo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'RESET_ERROR' });
    });

    it('rejects reset during an active lifecycle without mutating the repository', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({
        repos,
        jobs: makeFakeJobs(),
        lifecycle: makeFakeLifecycle({ activeJobFor: vi.fn(() => 'lifecycle-active') }),
      });
      const reply = makeReply();

      await handlers.resetRepo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body).toMatchObject({ code: 'REPO_BUSY' });
      expect(repos.reset).not.toHaveBeenCalled();
    });
  });

  describe('getRepoInfo', () => {
    it('returns 200 with repo info on success', async () => {
      const repos = makeFakeRepos({
        getRepoInfo: vi.fn(async () =>
          ok({
            branch: 'main',
            commit: 'deadbeef',
            dirty: true,
            upToDate: false,
          })
        ),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getRepoInfo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({
        data: {
          branch: 'main',
          commit: 'deadbeef',
          dirty: true,
          upToDate: false,
        },
      });
    });

    it('maps failure to 500 INFO_ERROR', async () => {
      const repos = makeFakeRepos({
        getRepoInfo: vi.fn(async () => fail('INFO_ERROR', 'no head')),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getRepoInfo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'INFO_ERROR' });
    });
  });

  describe('getFile', () => {
    it('returns 200 with file content on success', async () => {
      const repos = makeFakeRepos({
        getFile: vi.fn(async () => ok({ content: 'pragma solidity ^0.8.0;' })),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getFile(
        { body: { pathOrUrl: '/repo', filePath: 'src/A.sol' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({
        data: { content: 'pragma solidity ^0.8.0;' },
      });
      expect(repos.getFile).toHaveBeenCalledWith('/repo', 'src/A.sol');
    });

    it('reads from the materialized commit when a pin is supplied', async () => {
      const repos = makeFakeRepos({
        getFile: vi.fn(async (workspace: string) => ok({ content: workspace === '/pinned' ? 'pinned' : 'live' })),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs(), getProfileId: async () => 'p1' });
      const reply = makeReply();

      await handlers.getFile({ body: { pathOrUrl: '/live', filePath: 'src/A.sol', pin: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) } } } as never, reply as never);

      expect(reply.body).toEqual({ data: { content: 'pinned' } });
      expect(repos.getFile).toHaveBeenCalledWith('/pinned', 'src/A.sol');
      expect(repos.withVersionMaterialized).toHaveBeenCalledWith('p1', 'https://example.test/repo.git', 'a'.repeat(40), { ref: undefined }, expect.any(Function));
    });

    it('maps FILE_NOT_FOUND to 404', async () => {
      const repos = makeFakeRepos({
        getFile: vi.fn(async () =>
          fail('FILE_NOT_FOUND', 'File not found: missing.sol')
        ),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getFile(
        { body: { pathOrUrl: '/repo', filePath: 'missing.sol' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(404);
      expect(reply.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        code: 'FILE_NOT_FOUND',
      });
    });

    it('maps INVALID_PATH to 403', async () => {
      const repos = makeFakeRepos({
        getFile: vi.fn(async () => fail('INVALID_PATH', 'bad segment')),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getFile(
        { body: { pathOrUrl: '/repo', filePath: '../etc/passwd' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(403);
      expect(reply.body).toMatchObject({
        statusCode: 403,
        error: 'Forbidden',
        code: 'INVALID_PATH',
      });
    });

    it('maps SUSPICIOUS_PATH_PATTERN to 403', async () => {
      const repos = makeFakeRepos({
        getFile: vi.fn(async () =>
          fail('SUSPICIOUS_PATH_PATTERN', 'symlink escape')
        ),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getFile(
        { body: { pathOrUrl: '/repo', filePath: 'link' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(403);
      expect(reply.body).toMatchObject({
        statusCode: 403,
        error: 'Forbidden',
        code: 'SUSPICIOUS_PATH_PATTERN',
      });
    });

    it('maps any other failure code to 500', async () => {
      const repos = makeFakeRepos({
        getFile: vi.fn(async () =>
          fail('FILE_READ_ERROR', 'permission denied')
        ),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.getFile(
        { body: { pathOrUrl: '/repo', filePath: 'a.sol' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'FILE_READ_ERROR',
      });
    });
  });

  describe('checkRepos', () => {
    it('delegates to lifecycle.checkAndRecompile for the current profile', async () => {
      const lifecycle = makeFakeLifecycle({
        checkAndRecompile: vi.fn(async () => ({
          started: [{ pathOrUrl: '/repo-a', jobId: 'job-3' }],
        })),
      });
      const handlers = createRepoHandlers({
        repos: makeFakeRepos(),
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();
      await handlers.checkRepos({ body: {} } as never, reply as never);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({
        data: { started: [{ pathOrUrl: '/repo-a', jobId: 'job-3' }] },
      });
      expect(lifecycle.checkAndRecompile).toHaveBeenCalledWith('p1', {
        scope: 'local',
        debounce: 'quiet-pause',
      });
    });

    it('narrows the check to a single repo when pathOrUrl is provided', async () => {
      const lifecycle = makeFakeLifecycle({
        checkAndRecompile: vi.fn(async () => ({ started: [] })),
      });
      const handlers = createRepoHandlers({
        repos: makeFakeRepos(),
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });
      const reply = makeReply();
      await handlers.checkRepos(
        { body: { pathOrUrl: '/repo-a' } } as never,
        reply as never
      );
      expect(lifecycle.checkAndRecompile).toHaveBeenCalledWith('p1', {
        scope: 'local',
        debounce: 'quiet-pause',
        pathOrUrl: '/repo-a',
      });
    });

    it('starts a forced catalog recompile for Retry', async () => {
      const lifecycle = makeFakeLifecycle({
        checkAndRecompile: vi.fn(async () => ({ started: [] })),
      });
      const handlers = createRepoHandlers({
        repos: makeFakeRepos(),
        jobs: makeFakeJobs(),
        lifecycle,
        getProfileId: async () => 'p1',
      });

      await handlers.checkRepos(
        { body: { pathOrUrl: '/repo-a', force: true } } as never,
        makeReply() as never
      );

      expect(lifecycle.checkAndRecompile).toHaveBeenCalledWith('p1', {
        scope: 'all',
        debounce: 'none',
        pathOrUrl: '/repo-a',
        force: 'catalog',
      });
    });
  });
});
