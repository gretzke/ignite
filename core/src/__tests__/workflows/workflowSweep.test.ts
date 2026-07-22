import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  WorkflowInstallService,
  type WorkflowInstallServiceDeps,
} from '../../workflows/WorkflowInstallService.js';

const commit = 'a'.repeat(40);
const oldCommit = 'b'.repeat(40);
const url = 'https://example.test/contracts.git';
const canonicalUrl = 'https://example.test/contracts';
const dirs: string[] = [];

const record = (pins: Array<{ url: string; commit: string }> = []) => ({
  repoPathOrUrl: '/repo',
  name: 'release',
  installed: {
    docHash: 'd'.repeat(64),
    at: '2026-07-22T00:00:00.000Z',
    sources: pins.map((pin, index) => ({
      kind: 'repo' as const,
      id: `source-${index}`,
      pin,
      frameworkId: 'foundry',
      sourcePath: 'src/Box.sol',
      contractName: 'Box',
      artifactPath: 'out/Box.json',
    })),
    plugins: [],
    stepsHash: 'e'.repeat(64),
    hooksHash: 'f'.repeat(64),
  },
});

function makeService(overrides: Partial<WorkflowInstallServiceDeps> = {}) {
  const store: any = {
    read: vi.fn(async () => ({ records: [], degraded: false })),
    get: vi.fn(async () => undefined),
    writeInstalled: vi.fn(async () => true),
    writeAttempt: vi.fn(async () => {}),
    removeRecordsWhere: vi.fn(async () => {}),
  };
  const versionStore: any = {
    isOriginApproved: vi.fn(async () => true),
    addMembership: vi.fn(async () => {}),
    listMemberships: vi.fn(async () => ({})),
    removeWorkflowMembershipAndDeleteIfUnreferenced: vi.fn(async () => ({
      membershipRemoved: true,
      checkoutDeleted: true,
    })),
    list: vi.fn(async () => []),
    deleteIfZeroReferencesCAS: vi.fn(async () => false),
  };
  const repos: any = {
    removeVersionCheckout: vi.fn(
      async (
        _url: string,
        _commit: string,
        beforeDelete?: (remove: () => Promise<void>) => Promise<boolean>
      ) => (beforeDelete ? beforeDelete(async () => {}) : true)
    ),
    resolveWorkspacePath: vi.fn(async () => '/repo'),
  };
  const deps: WorkflowInstallServiceDeps = {
    readDocument: vi.fn(async () => ({
      document: {
        schemaVersion: 1 as const,
        sources: [],
        steps: [],
        requiredPlugins: [],
        outputs: { hooks: [] },
      },
      docHash: 'd'.repeat(64),
    })),
    jobs: { start: vi.fn(), get: vi.fn(), list: vi.fn(() => []) } as never,
    lifecycle: { runPinnedLifecycle: vi.fn() } as never,
    versionStore: versionStore as never,
    registry: {
      list: vi.fn(async () => ({
        session: null,
        local: [{ pathOrUrl: '/repo' }],
        cloned: [],
      })),
    } as never,
    store,
    repos,
    pluginStatus: vi.fn(),
    artifactReadable: vi.fn(),
    ...overrides,
  };
  return {
    service: new WorkflowInstallService(deps),
    store,
    versionStore,
    repos,
    deps,
  };
}

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('WorkflowInstallService membership sweep', () => {
  it('frees a version-bumped workflow membership and routes deletion through RepoService', async () => {
    const { service, store, versionStore, repos } = makeService();
    store.read.mockResolvedValue({
      records: [record([{ url, commit }])],
      degraded: false,
    });
    versionStore.listMemberships.mockResolvedValue({
      [canonicalUrl]: [
        {
          commit: oldCommit,
          source: 'workflow',
          addedAt: '2026-07-22T00:00:00.000Z',
        },
      ],
    });

    await service.sweep('p1');

    expect(repos.removeVersionCheckout).toHaveBeenCalledWith(
      canonicalUrl,
      oldCommit,
      expect.any(Function)
    );
    expect(
      versionStore.removeWorkflowMembershipAndDeleteIfUnreferenced
    ).toHaveBeenCalledWith('p1', canonicalUrl, oldCommit, expect.any(Function));
  });

  it('retains last-attempt pins and canonicalizes .git spellings', async () => {
    const { service, store, versionStore, repos } = makeService();
    store.read.mockResolvedValue({
      records: [
        {
          repoPathOrUrl: '/repo',
          name: 'release',
          lastAttempt: {
            docHash: 'd'.repeat(64),
            at: '2026-07-22T00:00:00.000Z',
            status: 'failed',
            error: 'no artifact',
            pins: [{ url, commit }],
          },
        },
      ],
      degraded: false,
    });
    versionStore.listMemberships.mockResolvedValue({
      [canonicalUrl]: [
        { commit, source: 'workflow', addedAt: '2026-07-22T00:00:00.000Z' },
      ],
    });

    await service.sweep('p1');
    expect(repos.removeVersionCheckout).not.toHaveBeenCalled();
  });

  it('refuses degraded registries without touching memberships', async () => {
    const { service, store, versionStore } = makeService();
    store.read.mockResolvedValue({ records: [], degraded: true });

    await service.sweep('p1');
    expect(versionStore.listMemberships).not.toHaveBeenCalled();
    expect(versionStore.list).not.toHaveBeenCalled();
  });

  it('skips a busy checkout and converges on the next sweep', async () => {
    const { service, versionStore, repos } = makeService();
    versionStore.listMemberships.mockResolvedValue({
      [canonicalUrl]: [
        { commit, source: 'workflow', addedAt: '2026-07-22T00:00:00.000Z' },
      ],
    });
    repos.removeVersionCheckout
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(
        async (
          _url: string,
          _commit: string,
          beforeDelete: (remove: () => Promise<void>) => Promise<boolean>
        ) => beforeDelete(async () => {})
      );

    await service.sweep('p1');
    expect(
      versionStore.removeWorkflowMembershipAndDeleteIfUnreferenced
    ).not.toHaveBeenCalled();
    await service.sweep('p1');
    expect(
      versionStore.removeWorkflowMembershipAndDeleteIfUnreferenced
    ).toHaveBeenCalledTimes(1);
  });

  it('reconciles a crash-simulated zero-reference orphan through the CAS path', async () => {
    const { service, versionStore, repos } = makeService();
    versionStore.list.mockResolvedValue([{ url: canonicalUrl, commit }]);
    versionStore.deleteIfZeroReferencesCAS.mockImplementation(
      async (_url: string, _commit: string, remove: () => Promise<boolean>) =>
        remove()
    );

    await service.sweep('p1');

    expect(versionStore.deleteIfZeroReferencesCAS).toHaveBeenCalledWith(
      canonicalUrl,
      commit,
      expect.any(Function)
    );
    expect(repos.removeVersionCheckout).toHaveBeenCalledWith(
      canonicalUrl,
      commit
    );
  });

  it('retains active attempt pins while an unrelated sweep runs', async () => {
    let runner:
      | ((ctx: { log: () => void; signal: AbortSignal }) => Promise<unknown>)
      | undefined;
    const jobs = {
      start: vi.fn((_type, _params, candidate) => {
        runner = candidate;
        return { id: 'job-1', state: 'queued' };
      }),
      get: vi.fn(() => ({ id: 'job-1', state: 'running' })),
      list: vi.fn(() => []),
    };
    const { service, versionStore, repos } = makeService({
      jobs: jobs as never,
      readDocument: async () => ({
        document: {
          schemaVersion: 1,
          sources: [
            {
              id: 'box',
              repo: { url, commit },
              frameworkId: 'foundry',
              sourcePath: 'src/Box.sol',
              contractName: 'Box',
              artifactPath: 'out/Box.json',
            },
          ],
          steps: [],
          requiredPlugins: [],
          outputs: { hooks: [] },
        },
        docHash: 'd'.repeat(64),
      }),
    });
    versionStore.listMemberships.mockResolvedValue({
      [canonicalUrl]: [
        { commit, source: 'workflow', addedAt: '2026-07-22T00:00:00.000Z' },
      ],
    });

    await service.start('p1', {
      repoPathOrUrl: '/repo',
      name: 'active',
      expectedDocHash: 'd'.repeat(64),
    });
    await service.sweep('p1');

    expect(runner).toBeDefined();
    expect(repos.removeVersionCheckout).not.toHaveBeenCalled();
  });

  it('startup removes unregistered and file-gone records but retains stat errors', async () => {
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ignite-workflow-startup-')
    );
    dirs.push(repoRoot);
    const unregistered = {
      ...record(),
      repoPathOrUrl: '/gone',
      name: 'unregistered',
    };
    const gone = { ...record(), name: 'gone' };
    const statError = { ...record(), name: 'error' };
    const { service, store, repos } = makeService();
    store.read.mockResolvedValue({
      records: [unregistered, gone, statError],
      degraded: false,
    });
    // File-gone is ENOENT. For the final record, replace the resolver with an
    // unexpected stat-side failure by using an invalid root after its first call.
    let calls = 0;
    repos.resolveWorkspacePath.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return repoRoot;
      const error = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      throw error;
    });

    await service.sweepStartup('p1');

    expect(repos.resolveWorkspacePath).toHaveBeenCalledTimes(2);
    expect(store.removeRecordsWhere).toHaveBeenCalledWith(
      'p1',
      expect.any(Function)
    );
    const predicate = store.removeRecordsWhere.mock.calls[0][1] as (
      value: unknown
    ) => boolean;
    expect(predicate(unregistered)).toBe(true);
    expect(predicate(gone)).toBe(true);
    expect(predicate(statError)).toBe(false);
  });
});
