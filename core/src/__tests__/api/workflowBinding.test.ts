import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createDeploymentHandlers } from '../../api/deployments.js';
import { WorkflowHttpError } from '../../api/workflows.js';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const HASH = 'a'.repeat(64);
const plan = {
  schemaVersion: 1 as const,
  contracts: [{ id: 'c', repoPathOrUrl: 'https://source.test/repo.git', frameworkId: 'foundry', artifactPath: 'out/C.json', contractName: 'C', sourcePath: 'src/C.sol', pin: { url: 'https://source.test/repo.git', commit: 'c'.repeat(40) } }],
  steps: [
    { id: 'deploy', kind: 'deploy' as const, contractId: 'c', args: { owner: A }, argsPerChain: { '1': { owner: B } }, libraries: { 'src/L.sol:Lib': { kind: 'address' as const, address: A } }, librariesPerChain: { '1': { 'src/L.sol:Lib': { kind: 'address' as const, address: B } } } },
    { id: 'call', kind: 'call' as const, target: { kind: 'address' as const, address: A }, targetPerChain: { '1': { kind: 'address' as const, address: B } } },
  ],
  chains: [1], signers: {},
};
const document = {
  schemaVersion: 1 as const,
  sources: [{ id: 'c', repo: { url: 'https://source.test/repo.git', commit: 'c'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/C.sol', contractName: 'C', artifactPath: 'out/C.json', artifactHash: 'b'.repeat(64) }],
  steps: [{ id: 'deploy', kind: 'deploy' as const, contractId: 'c' }],
  requiredPlugins: [{ id: 'foundry', version: '1' }, { id: 'chronicles', version: '1' }],
  outputs: { hooks: ['chronicles'] },
};
const workflow = {
  repoPathOrUrl: '/workflow', name: 'release', hooks: ['chronicles'],
  resolutions: [
    { stepId: 'deploy', path: '/args/owner', chainId: 1, address: B, source: 'manual' as const },
    { stepId: 'deploy', path: '/libraries/src~1L.sol:Lib', chainId: 1, address: B, source: 'suggestion' as const, via: { kind: 'plugin' as const, pluginId: 'chronicles' } },
    { stepId: 'call', path: '/target', chainId: 1, address: B, source: 'manual' as const },
  ],
  acknowledgeArtifactDrift: { c: { expected: 'b'.repeat(64), actual: 'd'.repeat(64) } },
};
const item = { ok: true, blocking: false, message: 'ok' };
const report = { chains: { '1': { rpc: item, signers: item, args: item, estimation: item, balance: item, inputs: item } }, run: { workflow: item, outputs: item } };

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as FastifyReply & typeof value;
}

function handlers(overrides: Record<string, unknown> = {}) {
  const launch = vi.fn(async (args) => ({ id: 'run', ...args }));
  const validate = vi.fn(async () => ({ report, frozen: {} }));
  const readWorkflow = vi.fn(async () => ({ document, raw: '{}', docHash: HASH }));
  return {
    launch, validate, readWorkflow,
    value: createDeploymentHandlers({
      engine: { launch, resolveLane: vi.fn(), resume: vi.fn(), abort: vi.fn() } as never,
      validate: validate as never,
      readWorkflow: readWorkflow as never,
      getProfileManager: async () => ({ getCurrentProfile: () => 'p1' }),
      ...overrides,
    } as never),
  };
}

describe('workflow deployment binding', () => {
  it('reads server workflow bytes, cross-checks merged literals, and snapshots validate/launch context', async () => {
    const h = handlers();
    const validated = reply();
    await h.value.validateDeployment({ body: { plan, rpcSelection: { '1': 'rpc' }, workflow } } as never, validated);
    expect(validated.statusCode).toBe(200);
    expect(validated.body).toMatchObject({ data: { run: report.run } });
    expect(h.validate).toHaveBeenCalledWith(plan, { '1': 'rpc' }, expect.objectContaining({ workflow: { document, binding: { ...workflow, docHash: HASH } } }));

    const launched = reply();
    await h.value.createDeploymentRun({ body: { plan, rpcSelection: { '1': 'rpc' }, workflow, idempotencyKey: 'key' } } as never, launched);
    expect(launched.statusCode).toBe(200);
    expect(h.launch).toHaveBeenCalledWith(expect.objectContaining({ workflow: { ...workflow, docHash: HASH }, workflowDocument: document }));
  });

  it.each([
    ['missing', new WorkflowHttpError(404, 'FILE_NOT_FOUND', 'missing'), 404],
    ['invalid', new WorkflowHttpError(422, 'WORKFLOW_JSON_INVALID', 'invalid'), 422],
  ])('returns the workflow read status for %s bindings at validate and launch', async (_name, error, status) => {
    const h = handlers({ readWorkflow: vi.fn(async () => { throw error; }) });
    for (const [kind, body] of [
      ['validate', { plan, rpcSelection: { '1': 'rpc' }, workflow }],
      ['launch', { plan, rpcSelection: { '1': 'rpc' }, workflow, idempotencyKey: 'key' }],
    ] as const) {
      const res = reply();
      if (kind === 'validate') await h.value.validateDeployment({ body } as never, res);
      else await h.value.createDeploymentRun({ body } as never, res);
      expect(res.statusCode).toBe(status);
    }
  });

  it.each([
    ['args', 0, A],
    ['library', 1, A],
    ['target', 2, A],
  ])('rejects a %s resolution that disagrees with the per-chain merged plan value', async (_kind, index, address) => {
    const h = handlers();
    const res = reply();
    const bad = { ...workflow, resolutions: workflow.resolutions.map((entry, i) => i === index ? { ...entry, address } : entry) };
    await h.value.validateDeployment({ body: { plan, rpcSelection: { '1': 'rpc' }, workflow: bad } } as never, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'WORKFLOW_RESOLUTION_MISMATCH' });
    expect(h.validate).not.toHaveBeenCalled();
  });
});
