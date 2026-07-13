import { describe, expect, it } from 'vitest';
import { DeploymentPlanSchema, FrozenInputSchema, PrepareStepRequestSchema, allowedActions } from '@ignite/api';

const address = '0x0000000000000000000000000000000000000001';
const salt = `0x${'11'.repeat(32)}`;
const contract = { id: 'c', repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: 'out/C.json', contractName: 'C', sourcePath: 'src/C.sol' };

describe('D5 plan wire schema', () => {
  it('keeps D3 deploy plans parseable and accepts calls, refs, and strategies', () => {
    const d3 = { schemaVersion: 1, contracts: [contract], steps: [{ id: 'deploy', kind: 'deploy', contractId: 'c' }], chains: [1], signers: {} };
    expect(DeploymentPlanSchema.parse(d3)).toEqual(d3);
    const d5 = { ...d3, steps: [
      { id: 'deploy', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt }, libraries: { 'src/L.sol:L': { kind: 'address', address } } },
      { id: 'call', kind: 'call', target: { kind: 'step', stepId: 'deploy' }, signature: 'setOwner(address)', payable: false, args: { owner: { $ref: { kind: 'step', stepId: 'deploy' } } } },
    ] };
    expect(DeploymentPlanSchema.parse(d5)).toEqual(d5);
  });
  it('makes prepare context server-authoritative and validates persisted unlinked bytecode containment', () => {
    expect(PrepareStepRequestSchema.parse({ contracts: [contract], steps: [{ id: 'deploy', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt } }], stepId: 'deploy', chainIds: [1] }).stepId).toBe('deploy');
    expect(() => FrozenInputSchema.parse({ abi: [], creationBytecode: '0x60zz', creationCodeLinkReferences: { 'src/L.sol': { L: [{ start: 0, length: 20 }] } }, compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) }, artifactHash: 'a'.repeat(64), repoDirty: false })).toThrow();
  });
  it('exposes collision verbs and suppresses unknown-hash confirmation without intent', () => {
    expect(allowedActions({ reason: 'create2-collision', capability: 'sign-and-send', submitted: false, hasIntent: false })).toEqual(['accept-deployed', 'retry', 'skip', 'abort-lane']);
    expect(allowedActions({ reason: 'needs-review', capability: 'sign-and-send', submitted: false, hasIntent: false })).not.toContain('confirm-hash');
  });
});
