import { describe, it, expect, vi } from 'vitest';
import {
  createRepoHandlers,
  type RepoServiceLike,
  type RepoJobManagerLike,
} from '../../api/plugins/repo-manager/index.js';
import { ErrorCodes } from '../../types/errors.js';
import type { RepoResult } from '../../repos/RepoService.js';
import type { JobContext, JobRunner } from '../../jobs/JobManager.js';

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
      expect(repos.init).toHaveBeenCalledWith('/local/repo');
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
    it('returns 204 on success', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.checkoutBranch(
        { body: { pathOrUrl: '/repo', branch: 'main' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(204);
      expect(reply.body).toBeNull();
      expect(repos.checkoutBranch).toHaveBeenCalledWith('/repo', 'main');
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
    it('returns 204 on success', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.checkoutCommit(
        { body: { pathOrUrl: '/repo', commit: 'abc123' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(204);
      expect(repos.checkoutCommit).toHaveBeenCalledWith('/repo', 'abc123');
    });

    it('maps failure to 500 CHECKOUT_COMMIT_ERROR', async () => {
      const repos = makeFakeRepos({
        checkoutCommit: vi.fn(async () =>
          fail('CHECKOUT_COMMIT_ERROR', 'bad commit')
        ),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
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
    it('returns 204 on success', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.pullChanges(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(204);
      expect(repos.pullChanges).toHaveBeenCalledWith('/repo');
    });

    it('maps failure to 500 PULL_ERROR', async () => {
      const repos = makeFakeRepos({
        pullChanges: vi.fn(async () => fail('PULL_ERROR', 'diverged')),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.pullChanges(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'PULL_ERROR' });
    });
  });

  describe('resetRepo', () => {
    it('returns 204 on success', async () => {
      const repos = makeFakeRepos();
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.resetRepo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(204);
      expect(repos.reset).toHaveBeenCalledWith('/repo');
    });

    it('maps failure to 500 RESET_ERROR', async () => {
      const repos = makeFakeRepos({
        reset: vi.fn(async () => fail('RESET_ERROR', 'failed to reset')),
      });
      const handlers = createRepoHandlers({ repos, jobs: makeFakeJobs() });
      const reply = makeReply();

      await handlers.resetRepo(
        { body: { pathOrUrl: '/repo' } } as never,
        reply as never
      );

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ code: 'RESET_ERROR' });
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
});
