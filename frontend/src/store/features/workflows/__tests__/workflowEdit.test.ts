// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { appendSource, cascadeRemoveSource, changeSourceVersion, DeploymentPlanSchema, makeWorkflowDocumentSchema, mintSourceId, validateWorkflowClosure, type WorkflowDocument } from '@ignite/api';
import { projectWorkflowPlan } from '../../../../routes/deploy/projection';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const address = `0x${'1'.repeat(40)}`;

function fixture(): WorkflowDocument {
  return makeWorkflowDocumentSchema().parse({
    schemaVersion: 1,
    sources: [
      { id: 'remove', repo: { url: 'https://example.test/remove.git', commit: SHA }, frameworkId: 'compiler-remove', sourcePath: 'src/Remove.sol', contractName: 'Remove', artifactPath: 'Remove.json', artifactHash: HASH },
      { id: 'keep', repo: { url: 'https://example.test/keep.git', commit: SHA }, frameworkId: 'compiler-keep', sourcePath: 'src/Keep.sol', contractName: 'Keep', artifactPath: 'Keep.json' },
      { id: 'my-contract-1', repo: { url: 'https://example.test/one.git', commit: SHA }, frameworkId: 'compiler-keep', sourcePath: 'src/One.sol', contractName: 'One', artifactPath: 'One.json' },
      { id: 'my-contract-2', repo: { url: 'https://example.test/two.git', commit: SHA }, frameworkId: 'compiler-keep', sourcePath: 'src/Two.sol', contractName: 'Two', artifactPath: 'Two.json' },
    ],
    steps: [
      { id: 'remove-deploy', kind: 'deploy', contractId: 'remove' },
      { id: 'remove-wrapper', kind: 'deploy', contractId: 'keep', wraps: { stepId: 'remove-deploy', contractTypePluginId: 'wrapper' } },
      { id: 'required-call', kind: 'call', target: { kind: 'step', stepId: 'remove-deploy' } },
      { id: 'required-per-chain-call', kind: 'call', target: { kind: 'address', address }, targetPerChain: { '1': { kind: 'step', stepId: 'remove-deploy' } } },
      { id: 'keep-deploy', kind: 'deploy', contractId: 'keep', libraries: { 'src/Lib.sol:Lib': { kind: 'step', stepId: 'remove-deploy' } }, librariesPerChain: { '1': { 'src/Lib.sol:Lib': { kind: 'step', stepId: 'remove-deploy' } } }, args: { ref: { $ref: { kind: 'step', stepId: 'remove-deploy' } }, encoded: { $encode: { contractId: 'remove', fn: 'set(address)', args: { target: address } } } }, argsPerChain: { '1': { encoded: { $encode: { contractId: 'remove', fn: 'set(address)', args: {} } } } }, strategy: { kind: 'plugin', pluginId: 'strategy', params: { encoded: { $encode: { contractId: 'remove', fn: 'set(address)', args: {} } } } } },
      { id: 'deploy-my-contract-3-1', kind: 'deploy', contractId: 'my-contract-1' },
    ],
    requiredPlugins: [
      { id: 'compiler-remove', version: '1' },
      { id: 'compiler-keep', version: '1' },
      { id: 'wrapper', version: '1' },
      { id: 'strategy', version: '1' },
    ],
    outputs: { hooks: [] },
  });
}

function assertClosed(doc: WorkflowDocument): void {
  expect(makeWorkflowDocumentSchema().safeParse(doc).success).toBe(true);
  expect(validateWorkflowClosure(doc)).toEqual([]);
}

