import { describe, expect, it } from 'vitest';
import {
  makeWorkflowDocumentSchema,
  WorkflowPromoteRequestSchema,
  validateWorkflowClosure,
} from '@ignite/api';

const hash = 'a'.repeat(64);
const commit = 'b'.repeat(40);

function document() {
  return {
    schemaVersion: 1 as const,
    description: 'A workflow',
    sources: [{
      id: 'router',
      repo: { url: 'https://github.com/example/router.git', commit, ref: 'v1.0.0', refKind: 'tag' as const },
      frameworkId: 'foundry',
      sourcePath: 'src/Router.sol',
      contractName: 'Router',
      artifactPath: 'out/Router.sol/Router.json',
      artifactHash: hash,
    }],
    steps: [{
      id: 'deploy-router', kind: 'deploy' as const, contractId: 'router',
      args: { owner: { $ref: { kind: 'step', stepId: 'deploy-router' } } },
      strategy: { kind: 'plugin' as const, pluginId: 'deployer', params: { nested: { value: true } }, prepared: { '1': { initcodeHash: `0x${'11'.repeat(32)}`, predictedAddress: `0x${'22'.repeat(20)}` } } },
      libraries: { Lib: { kind: 'address' as const, address: `0x${'33'.repeat(20)}` } },
    }, {
      id: 'configure', kind: 'call' as const, target: { kind: 'step' as const, stepId: 'deploy-router' },
      signature: 'configure(address)', args: { value: { $ref: { kind: 'step', stepId: 'deploy-router' } } },
    }],
    defaultChains: [1, 10],
    requiredPlugins: [
      { id: 'foundry', version: '1.0.0' },
      { id: 'deployer', version: '1.0.0', source: { kind: 'git' as const, url: 'https://github.com/example/deployer.git', ref: 'main' } },
    ],
    outputs: { hooks: [] },
  };
}

describe('Workflow document schema', () => {
  it('round-trips a maximal valid document and validates closure', () => {
    const parsed = makeWorkflowDocumentSchema().parse(document());
    expect(parsed).toEqual(document());
    expect(validateWorkflowClosure(parsed)).toEqual([]);
  });

  it.each([
    ['top', (d: any) => ({ ...d, unknown: true })],
    ['source', (d: any) => ({ ...d, sources: [{ ...d.sources[0], unknown: true }] })],
    ['pin', (d: any) => ({ ...d, sources: [{ ...d.sources[0], repo: { ...d.sources[0].repo, unknown: true } }] })],
    ['step', (d: any) => ({ ...d, steps: [{ ...d.steps[0], unknown: true }] })],
    ['strategy', (d: any) => ({ ...d, steps: [{ ...d.steps[0], strategy: { ...d.steps[0].strategy, unknown: true } }] })],
    ['required plugin', (d: any) => ({ ...d, requiredPlugins: [{ ...d.requiredPlugins[0], unknown: true }] })],
    ['outputs', (d: any) => ({ ...d, outputs: { ...d.outputs, unknown: true } })],
    ['value ref', (d: any) => ({ ...d, steps: [{ ...d.steps[0], args: { x: { $ref: { kind: 'step', stepId: 'deploy-router', unknown: true } } } }] })],
  ])('rejects unknown keys at %s level', (_label, mutate) => {
    expect(() => makeWorkflowDocumentSchema().parse(mutate(document()))).toThrow();
  });

  it.each(['deploy', 'call'] as const)('rejects signerOverride on %s steps', (kind) => {
    const d = document();
    const step = kind === 'deploy' ? d.steps[0] : d.steps[1];
    expect(() => makeWorkflowDocumentSchema().parse({ ...d, steps: d.steps.map((candidate) => candidate === step ? { ...candidate, signerOverride: {} } : candidate) })).toThrow();
  });

  it('gates file URLs and rejects other git transports and credentials', () => {
    const url = (value: string) => ({ ...document(), sources: [{ ...document().sources[0], repo: { ...document().sources[0].repo, url: value } }] });
    expect(() => makeWorkflowDocumentSchema().parse(url('https://github.com/example/repo.git'))).not.toThrow();
    for (const value of ['ssh://git@example.com/repo.git', 'git@example.com:repo.git', 'git://example.com/repo.git', 'https://user:pass@example.com/repo.git', 'file:///tmp/repo']) {
      expect(() => makeWorkflowDocumentSchema().parse(url(value))).toThrow();
    }
    expect(() => makeWorkflowDocumentSchema({ allowFileUrls: true }).parse(url('file:///tmp/repo'))).not.toThrow();
  });

  it('enforces document payload caps and depth', () => {
    const huge = 'x'.repeat(64 * 1024);
    expect(() => makeWorkflowDocumentSchema().parse({ ...document(), steps: [{ ...document().steps[0], args: { huge } }] })).toThrow();
    expect(() => makeWorkflowDocumentSchema().parse({ ...document(), steps: [{ ...document().steps[0], strategy: { kind: 'plugin', pluginId: 'deployer', params: { p: huge } } }] })).toThrow();
    let deep: unknown = true;
    for (let i = 0; i < 13; i++) deep = { deep };
    expect(() => makeWorkflowDocumentSchema().parse({ ...document(), steps: [{ ...document().steps[0], args: { deep } }] })).toThrow();
  });

  it('enforces unique identities, names, and ref labels', () => {
    const d = document();
    expect(() => makeWorkflowDocumentSchema().parse({ ...d, sources: [d.sources[0], d.sources[0]] })).toThrow();
    expect(() => makeWorkflowDocumentSchema().parse({ ...d, steps: [d.steps[0], d.steps[0]] })).toThrow();
    expect(() => makeWorkflowDocumentSchema().parse({ ...d, requiredPlugins: [d.requiredPlugins[0], d.requiredPlugins[0]] })).toThrow();
    expect(() => makeWorkflowDocumentSchema().parse({ ...d, outputs: { hooks: ['hook', 'hook'] } })).toThrow();
    const { refKind: _refKind, ...repoWithoutRefKind } = d.sources[0].repo;
    expect(() => makeWorkflowDocumentSchema().parse({ ...d, sources: [{ ...d.sources[0], repo: { ...repoWithoutRefKind, ref: 'main' } }] })).toThrow();
    expect(makeWorkflowDocumentSchema().safeParse(document()).success).toBe(true);
  });

  it('reports closure missing framework, strategy, and hook plugins', () => {
    const d = document();
    const parsed = makeWorkflowDocumentSchema().parse({ ...d, outputs: { hooks: ['hook'] }, requiredPlugins: [] });
    expect(validateWorkflowClosure(parsed)).toEqual(expect.arrayContaining(['foundry', 'deployer', 'hook']));
  });

  it('accepts only minted UUIDv4 run ids on promotion wires', () => {
    const target = { repoPathOrUrl: '/repo', name: 'release' };
    const runId = '11111111-1111-4111-8111-111111111111';
    expect(WorkflowPromoteRequestSchema.safeParse({ mode: 'preview', target, runId }).success).toBe(true);
    expect(WorkflowPromoteRequestSchema.safeParse({ mode: 'preview', target, runId: '../../../other-profile' }).success).toBe(false);
    expect(WorkflowPromoteRequestSchema.safeParse({ mode: 'apply', previewId: 'p', target, runId, hooks: [], adoptRunIds: ['../escape'] }).success).toBe(false);
  });
});
