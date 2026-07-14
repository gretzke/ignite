import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createWorkflowHandlers } from '../../api/workflows.js';
import type { JobRunner } from '../../jobs/JobManager.js';

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as unknown as FastifyReply & typeof value;
}
const workflow = {
  schemaVersion: 1,
  sources: [{ id: 'c', repo: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/C.sol', contractName: 'C', artifactPath: 'out/C.json' }],
  steps: [{ id: 'deploy', kind: 'deploy', contractId: 'c' }],
  requiredPlugins: [
    { id: 'foundry', version: '1.0.0' },
    { id: 'wrong-version', version: '2.0.0' },
    { id: 'missing', version: '1.0.0' },
    { id: 'untrusted', version: '1.0.0' },
  ],
  outputs: { hooks: [] },
};

describe('workflow resolve and origin approval', () => {
  it('runs pinned lifecycle awaitably and reports source/plugin readiness', async () => {
    let runner!: JobRunner;
    const lifecycle = { runPinnedLifecycle: vi.fn(async () => ({ pathOrUrl: '/pin', frameworks: [{ id: 'foundry', name: 'Foundry' }] })) };
    const handlers = createWorkflowHandlers({
      repos: { getFile: vi.fn(async () => ({ success: true, data: { content: JSON.stringify(workflow) } })) } as never,
      jobs: { start: vi.fn((_type, _params, value) => { runner = value; return { id: 'job-1' }; }) } as never,
      lifecycle: lifecycle as never,
      getProfileId: async () => 'p1',
      pluginStatus: async (id) => id === 'missing' ? { id, status: 'missing' } : id === 'wrong-version' ? { id, status: 'version-mismatch', installedVersion: '1.0.0' } : id === 'untrusted' ? { id, status: 'untrusted', installedVersion: '1.0.0' } : { id, status: 'installed', installedVersion: '1.0.0' },
      artifactReadable: async () => true,
    });
    const res = reply();
    await handlers.resolveWorkflow({ body: { repoPathOrUrl: '/workflow', name: 'test' } } as never, res);
    expect(res.body).toEqual({ data: { jobId: 'job-1' } });
    const result = await runner({ log: () => {}, signal: new AbortController().signal }) as any;
    expect(result.sources).toEqual([{ id: 'c', status: 'ready' }]);
    expect(result.plugins).toEqual(expect.arrayContaining([
      { id: 'foundry', status: 'installed', installedVersion: '1.0.0' },
      { id: 'wrong-version', status: 'version-mismatch', installedVersion: '1.0.0' },
      { id: 'missing', status: 'missing' },
      { id: 'untrusted', status: 'untrusted', installedVersion: '1.0.0' },
    ]));
    expect(lifecycle.runPinnedLifecycle).toHaveBeenCalledWith('https://example.test/repo.git', 'a'.repeat(40), 'p1', expect.any(Object));
  });

  it('surfaces unapproved origins in typed job failure details, then approval allows retry', async () => {
    let approved = false; let runner!: JobRunner;
    const runPinnedLifecycle = vi.fn(async () => {
      if (!approved) throw Object.assign(new Error('approval required'), { code: 'PINNED_ORIGIN_UNAPPROVED', origins: ['https://example.test'] });
      return { pathOrUrl: '/pin', frameworks: [{ id: 'foundry', name: 'Foundry' }] };
    });
    const store = { approveOrigins: vi.fn(async () => { approved = true; }) };
    const handlers = createWorkflowHandlers({
      repos: { getFile: vi.fn(async () => ({ success: true, data: { content: JSON.stringify({ ...workflow, requiredPlugins: [{ id: 'foundry', version: '1.0.0' }] }) } })) } as never,
      jobs: { start: vi.fn((_type, _params, value) => { runner = value; return { id: 'job-1' }; }) } as never,
      lifecycle: { runPinnedLifecycle } as never,
      pinnedStore: store as never,
      getProfileId: async () => 'p1', pluginStatus: async (id) => ({ id, status: 'installed', installedVersion: '1.0.0' }), artifactReadable: async () => true,
    });
    await handlers.resolveWorkflow({ body: { repoPathOrUrl: '/workflow', name: 'test' } } as never, reply());
    await expect(runner({ log: () => {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PINNED_ORIGIN_UNAPPROVED', details: { origins: ['https://example.test'] } });
    const approveReply = reply();
    await handlers.approveWorkflowOrigins({ body: { origins: ['https://example.test'] } } as never, approveReply);
    expect(approveReply.statusCode).toBe(200); expect(store.approveOrigins).toHaveBeenCalledWith('p1', ['https://example.test']);
    await expect(runner({ log: () => {}, signal: new AbortController().signal })).resolves.toMatchObject({ sources: [{ status: 'ready' }] });
  });
});
