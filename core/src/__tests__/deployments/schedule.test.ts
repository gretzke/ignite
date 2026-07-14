import { describe, expect, it } from 'vitest';
import type { DeploymentPlan, FrozenInputs } from '@ignite/api';
import { getContractAddress } from 'viem';
import { CREATE2_PROXY_ADDRESS } from '@ignite/api';
import { buildRuntimeCode, buildSchedule, computeCreateAddresses } from '../../deployments/schedule.js';

const from = '0x0000000000000000000000000000000000000001' as const;
const plan: DeploymentPlan = { schemaVersion: 1, contracts: [{ id: 'c', repoPathOrUrl: '/repo', frameworkId: 'f', artifactPath: 'x', contractName: 'C', sourcePath: 'C.sol' }], chains: [1], signers: { global: { pluginId: 'p', accountId: 'a', address: from } }, steps: [{ id: 'create', kind: 'deploy', contractId: 'c' }] };
const frozen: FrozenInputs = { c: { abi: [], creationBytecode: '0x6000', compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) }, artifactHash: 'a'.repeat(64), repoDirty: false } };

describe('execution schedule', () => {
  it('pre-computes plain-create addresses before encoding the schedule', () => {
    const addresses = computeCreateAddresses(plan, frozen, 1, new Map([['create', from]]), new Map([[from, 7]]));
    const entries = buildSchedule(plan, frozen, 1, { signers: new Map([['create', from]]), createAddresses: addresses });
    expect(addresses.get('create')).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(entries).toMatchObject([{ stepId: 'create', kind: 'tx', from, to: null, address: addresses.get('create') }]);
  });

  it('advances the signer nonce for every scheduled tx, not only plain creates', () => {
    // create (nonce 7) -> call (nonce 8) -> create (nonce 9): the second
    // create's address must derive from nonce 9, or simulation-time pointer
    // resolution diverges from what actually executes.
    const mixed: DeploymentPlan = {
      ...plan,
      contracts: [...plan.contracts, { id: 'c2', repoPathOrUrl: '/repo', frameworkId: 'f', artifactPath: 'y', contractName: 'D', sourcePath: 'D.sol' }],
      steps: [
        { id: 'first', kind: 'deploy', contractId: 'c' },
        { id: 'ping', kind: 'call', target: { kind: 'step', stepId: 'first' }, signature: 'ping()', payable: false },
        { id: 'second', kind: 'deploy', contractId: 'c2' },
      ],
    };
    const mixedFrozen: FrozenInputs = { ...frozen, c2: frozen.c };
    const signers = new Map<string, `0x${string}`>([['first', from], ['ping', from], ['second', from]]);
    const addresses = computeCreateAddresses(mixed, mixedFrozen, 1, signers, new Map([[from, 7]]));
    expect(addresses.get('first')).toBe(getContractAddress({ from, nonce: 7n }));
    expect(addresses.get('second')).toBe(getContractAddress({ from, nonce: 9n }));
  });

  it('skipped-existing steps consume no nonce', () => {
    const addresses = computeCreateAddresses(plan, frozen, 1, new Map([['create', from]]), new Map([[from, 3]]), new Set(['create']));
    expect(addresses.size).toBe(0);
  });

  it('create2 tx entries target the canonical proxy', () => {
    const salt = `0x${'11'.repeat(32)}` as const;
    const c2plan: DeploymentPlan = { ...plan, steps: [{ id: 'create', kind: 'deploy', contractId: 'c', strategy: { kind: 'create2', salt } }] };
    const [entry] = buildSchedule(c2plan, frozen, 1, { signers: new Map([['create', from]]) });
    expect(entry).toMatchObject({ kind: 'tx', to: CREATE2_PROXY_ADDRESS });
    expect(entry.predictedAddress).toMatch(/^0x[0-9a-f]{40}$/i);
  });

  it('builds runtime code per chain without leaking creation-only library bindings', () => {
    const step = { id: 'create', kind: 'deploy' as const, contractId: 'c', libraries: { 'src/R.sol:R': { kind: 'address' as const, address: '0x0000000000000000000000000000000000000002' as const }, 'src/C.sol:C': { kind: 'address' as const, address: '0x0000000000000000000000000000000000000003' as const } } };
    const refs = { 'src/R.sol': { R: [{ start: 1, length: 20 }] } };
    const linked: FrozenInputs['c'] = { ...frozen.c, runtimeBytecode: `0x60${'zz'.repeat(20)}00`, runtimeBytecodeLinkReferences: refs };
    expect(buildRuntimeCode(step, linked, 1, () => { throw new Error('unexpected'); })).toBe(`0x60${'0000000000000000000000000000000000000002'}00`);
    expect(buildRuntimeCode(step, { ...linked, runtimeBytecode: undefined }, 1, () => { throw new Error('unexpected'); })).toBeUndefined();
    expect(buildRuntimeCode(step, { ...linked, runtimeBytecode: '0x6000', runtimeBytecodeLinkReferences: undefined }, 1, () => { throw new Error('unexpected'); })).toBe('0x6000');
    expect(buildRuntimeCode({ ...step, libraries: {} }, linked, 1, () => { throw new Error('unexpected'); })).toBeUndefined();
  });
});
