import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  type InstalledWorkflowRecord,
  type WorkflowDocument,
} from '@ignite/api';
import { createWorkflowHandlers } from '../../api/workflows.js';

const COMMIT = 'a'.repeat(40);
const hash = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
const dirs: string[] = [];

function doc(overrides: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return {
    schemaVersion: 1,
    description: 'workflow',
    sources: [
      {
        id: 'box',
        repo: {
          url: 'https://example.test/box.git',
          commit: COMMIT,
          ref: 'v1',
          refKind: 'tag',
        },
        frameworkId: 'foundry',
        sourcePath: 'src/Box.sol',
        contractName: 'Box',
        artifactPath: 'out/Box.json',
      },
    ],
    steps: [
      { id: 'deploy', kind: 'deploy', contractId: 'box', args: { a: 1, b: 2 } },
    ],
    requiredPlugins: [{ id: 'foundry', version: '1.0.0' }],
    outputs: { hooks: [] },
    ...overrides,
  };
}

function installed(
  document: WorkflowDocument,
  docHash: string,
  at = '2026-01-01T00:00:00.000Z'
): InstalledWorkflowRecord {
  return {
    repoPathOrUrl: '/repo',
    name: 'release',
    installed: {
      docHash,
      at,
      sources: document.sources.map((source) =>
        source.origin === 'contract-type'
          ? {
              kind: 'contract-type' as const,
              id: source.id,
              pluginId: source.pluginId,
              artifactKey: source.artifactKey,
              versionLabel: source.versionLabel,
              contentHash: source.contentHash,
            }
          : {
              kind: 'repo' as const,
              id: source.id,
              pin: source.repo,
              frameworkId: source.frameworkId,
              sourcePath: source.sourcePath,
              contractName: source.contractName,
              artifactPath: source.artifactPath,
              ...(source.artifactHash
                ? { artifactHash: source.artifactHash }
                : {}),
            }
      ),
      plugins: document.requiredPlugins.map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        ...(plugin.source ? { source: canonicalJson(plugin.source) } : {}),
      })),
      stepsHash: hash(canonicalJson(document.steps)),
      hooksHash: hash(canonicalJson(document.outputs)),
    },
  };
}

async function statusHarness(
  options: {
    document?: WorkflowDocument;
    record?: InstalledWorkflowRecord;
    versions?: unknown[];
    jobs?: unknown[];
    pluginStatus?: (id: string) => unknown;
    checkout?: 'present' | 'missing' | 'file';
  } = {}
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ignite-workflow-status-')
  );
  dirs.push(root);
  const document = options.document ?? doc();
  await fs.mkdir(path.join(root, 'ignite', 'workflows'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'ignite', 'workflows', 'release.json'),
    JSON.stringify(document)
  );
  const checkout = path.join(root, 'checkout');
  if (options.checkout === 'file')
    await fs.writeFile(checkout, 'not a checkout');
  else if (options.checkout !== 'missing') await fs.mkdir(checkout);
  const store = {
    read: vi.fn(async () => ({
      records: options.record ? [options.record] : [],
      degraded: false,
    })),
    writeInstalled: vi.fn(),
    writeAttempt: vi.fn(),
    removeRecordsWhere: vi.fn(),
  };
  const versionStore = {
    approveOrigins: vi.fn(),
    list: vi.fn(
      async () =>
        options.versions ?? [
          {
            url: 'https://example.test/box',
            commit: COMMIT,
            createdAt: '',
            lastUsedAt: '',
            frameworks: [
              {
                id: 'foundry',
                name: 'Foundry',
                compiledAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            compiledWith: [{ pluginId: 'foundry', version: '1.0.0' }],
          },
        ]
    ),
    checkoutPath: vi.fn(() => checkout),
  };
  const repos = {
    resolveExistingWorkspacePath: vi.fn(async () => root),
    getFile: vi.fn(async (_repo: string, relative: string) => ({
      success: true,
      data: { content: await fs.readFile(path.join(root, relative), 'utf8') },
    })),
    withWorkflowWriteLock: vi.fn(),
  };
  const handlers = createWorkflowHandlers({
    repos: repos as never,
    versionStore: versionStore as never,
    installedWorkflows: store as never,
    jobs: { list: vi.fn(() => options.jobs ?? []) } as never,
    getProfileId: async () => 'profile',
    devMode: () => false,
    pluginStatus: async (id) =>
      (options.pluginStatus?.(id) as never) ?? {
        id,
        status: 'installed',
        installedVersion: '1.0.0',
      },
  });
  const app = fastify();
  app.get('/api/v1/repos/workflows/status', handlers.getWorkflowsStatus);
  await app.ready();
  return { app, store, versionStore };
}

async function entry(app: FastifyInstance) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/repos/workflows/status?pathOrUrl=%2Frepo',
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.workflows[0];
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
  vi.restoreAllMocks();
});

