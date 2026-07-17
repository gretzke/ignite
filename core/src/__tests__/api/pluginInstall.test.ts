import { describe, it, expect, beforeEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PluginType } from '@ignite/plugin-types/types';
import {
  createInstallHandlers,
  type InstallJobManagerLike,
} from '../../api/plugins/install.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';
import type { JobContext, JobRunner } from '../../jobs/JobManager.js';

const waffleMeta = {
  id: 'waffle',
  types: [PluginType.COMPILER],
  name: 'Waffle',
  version: '1.0.0',
  baseImage: 'ignite/installed_waffle:1.0.0',
};

function makeFakeJobs(): InstallJobManagerLike & {
  started: Array<{
    type: string;
    params: Record<string, unknown>;
    runner: JobRunner;
  }>;
} {
  const started: Array<{
    type: string;
    params: Record<string, unknown>;
    runner: JobRunner;
  }> = [];
  return {
    started,
    start: vi.fn(
      (type: string, params: Record<string, unknown>, runner: JobRunner) => {
        started.push({ type, params, runner });
        return {
          id: `job-${started.length - 1}`,
          type,
          params,
          state: 'queued',
          createdAt: new Date().toISOString(),
          events: [],
        };
      }
    ) as InstallJobManagerLike['start'],
  };
}

function makeCtx(): JobContext {
  return { log: () => {}, signal: new AbortController().signal };
}

describe('install API handlers', () => {
  let app: FastifyInstance;
  let fakeJobs: ReturnType<typeof makeFakeJobs>;
  let invalidations: { deployment: ReturnType<typeof vi.fn>; contract: ReturnType<typeof vi.fn> };
  const installer = {
    install: vi.fn(async () => waffleMeta),
    update: vi.fn(async () => ({ plugin: waffleMeta, newPermissions: [] })),
    uninstall: vi.fn(async () => {}),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    fakeJobs = makeFakeJobs();
    invalidations = { deployment: vi.fn(), contract: vi.fn() };
    const handlers = createInstallHandlers(
      installer,
      { allowLocalSource: () => true },
      { jobs: fakeJobs, resweepRepos: async () => undefined, invalidateDeploymentTypes: invalidations.deployment, invalidateDeploymentHooks: vi.fn(), invalidateContractTypes: invalidations.contract }
    );
    app = fastify();
    app.post('/api/v1/plugins/install', handlers.installPlugin);
    app.post('/api/v1/plugins/:pluginId/update', handlers.updatePlugin);
    app.delete('/api/v1/plugins/:pluginId', handlers.uninstallPlugin);
    await app.ready();
  });

  it('starts a job and returns { data: { jobId } } immediately for a local source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { source: { kind: 'local', contextDir: '/src/waffle' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
    // The runner has not been awaited by the handler — install() is not
    // called until the (fake) JobManager actually runs the runner.
    expect(installer.install).not.toHaveBeenCalled();
    expect(fakeJobs.start).toHaveBeenCalledWith(
      'plugin.install',
      { source: { kind: 'local', contextDir: '/src/waffle' } },
      expect.any(Function)
    );

    const { runner } = fakeJobs.started[0];
    const result = await runner(makeCtx());
    expect(result).toEqual({ plugin: waffleMeta });
    expect(installer.install).toHaveBeenCalledWith({
      kind: 'local',
      contextDir: '/src/waffle',
    });
    expect(invalidations.deployment).toHaveBeenCalledOnce();
    expect(invalidations.contract).toHaveBeenCalledOnce();
  });

  it('propagates a plugin-install conflict as a job failure, not a sync 400', async () => {
    installer.install.mockRejectedValueOnce(
      new PluginError(
        "Cannot install 'foundry': it shadows a built-in plugin",
        ErrorCodes.PLUGIN_INSTALL_CONFLICT
      )
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { source: { kind: 'local', contextDir: '/src/foundry' } },
    });
    // Job creation always succeeds synchronously; the conflict surfaces
    // later via job.error.
    expect(res.statusCode).toBe(200);

    const { runner } = fakeJobs.started[0];
    await expect(runner(makeCtx())).rejects.toMatchObject({
      code: ErrorCodes.PLUGIN_INSTALL_CONFLICT,
    });
  });

  it('rejects local sources when local installs are not allowed', async () => {
    const gatedJobs = makeFakeJobs();
    const handlers = createInstallHandlers(
      installer,
      { allowLocalSource: () => false },
      { jobs: gatedJobs }
    );
    const gated = fastify();
    gated.post('/api/v1/plugins/install', handlers.installPlugin);
    await gated.ready();

    const localRes = await gated.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { source: { kind: 'local', contextDir: '/src/waffle' } },
    });
    expect(localRes.statusCode).toBe(400);
    expect(localRes.json().code).toBe('PLUGIN_INSTALL_REJECTED');
    expect(installer.install).not.toHaveBeenCalled();
    expect(gatedJobs.start).not.toHaveBeenCalled();

    const gitRes = await gated.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: {
        source: { kind: 'git', url: 'https://github.com/acme/waffle' },
      },
    });
    expect(gitRes.statusCode).toBe(200);
    expect(gatedJobs.start).toHaveBeenCalledTimes(1);
  });

  it('starts a plugin.update job and passes through an optional source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/waffle/update',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { jobId: 'job-0' } });
    expect(fakeJobs.start).toHaveBeenCalledWith(
      'plugin.update',
      { pluginId: 'waffle' },
      expect.any(Function)
    );

    const { runner } = fakeJobs.started[0];
    const result = await runner(makeCtx());
    expect(result).toEqual({ plugin: waffleMeta, newPermissions: [] });
    expect(installer.update).toHaveBeenCalledWith('waffle', undefined);
    expect(invalidations.deployment).toHaveBeenCalledOnce();
    expect(invalidations.contract).toHaveBeenCalledOnce();

    const withSource = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/waffle/update',
      payload: {
        source: {
          kind: 'git',
          url: 'https://github.com/acme/waffle',
          ref: 'v2',
        },
      },
    });
    expect(withSource.statusCode).toBe(200);
    await fakeJobs.started[1].runner(makeCtx());
    expect(installer.update).toHaveBeenCalledWith('waffle', {
      kind: 'git',
      url: 'https://github.com/acme/waffle',
      ref: 'v2',
    });
  });

  it('rejects an explicit local update source when local installs are not allowed', async () => {
    const gatedJobs = makeFakeJobs();
    const handlers = createInstallHandlers(
      installer,
      { allowLocalSource: () => false },
      { jobs: gatedJobs }
    );
    const gated = fastify();
    gated.post('/api/v1/plugins/:pluginId/update', handlers.updatePlugin);
    await gated.ready();

    const res = await gated.inject({
      method: 'POST',
      url: '/api/v1/plugins/waffle/update',
      payload: { source: { kind: 'local', contextDir: '/src/waffle' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PLUGIN_INSTALL_REJECTED');
    expect(gatedJobs.start).not.toHaveBeenCalled();
  });

  it('uninstalls a plugin', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/plugins/waffle',
    });
    expect(res.statusCode).toBe(204);
    expect(installer.uninstall).toHaveBeenCalledWith('waffle');
    expect(invalidations.deployment).toHaveBeenCalledOnce();
    expect(invalidations.contract).toHaveBeenCalledOnce();
  });
});