describe('workflow edit utilities', () => {
  it('cascades required references to a fixed point and clears every optional reference form', () => {
    const doc = fixture();
    const before = globalThis.structuredClone(doc);
    const result = cascadeRemoveSource(doc, 'remove');

    expect(result.removedStepIds).toEqual(['remove-deploy', 'remove-wrapper', 'required-call', 'required-per-chain-call']);
    expect(result.doc.sources.map((source) => source.id)).not.toContain('remove');
    const keep = result.doc.steps.find((step) => step.id === 'keep-deploy');
    expect(keep).toMatchObject({ id: 'keep-deploy', kind: 'deploy', libraries: {}, librariesPerChain: { '1': {} }, args: {}, argsPerChain: { '1': {} } });
    expect((keep as Extract<WorkflowDocument['steps'][number], { kind: 'deploy' }>).strategy).toEqual({ kind: 'plugin', pluginId: 'strategy', params: {} });
    expect(result.clearedRefs).toEqual(expect.arrayContaining([
      { stepId: 'keep-deploy', path: '$.steps[0].libraries["src/Lib.sol:Lib"].stepId' },
      { stepId: 'keep-deploy', path: '$.steps[0].librariesPerChain["1"]["src/Lib.sol:Lib"].stepId' },
      { stepId: 'keep-deploy', path: '$.steps[0].args.ref.$ref.stepId' },
      { stepId: 'keep-deploy', path: '$.steps[0].args.encoded.$encode.contractId' },
      { stepId: 'keep-deploy', path: '$.steps[0].argsPerChain["1"].encoded.$encode.contractId' },
      { stepId: 'keep-deploy', path: '$.steps[0].strategy.params.encoded.$encode.contractId' },
    ]));
    assertClosed(result.doc);
    const plan = projectWorkflowPlan({
      document: result.doc,
      repoPathOrUrl: '/repo',
      chains: [1],
      includedStepIds: {},
      resolutions: [],
    });
    expect(DeploymentPlanSchema.safeParse(plan).success).toBe(true);
    expect(doc).toEqual(before);
  });

  it('reaches a fixed point through chained call targets', () => {
    const doc = fixture();
    doc.steps.push(
      { id: 'call-one', kind: 'call', target: { kind: 'step', stepId: 'remove-deploy' } },
      { id: 'call-two', kind: 'call', target: { kind: 'step', stepId: 'call-one' } }
    );
    const result = cascadeRemoveSource(doc, 'remove');
    expect(result.removedStepIds).toEqual(expect.arrayContaining(['remove-deploy', 'call-one', 'call-two']));
    assertClosed(result.doc);
  });

  it('mints source and deploy ids without collisions and appends a closed document', () => {
    const doc = fixture();
    const before = globalThis.structuredClone(doc);
    expect(mintSourceId(doc, 'My Contract')).toBe('my-contract-3');
    const result = appendSource(doc, { id: 'ignored', repo: { url: 'https://example.test/new.git', commit: 'c'.repeat(40), ref: 'v2', refKind: 'tag' }, frameworkId: 'compiler-new', sourcePath: 'src/New.sol', contractName: 'My Contract', artifactPath: 'New.json' }, { id: 'compiler-new', version: '2' });
    expect(result.sourceId).toBe('my-contract-3');
    expect(result.stepId).toBe('deploy-my-contract-3-2');
    expect(result.doc.sources.at(-1)).toMatchObject({ id: 'my-contract-3', contractName: 'My Contract' });
    expect(result.doc.steps.at(-1)).toEqual({ id: 'deploy-my-contract-3-2', kind: 'deploy', contractId: 'my-contract-3' });
    expect(result.doc.requiredPlugins).toContainEqual({ id: 'compiler-new', version: '2' });
    assertClosed(result.doc);
    expect(doc).toEqual(before);
  });

  it('changes only a repo source pin and drops its artifact hash', () => {
    const doc = fixture();
    const before = globalThis.structuredClone(doc);
    const result = changeSourceVersion(doc, 'remove', { url: 'https://example.test/updated.git', commit: 'd'.repeat(40), ref: 'main', refKind: 'branch' });
    expect(result.sources.find((source) => source.id === 'remove')).toMatchObject({ id: 'remove', repo: { url: 'https://example.test/updated.git', commit: 'd'.repeat(40), ref: 'main', refKind: 'branch' } });
    expect(result.sources.find((source) => source.id === 'remove')).not.toHaveProperty('artifactHash');
    expect(result.sources.find((source) => source.id === 'keep')).toEqual(before.sources.find((source) => source.id === 'keep'));
    assertClosed(result);
    expect(doc).toEqual(before);
  });
});
