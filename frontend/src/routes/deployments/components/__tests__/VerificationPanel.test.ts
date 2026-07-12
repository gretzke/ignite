// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RunRecord, VerificationTask } from '@ignite/api';
import {
  verificationStatusPresentation,
  verifyNowLink,
  waitingExplorerTargets,
} from '../VerificationPanel';

describe('VerificationPanel', () => {
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

  it('prefills Verify now with a confirmed contract address', () => {
    const run = {
      id: 'run-1',
      plan: {
        chains: [1],
        contracts: [
          {
            id: 'token',
            repoPathOrUrl: '/repo',
            frameworkId: 'foundry',
            artifactPath: 'out/Token.json',
            contractName: 'Token',
            sourcePath: 'src/Token.sol',
          },
        ],
        steps: [{ id: 'deploy-token', kind: 'deploy', contractId: 'token' }],
        signers: {},
        schemaVersion: 1,
      },
      lanes: {
        '1': {
          chainId: 1,
          status: 'completed',
          currentStepIndex: 1,
          steps: [
            {
              stepId: 'deploy-token',
              status: 'confirmed',
              attempts: [],
              address: '0x0000000000000000000000000000000000000001',
            },
          ],
        },
      },
    } as unknown as RunRecord;
    expect(verifyNowLink(run)).toContain(
      'address=0x0000000000000000000000000000000000000001'
    );
    expect(verifyNowLink(run)).toContain('contractId=token');
  });

  it('keeps frozen explorer targets visible until their tasks arrive', () => {
    const run = {
      plan: { chains: [1] },
      explorerTargets: {
        '1': [
          {
            entryId: 'blockscout',
            url: 'https://eth-sepolia.blockscout.com',
            verifierPluginId: 'blockscout',
            label: 'Blockscout',
          },
          {
            entryId: 'etherscan',
            url: 'https://sepolia.etherscan.io',
            verifierPluginId: 'etherscan',
            label: 'Etherscan',
          },
        ],
      },
    } as unknown as RunRecord;
    const tasks = [
      { explorer: { entryId: 'etherscan' } },
    ] as unknown as VerificationTask[];

    expect(waitingExplorerTargets(run, tasks)).toEqual([
      run.explorerTargets!['1'][0],
    ]);
  });
});
