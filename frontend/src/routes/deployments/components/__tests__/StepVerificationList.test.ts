// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RunRecord, VerificationTask } from '@ignite/api';
import {
  collapseVerificationTasks,
  verificationExplorerRows,
  verificationListState,
  verificationStatusPresentation,
  verificationTaskAction,
  verifyNowLink,
} from '../StepVerificationList';

function task(overrides: Partial<VerificationTask> = {}): VerificationTask {
  return {
    id: 'task-1',
    chainId: 1,
    address: '0x0000000000000000000000000000000000000001',
    bundleHash: 'bundle',
    encodedConstructorArgs: '0x',
    explorer: {
      entryId: 'etherscan',
      url: 'https://etherscan.io',
      verifierPluginId: 'etherscan',
      label: 'Etherscan',
    },
    origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token' },
    status: 'verified',
    attempts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(): RunRecord {
  return {
    id: 'run-1',
    plan: {
      chains: [1, 2],
      contracts: [
        {
          id: 'token',
          repoPathOrUrl: '/repo',
          frameworkId: 'foundry',
          artifactPath: 'out/Token.json',
          contractName: 'Token',
          sourcePath: 'src/Token.sol',
        },
        {
          id: 'vault',
          repoPathOrUrl: '/repo',
          frameworkId: 'foundry',
          artifactPath: 'out/Vault.json',
          contractName: 'Vault',
          sourcePath: 'src/Vault.sol',
        },
      ],
      steps: [
        { id: 'deploy-token', kind: 'deploy', contractId: 'token' },
        { id: 'deploy-vault', kind: 'deploy', contractId: 'vault' },
      ],
      signers: {},
      schemaVersion: 1,
    },
    lanes: {
      '1': {
        chainId: 1,
        status: 'completed',
        currentStepIndex: 2,
        steps: [
          {
            stepId: 'deploy-token',
            status: 'confirmed',
            attempts: [],
            address: '0x0000000000000000000000000000000000000001',
          },
          {
            stepId: 'deploy-vault',
            status: 'confirmed',
            attempts: [],
            address: '0x0000000000000000000000000000000000000002',
          },
        ],
      },
      '2': {
        chainId: 2,
        status: 'pending',
        currentStepIndex: 0,
        steps: [
          { stepId: 'deploy-token', status: 'pending', attempts: [] },
          { stepId: 'deploy-vault', status: 'pending', attempts: [] },
        ],
      },
    },
  } as unknown as RunRecord;
}

describe('StepVerificationList helpers', () => {
  it('maps terminal and live statuses to their visual tiers', () => {
    expect(verificationStatusPresentation('polling').animated).toBe(true);
    expect(verificationStatusPresentation('verified').className).toContain(
      'chip-ok'
    );
    expect(
      verificationStatusPresentation('already-verified').className
    ).toContain('chip-ok');
    expect(verificationStatusPresentation('failed').className).toContain(
      'chip-err'
    );
  });

  it('collapses to the newest explorer attempt and never makes superseded tasks actionable', () => {
    const newest = task({
      id: 'newest',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    expect(collapseVerificationTasks([task(), newest])).toEqual([newest]);
    expect(verificationTaskAction('superseded')).toBeUndefined();
    expect(verificationTaskAction('failed')).toBe('retry');
    expect(verificationTaskAction('polling')).toBe('cancel');
  });

  it('uses the exact loading and waiting state matrix', () => {
    const base = {
      tasks: [] as VerificationTask[],
      laneStatus: 'running' as const,
      stepStatus: 'pending' as const,
      alreadyDeployed: false,
    };
    expect(verificationListState({ ...base, tasksLoaded: false })).toBe(
      'loading'
    );
    expect(verificationListState({ ...base, tasksLoaded: true })).toBe(
      'waiting-deployment'
    );
    expect(
      verificationListState({
        ...base,
        tasksLoaded: true,
        address: task().address,
      })
    ).toBe('waiting-verification');
    expect(
      verificationListState({
        ...base,
        tasksLoaded: true,
        address: task().address,
        laneStatus: 'completed',
      })
    ).toBe('not-verified');
    expect(
      verificationListState({
        ...base,
        tasksLoaded: true,
        address: task().address,
        alreadyDeployed: true,
      })
    ).toBe('adopted');
    expect(
      verificationListState({
        ...base,
        tasksLoaded: true,
        stepStatus: 'failed',
      })
    ).toBe('none');
    expect(
      verificationListState({
        ...base,
        tasksLoaded: true,
        laneStatus: 'aborted',
      })
    ).toBe('none');
  });

  it('scopes Verify now to its exact step without falling back', () => {
    const tokenLink = verifyNowLink(run(), 1, 'deploy-token');
    const vaultLink = verifyNowLink(run(), 1, 'deploy-vault');
    expect(tokenLink).toContain(
      'address=0x0000000000000000000000000000000000000001'
    );
    expect(tokenLink).toContain('contractId=token');
    expect(vaultLink).toContain(
      'address=0x0000000000000000000000000000000000000002'
    );
    expect(vaultLink).toContain('contractId=vault');
    expect(tokenLink).not.toBe(vaultLink);
    expect(verifyNowLink(run(), 1)).toBe('/verify?runId=run-1&chainId=1');
    expect(verifyNowLink(run(), 1, 'missing')).toBe(
      '/verify?runId=run-1&chainId=1'
    );
    expect(verifyNowLink(run(), 2)).toBe('/verify?runId=run-1&chainId=2');
    expect(verifyNowLink(run(), 2, 'deploy-token')).toBe(
      '/verify?runId=run-1&chainId=2'
    );
  });

  it('keeps missing explorer targets visible while a lane is active', () => {
    const targets = [
      task().explorer,
      { ...task().explorer, entryId: 'blockscout', label: 'Blockscout' },
    ];
    expect(
      verificationExplorerRows([task()], targets, 'running').map(
        (row) => row.kind
      )
    ).toEqual(['task', 'waiting-verification']);
  });

  it('marks missing explorer targets unverified when a lane is terminal', () => {
    const targets = [
      task().explorer,
      { ...task().explorer, entryId: 'blockscout', label: 'Blockscout' },
    ];
    expect(
      verificationExplorerRows([task()], targets, 'completed').map(
        (row) => row.kind
      )
    ).toEqual(['task', 'not-verified']);
  });

  it('retains tasks whose explorer is no longer a current target', () => {
    const rows = verificationExplorerRows([task()], [], 'completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'task', task: { id: 'task-1' } });
  });
});
