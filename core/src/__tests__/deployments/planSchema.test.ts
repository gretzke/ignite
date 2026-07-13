import { describe, expect, it } from 'vitest';
import { DeploymentPlanSchema, FrozenInputSchema, PrepareStepRequestSchema, RunRecordSchema, allowedActions } from '@ignite/api';
import { renderArtifact } from '../../deployments/artifact.js';

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

describe('D3-era record compatibility (final-review F19)', () => {
  // A pristine pre-D5 run record: deploy-only steps, no strategy/libraries/
  // expected/predictedAddress, artifact-era attempt shape. Widening must keep
  // this parsing forever and the artifact must regenerate deterministically.
  const d3Record = {
    schemaVersion: 1,
    id: 'run-d3',
    profileId: 'p1',
    name: 'legacy run',
    idempotencyKey: 'k1',
    createdAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-10T12:05:00.000Z',
    plan: {
      schemaVersion: 1,
      contracts: [
        {
          id: 'token',
          repoPathOrUrl: '/home/user/repo',
          frameworkId: 'foundry',
          artifactPath: 'out/Token.sol/Token.json',
          contractName: 'Token',
          sourcePath: 'src/Token.sol',
        },
      ],
      steps: [{ id: 's1', kind: 'deploy', contractId: 'token' }],
      chains: [31337],
      signers: {
        global: {
          pluginId: 'private-key',
          accountId: 'a1',
          address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        },
      },
    },
    inputs: {
      token: {
        abi: [],
        creationBytecode: '0x6000',
        compiler: { pluginId: 'foundry', version: '1.0.0', settingsHash: 'a'.repeat(64) },
        artifactHash: 'b'.repeat(64),
        repoDirty: false,
      },
    },
    rpcSelection: {
      '31337': { endpointId: 'rpc1', label: 'Anvil', urlFingerprint: 'c'.repeat(64) },
    },
    validation: {
      chains: {
        '31337': {
          rpc: { ok: true, blocking: false, message: 'ok' },
          signers: { ok: true, blocking: false, message: 'ok' },
          args: { ok: true, blocking: false, message: 'ok' },
          estimation: { ok: true, blocking: false, message: 'ok' },
          balance: { ok: true, blocking: false, message: 'ok' },
          inputs: { ok: true, blocking: false, message: 'ok' },
        },
      },
    },
    lanes: {
      '31337': {
        chainId: 31337,
        status: 'completed',
        currentStepIndex: 1,
        steps: [
          {
            stepId: 's1',
            status: 'confirmed',
            address: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
            attempts: [
              {
                id: 'att1',
                startedAt: '2026-07-10T12:01:00.000Z',
                endedAt: '2026-07-10T12:02:00.000Z',
                txHash: `0x${'d'.repeat(64)}`,
                nonce: 0,
                gasUsed: '100000',
                effectiveGasPrice: '1000000000',
                blockNumber: 1,
                txStatus: 'success',
              },
            ],
          },
        ],
      },
    },
    status: 'completed',
  };

  it('parses a pristine D3 run record under the widened schema', () => {
    expect(() => RunRecordSchema.parse(d3Record)).not.toThrow();
  });

  it('regenerates the legacy artifact deterministically as v2 with optionals absent', () => {
    const record = RunRecordSchema.parse(d3Record);
    const artifact = renderArtifact(record);
    expect(artifact.schemaVersion).toBe(2);
    const step = artifact.lanes['31337'].steps[0];
    expect(step).not.toHaveProperty('pointers');
    expect(step).not.toHaveProperty('call');
    expect(step).not.toHaveProperty('libraries');
    expect(artifact.lanes['31337']).not.toHaveProperty('simulationTier');
    // No timestamps/randomness enter rendering: byte-identical regeneration.
    expect(JSON.stringify(renderArtifact(structuredClone(record)))).toBe(JSON.stringify(artifact));
  });
});
