import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentPlan, RunRecord, WorkflowDocument } from '@ignite/api';
import { WorkflowPromotionService, type WorkflowPromotionServiceDeps } from '../../workflows/WorkflowPromotionService.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const HASH = 'c'.repeat(64);

describe('WorkflowPromotionService', () => {
  let files: Map<string, string>;
  let writes: Array<{ path: string; contents: string }>;

  beforeEach(() => { files = new Map(); writes = []; });

  it('previews unique/ambiguous/no-tag pins, dirty state, per-source errors, and collision without writing', async () => {
    files.set('ignite/workflows/release.json', '{}');
    const inspectSource = vi.fn(async (repo: string) => {
      if (repo === '/one') return { origin: 'https://example.test/one.git', commit: SHA, tags: ['v1.0.0'], branch: 'main', dirty: true };
      if (repo === '/two') return { origin: 'https://example.test/two.git', commit: SHA, tags: ['stable', 'v2.0.0'], branch: 'main', dirty: false };
      if (repo === '/three') return { origin: 'https://example.test/three.git', commit: SHA, tags: [], branch: null, dirty: false };
      throw Object.assign(new Error('origin remote is required'), { code: 'PROMOTION_ORIGIN_REQUIRED' });
    });
    const service = makeService({ inspectSource });
    const result = await service.promote({ mode: 'preview', target: { repoPathOrUrl: '/target', name: 'release' }, plan: plan() }, 'p1');
    expect(result).toMatchObject({ mode: 'preview', previewId: expect.any(String), nameCollision: true, sources: [
      { sourceId: 'one', origin: 'https://example.test/one', commit: SHA, tagChoices: ['v1.0.0'], dirty: true },
      { sourceId: 'two', origin: 'https://example.test/two', commit: SHA, tagChoices: ['stable', 'v2.0.0'], dirty: false },
      { sourceId: 'three', origin: 'https://example.test/three', commit: SHA, tagChoices: [], dirty: false },
      { sourceId: 'four', origin: '', commit: '', tagChoices: [], dirty: false, error: 'origin remote is required' },
    ] });
    expect(writes).toEqual([]);
  });

  it('re-derives on apply and rejects a moved HEAD or origin since preview', async () => {
    let current = { origin: 'https://example.test/one.git', commit: SHA, tags: ['v1.0.0'], branch: 'main', dirty: false };
    const service = makeService({ inspectSource: async () => current });
    const preview = await service.promote({ mode: 'preview', target: { repoPathOrUrl: '/target', name: 'release' }, plan: oneSourcePlan() }, 'p1');
    current = { ...current, commit: SHA2 };
    await expect(service.promote({ mode: 'apply', previewId: preview.previewId!, target: { repoPathOrUrl: '/target', name: 'release' }, plan: oneSourcePlan(), hooks: [] }, 'p1'))
      .rejects.toMatchObject({ code: 'PROMOTION_PREVIEW_STALE', statusCode: 409 });
    expect(writes).toEqual([]);
  });

  it('applies chosen pins, preserves pre-pinned sources, strips signers, computes plugins, uses frozen run hashes, and adopts idempotently under one lock', async () => {
    const run = promotedRun();
    let lockCalls = 0;
    const withWorkflowWriteLock = async <T>(_repo: string, fn: (io: { readFile: (path: string) => Promise<string | null>; writeFile: (path: string, contents: string) => Promise<void> }) => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return fn({ readFile: async (file) => files.get(file) ?? null, writeFile: async (file, contents) => { files.set(file, contents); writes.push({ path: file, contents }); } });
    };
    const service = makeService({
      inspectSource: async () => ({ origin: 'https://example.test/unpinned.git', commit: SHA, tags: ['stable', 'v2.0.0'], branch: 'main', dirty: false }),
      withWorkflowWriteLock,
      getRun: async (_profile, id) => id === run.id ? run : undefined,
      getRequiredPlugin: async (id) => ({ id, version: `1-${id}`, ...(id === 'hook' ? { source: { kind: 'git' as const, url: 'https://example.test/hook.git', commit: SHA, track: { mode: 'commit' as const } } } : {}) }),
      renderRunArtifact: async (_profile, id) => ({ runId: id }),
    });
    const preview = await service.promote({ mode: 'preview', target: { repoPathOrUrl: '/target', name: 'release' }, runId: run.id }, 'p1');
    const applied = await service.promote({
      mode: 'apply', previewId: preview.previewId!, target: { repoPathOrUrl: '/target', name: 'release' }, runId: run.id,
      tagChoiceBySourceId: { unpinned: 'v2.0.0' }, hooks: ['hook'], adoptRunIds: [run.id, run.id],
    }, 'p1');

    expect(applied).toMatchObject({ mode: 'apply', workflow: { name: 'release', valid: true } });
    expect(lockCalls).toBe(1);
    const document = JSON.parse(files.get('ignite/workflows/release.json')!) as WorkflowDocument;
    expect(document.sources.find((source) => source.id === 'pinned')!.repo).toEqual(run.plan.contracts[0].pin);
    expect(document.sources.find((source) => source.id === 'unpinned')).toMatchObject({ repo: { url: 'https://example.test/unpinned', commit: SHA, ref: 'v2.0.0', refKind: 'tag' }, artifactHash: HASH });
    expect(document.steps.every((step) => !('signerOverride' in step))).toBe(true);
    expect(document).not.toHaveProperty('signers');
    expect(document.outputs.hooks).toEqual(['hook']);
    expect(document.requiredPlugins.map((plugin) => plugin.id).sort()).toEqual(['foundry', 'hook', 'strategy'].sort());
    expect(document.requiredPlugins.find((plugin) => plugin.id === 'hook')?.source).toMatchObject({ kind: 'git', url: 'https://example.test/hook.git' });
    expect(writes.filter((entry) => entry.path === `ignite/deployments/release/${run.id}.json`)).toHaveLength(1);
  });

  it('requires overwrite for a colliding apply and carries a fresh draft freeze hash when available', async () => {
    files.set('ignite/workflows/release.json', '{"old":true}');
    const service = makeService({ freezeInputs: async () => ({ one: { abi: [], creationBytecode: '0x', compiler: { pluginId: 'foundry', version: '1', settingsHash: HASH }, artifactHash: HASH, repoDirty: false } }) });
    const request = { mode: 'preview' as const, target: { repoPathOrUrl: '/target', name: 'release' }, plan: oneSourcePlan() };
    const preview = await service.promote(request, 'p1');
    const apply = { mode: 'apply' as const, previewId: preview.previewId, target: request.target, plan: request.plan, hooks: [] };
    await expect(service.promote(apply, 'p1')).rejects.toMatchObject({ code: 'WORKFLOW_NAME_CONFLICT', statusCode: 409 });
    await expect(service.promote({ ...apply, overwrite: true }, 'p1')).resolves.toMatchObject({ mode: 'apply' });
    expect((JSON.parse(files.get('ignite/workflows/release.json')!) as WorkflowDocument).sources[0].artifactHash).toBe(HASH);
  });

  function makeService(overrides: Partial<WorkflowPromotionServiceDeps> = {}) {
    return new WorkflowPromotionService({
      inspectSource: async () => ({ origin: 'https://example.test/repo.git', commit: SHA, tags: ['v1.0.0'], branch: 'main', dirty: false }),
      readTargetFile: async (_repo, file) => files.get(file) ?? null,
      withWorkflowWriteLock: async (_repo, fn) => fn({ readFile: async (file) => files.get(file) ?? null, writeFile: async (file, contents) => { files.set(file, contents); writes.push({ path: file, contents }); } }),
      getRun: async () => undefined,
      getRequiredPlugin: async (id) => ({ id, version: '1' }),
      renderRunArtifact: async (_profile, id) => ({ runId: id }),
      freezeInputs: async () => ({}),
      validateTargetRepo: async () => true,
      ...overrides,
    });
  }
});

