import { describe, it, expect, beforeEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PluginType } from '@ignite/plugin-types/types';
import {
  createCompilerHandlers,
  type CompilerExecutorLike,
  type CompilerJobManagerLike,
  type CompilerRegistryLoaderLike,
  type CompilerRepoServiceLike,
} from '../../api/plugins/compiler/index.js';
import { ErrorCodes } from '../../types/errors.js';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import type { JobContext, JobRunner } from '../../jobs/JobManager.js';

function makeCtx(log: (line: string) => void = () => {}): JobContext {
  return { log, signal: new AbortController().signal };
}

interface StartedJob {
  type: string;
  params: Record<string, unknown>;
  runner: JobRunner;
}

function makeFakeJobs(): CompilerJobManagerLike & { started: StartedJob[] } {
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
    ) as CompilerJobManagerLike['start'],
  };
}

function makeConfig(id: string, name: string, type: PluginType): PluginConfig {
  return {
    metadata: {
      id,
      types: [type],
      name,
      version: '1.0.0',
      baseImage: `ignite/installed_${id}:1.0.0`,
    },
    requiresRepo: false,
    origin: 'builtin',
  };
}

const waffleConfig = makeConfig('waffle', 'Waffle', PluginType.COMPILER);
const hardhatConfig = makeConfig('hardhat', 'Hardhat', PluginType.COMPILER);
const nonCompilerConfig = makeConfig(
  'gitrepo',
  'GitRepo',
  'repo-manager' as unknown as PluginType
);

function makeFakeRegistry(
  configs: Record<string, PluginConfig>
): CompilerRegistryLoaderLike {
  return {
    getPluginConfig: vi.fn(async (pluginId: string) => {
      const config = configs[pluginId];
      if (!config) throw new Error(`Unknown plugin: ${pluginId}`);
      return config;
    }),
    getPluginsByType: vi.fn(async (type: PluginType) =>
      Object.values(configs).filter((c) => c.metadata.types.includes(type))
    ),
  };
}

// Deterministic fake: appends '-workspace' to the pathOrUrl so tests can
// assert the resolved value (not just that *some* string was passed) reached
// executor.execute.
function makeFakeRepos(
  overrides: Partial<CompilerRepoServiceLike> = {}
): CompilerRepoServiceLike {
  return {
    resolveExistingWorkspacePath: vi.fn(
      async (pathOrUrl: string) => `${pathOrUrl}-workspace`
    ),
    ...overrides,
  };
}

