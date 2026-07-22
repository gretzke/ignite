import { describe, expect, it, vi } from 'vitest';
import type { JobContext, JobRunner, JobStartOptions } from '../../jobs/JobManager.js';
import { WorkflowInstallService, type WorkflowInstallServiceDeps } from '../../workflows/WorkflowInstallService.js';

const document = {
  schemaVersion: 1 as const,
  sources: [{ id: 'box', repo: { url: 'https://example.test/box.git', commit: 'a'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/Box.sol', contractName: 'Box', artifactPath: 'out/Box.json' }],
  steps: [{ id: 'deploy', kind: 'deploy' as const, contractId: 'box', args: { z: 1, a: 2 } }],
  requiredPlugins: [{ id: 'foundry', version: '1' }],
  outputs: { hooks: [] },
};
const request = { repoPathOrUrl: '/workspace', name: 'release', expectedDocHash: 'b'.repeat(64) };
const ctx: JobContext = { log: () => {}, signal: new AbortController().signal };

function fakeJobs() {
  const started: Array<{ id: string; runner: JobRunner; opts?: JobStartOptions; record: { id: string; state: 'queued' | 'failed' | 'succeeded' | 'cancelled' } }> = [];
  return {
    started,
    start: vi.fn((_type: string, _params: Record<string, unknown>, runner: JobRunner, opts?: JobStartOptions) => {
      const record = { id: `job-${started.length + 1}`, state: 'queued' as const };
      started.push({ id: record.id, runner, opts, record });
      return record;
    }),
    get: vi.fn((id: string) => started.find((entry) => entry.id === id)?.record),
    list: vi.fn(() => []),
  };
}

function makeService(overrides: Partial<WorkflowInstallServiceDeps> = {}) {
  const jobs = fakeJobs();
  const store = {
    get: vi.fn(async () => undefined),
    writeInstalled: vi.fn(async (_profile, _key, _installed, guard) => guard ? guard() : true),
    writeAttempt: vi.fn(async () => {}),
  };
  const deps: WorkflowInstallServiceDeps = {
    readDocument: vi.fn(async () => ({ document, docHash: request.expectedDocHash })),
    jobs: jobs as never,
    lifecycle: { runPinnedLifecycle: vi.fn(async () => ({ pathOrUrl: '/pin', frameworks: [{ id: 'foundry' }] })) } as never,
    versionStore: { isOriginApproved: vi.fn(async () => true), addMembership: vi.fn(async () => {}) } as never,
    registry: { list: vi.fn(async () => ({ session: null, local: [{ pathOrUrl: '/workspace' }], cloned: [] })) } as never,
    store: store as never,
    pluginStatus: vi.fn(async (id, version) => ({ id, status: 'installed' as const, installedVersion: version })),
    artifactReadable: vi.fn(async () => true),
    ...overrides,
  };
  return { service: new WorkflowInstallService(deps), jobs, store, deps };
}

describe('WorkflowInstallService', () => {
  it('fences a changed document before creating a job', async () => {
    const { service, jobs } = makeService({ readDocument: async () => ({ document, docHash: 'c'.repeat(64) }) });
    await expect(service.start('profile', request)).rejects.toMatchObject({ statusCode: 409, code: 'WORKFLOW_DOC_CHANGED' });
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it('single-flights an install and retains its input pins synchronously', async () => {
    const { service, jobs } = makeService();
    await expect(service.start('profile', request)).resolves.toEqual({ jobId: 'job-1', attached: false });
    await expect(service.start('profile', request)).resolves.toEqual({ jobId: 'job-1', attached: true });
    expect(jobs.start).toHaveBeenCalledTimes(1);
    expect(jobs.start).toHaveBeenCalledWith('workflow.install', expect.objectContaining({
      profileId: 'profile',
      pins: [{ url: 'https://example.test/box.git', commit: 'a'.repeat(40) }],
    }), expect.any(Function), expect.any(Object));
    expect(service.activeAttemptPins('profile')).toEqual([{ url: 'https://example.test/box.git', commit: 'a'.repeat(40) }]);
  });

  it('clears queued-cancel pins through onSettled without running the job', async () => {
    const { service, jobs } = makeService();
    await service.start('profile', request);
    await jobs.started[0].opts?.onSettled?.({ id: 'job-1', state: 'cancelled' } as never);
    expect(service.activeAttemptPins('profile')).toEqual([]);
  });

  it('persists a failed attempt before rejecting with the result in error details', async () => {
    const { service, jobs, store } = makeService({ artifactReadable: async () => false });
    await service.start('profile', request);
    await expect(jobs.started[0].runner(ctx)).rejects.toMatchObject({
      code: 'WORKFLOW_INSTALL_FAILED',
      details: { sources: [{ id: 'box', status: 'failed', code: 'ARTIFACT_NOT_FOUND' }] },
    });
    expect(store.writeAttempt).toHaveBeenCalledWith('profile', { repoPathOrUrl: '/workspace', name: 'release' }, expect.objectContaining({
      docHash: request.expectedDocHash,
      status: 'failed',
      pins: [{ url: 'https://example.test/box.git', commit: 'a'.repeat(40) }],
    }));
  });

  it('writes a complete success snapshot with canonical step and hook hashes', async () => {
    const { service, jobs, store } = makeService();
    await service.start('profile', request);
    await expect(jobs.started[0].runner(ctx)).resolves.toMatchObject({ sources: [{ id: 'box', status: 'ready' }] });
    expect(store.writeInstalled).toHaveBeenCalledWith('profile', { repoPathOrUrl: '/workspace', name: 'release' }, expect.objectContaining({
      docHash: request.expectedDocHash,
      sources: [expect.objectContaining({ kind: 'repo', pin: { url: 'https://example.test/box.git', commit: 'a'.repeat(40) } })],
      stepsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      hooksHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }), expect.any(Function));
  });

  it('keeps the hash read at start when the workflow changes while the job runs', async () => {
    let loaded = document;
    const { service, jobs, store } = makeService({ readDocument: async () => ({ document: loaded, docHash: request.expectedDocHash }) });
    await service.start('profile', request);
    loaded = { ...document, steps: [] };
    await jobs.started[0].runner(ctx);
    expect(store.writeInstalled).toHaveBeenCalledWith('profile', expect.any(Object), expect.objectContaining({ docHash: request.expectedDocHash }), expect.any(Function));
  });

  it('persists interrupted recovery pins from the persisted job input', async () => {
    const { service, deps, store } = makeService();
    (deps.jobs.list as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 'interrupted', type: 'workflow.install', state: 'failed', createdAt: '2026-07-22T00:00:00.000Z', finishedAt: '2026-07-22T00:01:00.000Z',
      params: { profileId: 'profile', repoPathOrUrl: '/workspace', name: 'release', docHash: request.expectedDocHash, pins: [{ url: 'https://persisted.test/pin.git', commit: 'd'.repeat(40) }] },
      error: { code: 'INTERRUPTED', message: 'restarted' }, events: [],
    }]);
    await service.reconstructInterrupted();
    expect(store.writeAttempt).toHaveBeenCalledWith('profile', { repoPathOrUrl: '/workspace', name: 'release' }, expect.objectContaining({
      status: 'interrupted', pins: [{ url: 'https://persisted.test/pin.git', commit: 'd'.repeat(40) }],
    }));
  });

  it('treats a role mismatch as a terminal install failure', async () => {
    const { service, jobs } = makeService({ pluginStatus: async (id, version) => ({ id, status: 'wrong-type', installedVersion: version }) });
    await service.start('profile', request);
    await expect(jobs.started[0].runner(ctx)).rejects.toMatchObject({ details: { plugins: [{ id: 'foundry', status: 'wrong-type' }] } });
  });
});