function plan(): DeploymentPlan {
  const base = oneSourcePlan();
  base.contracts.push(
    { ...base.contracts[0], id: 'two', repoPathOrUrl: '/two' },
    { ...base.contracts[0], id: 'three', repoPathOrUrl: '/three' },
    { ...base.contracts[0], id: 'four', repoPathOrUrl: '/four' },
  );
  return base;
}
function oneSourcePlan(): DeploymentPlan {
  return { schemaVersion: 1, chains: [1], signers: {}, contracts: [{ id: 'one', repoPathOrUrl: '/one', frameworkId: 'foundry', artifactPath: 'out/C.json', contractName: 'C', sourcePath: 'src/C.sol' }], steps: [{ id: 'deploy', kind: 'deploy', contractId: 'one' }] };
}
function promotedRun(): RunRecord {
  const value = oneSourcePlan();
  value.contracts = [
    { ...value.contracts[0], id: 'pinned', pin: { url: 'https://pinned.test/repo.git', commit: SHA2, ref: 'fixed', refKind: 'tag' } },
    { ...value.contracts[0], id: 'unpinned', repoPathOrUrl: '/unpinned' },
  ];
  value.steps = [
    { id: 'deploy-pinned', kind: 'deploy', contractId: 'pinned', signerOverride: { global: { pluginId: 'signer', accountId: 'a', address: '0x1111111111111111111111111111111111111111' } } },
    { id: 'deploy-unpinned', kind: 'deploy', contractId: 'unpinned', strategy: { kind: 'plugin', pluginId: 'strategy' } },
    { id: 'call', kind: 'call', target: { kind: 'step', stepId: 'deploy-pinned' }, signerOverride: { global: { pluginId: 'signer', accountId: 'a', address: '0x1111111111111111111111111111111111111111' } } },
  ];
  return {
    schemaVersion: 1, id: 'run-1', profileId: 'p1', name: 'Run', idempotencyKey: 'key', createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:01:00.000Z', status: 'completed', plan: value,
    inputs: {
      pinned: { abi: [], creationBytecode: '0x', compiler: { pluginId: 'foundry', version: '1', settingsHash: HASH }, artifactHash: 'd'.repeat(64), repoDirty: false },
      unpinned: { abi: [], creationBytecode: '0x', compiler: { pluginId: 'foundry', version: '1', settingsHash: HASH }, artifactHash: HASH, repoDirty: false },
    }, rpcSelection: { '1': { endpointId: 'rpc', label: 'RPC', urlFingerprint: HASH } }, validation: { chains: {} }, lanes: {},
  };
}