describe('compiler API handlers (jobs)', () => {
  let app: FastifyInstance;
  let fakeJobs: ReturnType<typeof makeFakeJobs>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let registryLoader: CompilerRegistryLoaderLike;
  let repos: CompilerRepoServiceLike;

  beforeEach(async () => {
    fakeJobs = makeFakeJobs();
    executor = { execute: vi.fn() };
    registryLoader = makeFakeRegistry({
      waffle: waffleConfig,
      hardhat: hardhatConfig,
      gitrepo: nonCompilerConfig,
    });
    repos = makeFakeRepos();

    const handlers = createCompilerHandlers({
      jobs: fakeJobs,
      executor: executor as unknown as CompilerExecutorLike,
      registryLoader,
      repos,
    });

    app = fastify();
    app.post('/api/v1/detect', handlers.detect);
    app.post('/api/v1/install', handlers.install);
    app.post('/api/v1/compile', handlers.compile);
    app.post('/api/v1/artifacts/list', handlers.listArtifacts);
    app.post('/api/v1/artifacts/data', handlers.getArtifactData);
    await app.ready();
  });

  describe('detect', () => {
    it('returns { data: { jobId } } immediately without running the executor', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(fakeJobs.start).toHaveBeenCalledWith(
        'compiler.detect',
        { pathOrUrl: '/repo' },
        expect.any(Function)
      );
    });

    it('aggregates parallel per-plugin detects into { frameworks }', async () => {
      executor.execute.mockImplementation(
        async (
          pluginId: string,
          op: string,
          options: Record<string, unknown>
        ) => {
          if (pluginId === 'waffle') {
            return { success: true, data: { detected: true } };
          }
          if (pluginId === 'hardhat') {
            return { success: true, data: { detected: false } };
          }
          return { success: false, error: { code: 'X', message: 'nope' } };
        }
      );

      await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const { runner } = fakeJobs.started[0];
      const result = await runner(makeCtx());

      expect(result).toEqual({
        frameworks: [{ id: 'waffle', name: 'Waffle' }],
      });
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'detect',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
      expect(executor.execute).toHaveBeenCalledWith(
        'hardhat',
        'detect',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
    });

    it('fails the detect job when zero compiler plugins are available (broken catalog must be loud)', async () => {
      // A missing/empty plugin catalog previously produced a "succeeded"
      // job with frameworks: [] — every repo showed "Unknown Framework"
      // with no diagnostic. Zero available compilers is an installation
      // error, not an empty detection result.
      registryLoader = makeFakeRegistry({});
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/detect', handlers.detect);
      await localApp.ready();

      await localApp.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        code: ErrorCodes.NO_COMPILER_PLUGINS,
      });
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('fails the detect job when the plugin catalog cannot be loaded', async () => {
      registryLoader = {
        ...makeFakeRegistry({}),
        getPluginsByType: vi.fn(async () => {
          throw new Error('Built-in plugin catalog unavailable');
        }),
      };
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/detect', handlers.detect);
      await localApp.ready();

      await localApp.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toThrow(/catalog unavailable/);
    });

    it('resolves workspacePath once via RepoService, before the job is created', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledTimes(1);
      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledWith('/repo');
    });

    it('returns 400 synchronously when the workspace cannot be resolved (no job created)', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/detect', handlers.detect);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('wires onOutput through to ctx.log', async () => {
      executor.execute.mockImplementation(
        async (
          _pluginId: string,
          _op: string,
          _options: Record<string, unknown>,
          opts?: { onOutput?: (text: string) => void }
        ) => {
          opts?.onOutput?.('building...');
          return { success: true, data: { detected: false } };
        }
      );

      await app.inject({
        method: 'POST',
        url: '/api/v1/detect',
        payload: { pathOrUrl: '/repo' },
      });

      const logs: string[] = [];
      const { runner } = fakeJobs.started[0];
      await runner(makeCtx((line) => logs.push(line)));

      expect(logs).toContain('building...');
    });
  });

  describe('install', () => {
    it('returns 400 synchronously for an unknown plugin (no job created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.UNKNOWN_PLUGIN);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('returns 400 synchronously for a non-compiler plugin (no job created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'gitrepo' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.NOT_A_COMPILER_PLUGIN);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('starts a job and returns { data: { jobId } } immediately without awaiting the runner', async () => {
      executor.execute.mockImplementation(async () => {
        throw new Error('should not run synchronously');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
      expect(fakeJobs.start).toHaveBeenCalledWith(
        'compiler.install',
        { pathOrUrl: '/repo', pluginId: 'waffle' },
        expect.any(Function)
      );
    });

    it('runner calls execute with onOutput and resolves null on success', async () => {
      executor.execute.mockResolvedValue({ success: true, data: null });

      await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      const result = await runner(makeCtx());
      expect(result).toBeNull();
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'install',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
    });

    it('returns 400 synchronously when the workspace cannot be resolved (no job created)', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/install', handlers.install);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });

    it('runner rejects with { code, message, details } when the executor reports failure', async () => {
      executor.execute.mockResolvedValue({
        success: false,
        error: {
          code: 'PERMISSION_REQUIRED',
          message: 'Plugin waffle requires the docker permission',
          details: { pluginId: 'waffle', permission: 'docker' },
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/install',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        message: 'Plugin waffle requires the docker permission',
        code: 'PERMISSION_REQUIRED',
        details: { pluginId: 'waffle', permission: 'docker' },
      });
    });
  });

  describe('compile', () => {
    it('starts a job and returns { data: { jobId } } immediately', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('runner calls execute with onOutput and resolves null on success', async () => {
      executor.execute.mockResolvedValue({ success: true, data: null });

      await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      const result = await runner(makeCtx());
      expect(result).toBeNull();
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'compile',
        { pathOrUrl: '/repo' },
        {
          onOutput: expect.any(Function),
          workspacePath: '/repo-workspace',
          signal: expect.any(AbortSignal),
        }
      );
    });

    it('runner rejects with the plugin error code on failure', async () => {
      executor.execute.mockResolvedValue({
        success: false,
        error: { code: 'COMPILE_FAILED', message: 'syntax error' },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      const { runner } = fakeJobs.started[0];
      await expect(runner(makeCtx())).rejects.toMatchObject({
        code: 'COMPILE_FAILED',
        message: 'syntax error',
      });
    });

    it('returns 400 synchronously for a non-compiler plugin (no job created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/compile',
        payload: { pathOrUrl: '/repo', pluginId: 'gitrepo' },
      });
      expect(res.statusCode).toBe(400);
      expect(fakeJobs.start).not.toHaveBeenCalled();
    });
  });

  describe('listArtifacts', () => {
    it('resolves workspacePath and passes it through executor.execute', async () => {
      executor.execute.mockResolvedValue({
        success: true,
        data: { artifacts: [] },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/artifacts/list',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      expect(res.statusCode).toBe(200);
      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledWith('/repo');
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'listArtifacts',
        { pathOrUrl: '/repo' },
        { workspacePath: '/repo-workspace' }
      );
    });

    it('returns 400 synchronously when the workspace cannot be resolved', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/artifacts/list', handlers.listArtifacts);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/artifacts/list',
        payload: { pathOrUrl: '/repo', pluginId: 'waffle' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  describe('getArtifactData', () => {
    it('resolves workspacePath and passes it through executor.execute', async () => {
      executor.execute.mockResolvedValue({
        success: true,
        data: { content: 'abi json' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/artifacts/data',
        payload: {
          pathOrUrl: '/repo',
          pluginId: 'waffle',
          artifactPath: 'out/Foo.json',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(repos.resolveExistingWorkspacePath).toHaveBeenCalledWith('/repo');
      expect(executor.execute).toHaveBeenCalledWith(
        'waffle',
        'getArtifactData',
        { pathOrUrl: '/repo', artifactPath: 'out/Foo.json' },
        { workspacePath: '/repo-workspace' }
      );
    });

    it('returns 400 synchronously when the workspace cannot be resolved', async () => {
      repos = makeFakeRepos({
        resolveExistingWorkspacePath: vi.fn(async () => {
          throw new Error('no active profile');
        }),
      });
      const handlers = createCompilerHandlers({
        jobs: fakeJobs,
        executor: executor as unknown as CompilerExecutorLike,
        registryLoader,
        repos,
      });
      const localApp = fastify();
      localApp.post('/api/v1/artifacts/data', handlers.getArtifactData);
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/v1/artifacts/data',
        payload: {
          pathOrUrl: '/repo',
          pluginId: 'waffle',
          artifactPath: 'out/Foo.json',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCodes.INIT_ERROR);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });
});