describe('workflow status', () => {
  it('keeps install state and attempts orthogonal, including failed out-of-sync and interrupted attempts', async () => {
    const current = doc();
    const currentHash = hash(JSON.stringify(current));
    const record = installed(doc(), 'b'.repeat(64));
    record.lastAttempt = {
      docHash: currentHash,
      at: '2027-01-01T00:00:00.000Z',
      status: 'failed',
      error: 'artifact failed',
      failedSources: [{ id: 'box', reason: 'missing' }],
      pins: [],
    };
    const failed = await statusHarness({ document: current, record });
    expect(await entry(failed.app)).toMatchObject({
      installState: 'out-of-sync',
      attempt: {
        status: 'failed',
        error: 'artifact failed',
        failedSources: [{ id: 'box' }],
      },
    });

    const interrupted = installed(current, currentHash);
    interrupted.lastAttempt = {
      docHash: currentHash,
      at: '2027-01-01T00:00:00.000Z',
      status: 'interrupted',
      error: 'restart',
      pins: [],
    };
    const recovered = await statusHarness({
      document: current,
      record: interrupted,
    });
    expect((await entry(recovered.app)).attempt).toMatchObject({
      status: 'interrupted',
      error: 'restart',
    });

    const failedNotInstalled = await statusHarness({
      document: current,
      record: { repoPathOrUrl: '/repo', name: 'release', lastAttempt: { docHash: currentHash, at: '2027-01-01T00:00:00.000Z', status: 'failed', error: 'first install failed', pins: [] } },
    });
    expect(await entry(failedNotInstalled.app)).toMatchObject({
      installState: 'not-installed', attempt: { status: 'failed', error: 'first install failed' },
    });

    const interruptedOutOfSync = installed(doc(), 'b'.repeat(64));
    interruptedOutOfSync.lastAttempt = { docHash: currentHash, at: '2027-01-01T00:00:00.000Z', status: 'interrupted', error: 'restart while updating', pins: [] };
    const interruptedDrift = await statusHarness({ document: current, record: interruptedOutOfSync });
    expect(await entry(interruptedDrift.app)).toMatchObject({
      installState: 'out-of-sync', attempt: { status: 'interrupted', error: 'restart while updating' },
    });

    const running = await statusHarness({
      document: current,
      record: interrupted,
      jobs: [
        {
          id: 'job-1',
          type: 'workflow.install',
          state: 'running',
          params: {
            profileId: 'profile',
            repoPathOrUrl: '/repo',
            name: 'release',
          },
        },
      ],
    });
    expect((await entry(running.app)).attempt).toEqual({
      status: 'running',
      jobId: 'job-1',
    });
  });

  it('reports every diff category and treats canonical key order as formatting only', async () => {
    const original = doc({
      sources: [
        ...doc().sources,
        {
          id: 'removed',
          repo: { url: 'https://example.test/removed', commit: COMMIT },
          frameworkId: 'foundry',
          sourcePath: 'R.sol',
          contractName: 'R',
          artifactPath: 'out/R.json',
        },
        {
          id: 'rename-old',
          repo: { url: 'https://example.test/rename', commit: COMMIT },
          frameworkId: 'foundry',
          sourcePath: 'N.sol',
          contractName: 'N',
          artifactPath: 'out/N.json',
        },
      ],
      requiredPlugins: [
        {
          id: 'foundry',
          version: '1.0.0',
          source: {
            kind: 'git',
            url: 'https://example.test/plugin',
            ref: 'old',
          },
        },
        { id: 'removed-plugin', version: '1' },
        { id: 'old-hook', version: '1' },
      ],
      outputs: { hooks: ['old-hook'] },
    });
    const box = doc().sources[0] as Extract<
      WorkflowDocument['sources'][number],
      { repo: unknown }
    >;
    const current = doc({
      sources: [
        {
          ...box,
          repo: { ...box.repo, commit: 'b'.repeat(40) },
          artifactPath: 'out/NewBox.json',
        },
        {
          id: 'added',
          repo: { url: 'https://example.test/added', commit: COMMIT },
          frameworkId: 'foundry',
          sourcePath: 'A.sol',
          contractName: 'A',
          artifactPath: 'out/A.json',
        },
        {
          id: 'rename-new',
          repo: { url: 'https://example.test/rename', commit: COMMIT },
          frameworkId: 'foundry',
          sourcePath: 'N.sol',
          contractName: 'N',
          artifactPath: 'out/N.json',
        },
      ],
      steps: [
        { id: 'deploy', kind: 'deploy', contractId: 'box', args: { a: 2 } },
      ],
      requiredPlugins: [
        {
          id: 'foundry',
          version: '2.0.0',
          source: {
            kind: 'git',
            url: 'https://example.test/plugin',
            ref: 'new',
          },
        },
        { id: 'added-plugin', version: '1' },
        { id: 'new-hook', version: '1' },
      ],
      outputs: { hooks: ['new-hook'] },
    });
    const harness = await statusHarness({
      document: current,
      record: installed(original, 'c'.repeat(64)),
    });
    const diff = (await entry(harness.app)).diff;
    expect(diff).toMatchObject({
      stepsChanged: true,
      hooksChanged: true,
      formattingOnly: false,
    });
    expect(diff.sourcesAdded).toHaveLength(1);
    expect(diff.sourcesRemoved).toHaveLength(1);
    expect(diff.sourcesRenamed).toHaveLength(1);
    expect(diff.versionsChanged).toHaveLength(1);
    expect(diff.artifactsChanged).toHaveLength(1);
    expect(
      diff.pluginsChanged.map((row: { kind: string }) => row.kind)
    ).toEqual(
      expect.arrayContaining(['added', 'removed', 'version', 'source'])
    );

    const reordered = doc({
      steps: [
        {
          id: 'deploy',
          kind: 'deploy',
          contractId: 'box',
          args: { b: 2, a: 1 },
        },
      ],
    });
    const formatting = await statusHarness({
      document: reordered,
      record: installed(doc(), 'd'.repeat(64)),
    });
    expect((await entry(formatting.app)).diff).toMatchObject({
      stepsChanged: false,
      hooksChanged: false,
      formattingOnly: true,
    });

    const stepsOnlyDocument = doc({
      steps: [{ id: 'deploy', kind: 'deploy', contractId: 'box', args: { a: 9 } }],
    });
    const stepsOnly = await statusHarness({
      document: stepsOnlyDocument,
      record: installed(doc(), 'e'.repeat(64)),
    });
    expect((await entry(stepsOnly.app)).diff).toMatchObject({
      stepsChanged: true,
      hooksChanged: false,
      formattingOnly: false,
    });

    const hookPlugins = [
      { id: 'foundry', version: '1.0.0' },
      { id: 'old-hook', version: '1' },
      { id: 'new-hook', version: '1' },
    ];
    const oldHooks = doc({ requiredPlugins: hookPlugins, outputs: { hooks: ['old-hook'] } });
    const newHooks = doc({ requiredPlugins: hookPlugins, outputs: { hooks: ['new-hook'] } });
    const hooksOnly = await statusHarness({
      document: newHooks,
      record: installed(oldHooks, 'f'.repeat(64)),
    });
    expect((await entry(hooksOnly.app)).diff).toMatchObject({
      stepsChanged: false,
      hooksChanged: true,
      formattingOnly: false,
      pluginsChanged: [],
    });
  });

  it.each([
    ['missing version', { versions: [] }, 'VERSION_MISSING'],
    ['framework has not compiled', { versions: [{ url: 'https://example.test/box', commit: COMMIT, createdAt: '', lastUsedAt: '', frameworks: [{ id: 'foundry', name: 'Foundry' }], compiledWith: [{ pluginId: 'foundry', version: '1.0.0' }] }] }, 'FRAMEWORK_NOT_COMPILED'],
    ['missing checkout', { checkout: 'missing' as const }, 'CHECKOUT_MISSING'],
    ['checkout is a file', { checkout: 'file' as const }, 'CHECKOUT_INVALID'],
    [
      'uninstalled plugin',
      { pluginStatus: () => ({ id: 'foundry', status: 'missing' }) },
      'missing',
    ],
    [
      'wrong plugin type',
      {
        pluginStatus: () => ({
          id: 'foundry',
          status: 'wrong-type',
          installedVersion: '1.0.0',
        }),
      },
      'wrong-type',
    ],
    [
      'compiler drift',
      {
        versions: [
          {
            url: 'https://example.test/box',
            commit: COMMIT,
            createdAt: '',
            lastUsedAt: '',
            frameworks: [{ id: 'foundry', name: 'Foundry', compiledAt: 'now' }],
            compiledWith: [{ pluginId: 'foundry', version: '0.9.0' }],
          },
        ],
      },
      'COMPILED_WITH_DRIFT',
    ],
  ])('marks liveness miss: %s', async (_label, options, code) => {
    const current = doc();
    const harness = await statusHarness({
      ...options,
      document: current,
      record: installed(current, hash(JSON.stringify(current))),
    });
    const value = await entry(harness.app);
    expect(value.installState).toBe('not-installed');
    expect(value.sources[0].code).toBe(code);
  });

  it('surfaces same-id semantic source changes instead of calling them formatting-only', async () => {
    const renamed = doc({ sources: [{ ...doc().sources[0], contractName: 'RenamedBox' }] });
    const renameHarness = await statusHarness({ document: renamed, record: installed(doc(), 'a'.repeat(64)) });
    expect((await entry(renameHarness.app)).diff).toMatchObject({
      sourcesModified: [{ detail: { id: 'box' }, changes: ['contractName'] }], formattingOnly: false,
    });

    const contractType = doc({
      sources: [{ id: 'typed', origin: 'contract-type', pluginId: 'type-plugin', artifactKey: 'box', versionLabel: '1', contractName: 'Box', contentHash: 'a'.repeat(64) }],
      steps: [{ id: 'deploy', kind: 'deploy', contractId: 'typed' }],
      requiredPlugins: [{ id: 'type-plugin', version: '1' }],
    });
    const changedContractType = { ...contractType, sources: [{ ...contractType.sources[0], contentHash: 'b'.repeat(64) }] } as WorkflowDocument;
    const contractHarness = await statusHarness({ document: changedContractType, record: installed(contractType, 'b'.repeat(64)) });
    expect((await entry(contractHarness.app)).diff).toMatchObject({
      sourcesModified: [{ detail: { id: 'typed' }, changes: ['contentHash'] }], formattingOnly: false,
    });
  });

  it('is read-only and sanitizes all hostile document strings', async () => {
    const hostile = doc({
      description: 'bad\u202etext\u0000',
      sources: [
        {
          id: 'box\u202e',
          repo: {
            url: 'https://example.test/box.git',
            commit: COMMIT,
            ref: 'v\u00001',
            refKind: 'tag',
          },
          frameworkId: 'foundry',
          sourcePath: 'src/C.sol',
          contractName: 'Box\u202e\u0000',
          artifactPath: 'out/C\u0000.json',
        },
      ],
      outputs: { hooks: ['hook\u202e\u0000'] },
    });
    const harness = await statusHarness({ document: hostile });
    const writeFile = vi.spyOn(fs, 'writeFile');
    const value = await entry(harness.app);
    expect(JSON.stringify(value)).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/
    );
    expect(harness.store.read).toHaveBeenCalledOnce();
    expect(harness.store.writeInstalled).not.toHaveBeenCalled();
    expect(harness.store.writeAttempt).not.toHaveBeenCalled();
    expect(harness.store.removeRecordsWhere).not.toHaveBeenCalled();
    expect(harness.versionStore.list).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
