import { describe, expect, it } from 'vitest';
import {
  AddExplorerRequestSchema,
  ExplorerEntrySchema,
  ExplorerSelectionSchema,
  ListExplorersQuerySchema,
} from '../../../../shared/api/src/v1/explorers.js';
import {
  CreateVerificationRequestSchema,
  GuessArgsRequestSchema,
  VerificationTaskSchema,
} from '../../../../shared/api/src/v1/verifications.js';
import {
  CreateRunRequestSchema,
  ValidateDeploymentRequestSchema,
} from '../../../../shared/api/src/v1/deployments.js';

const contract = {
  id: 'token',
  repoPathOrUrl: '/repo',
  frameworkId: 'foundry',
  artifactPath: 'out/Token.sol/Token.json',
  contractName: 'Token',
  sourcePath: 'src/Token.sol',
};

describe('verification API schemas', () => {
  it('round-trips explorer entries and selection', () => {
    const entry = {
      id: 'manual:entry-1',
      chainId: 1,
      url: 'https://etherscan.io',
      source: 'manual' as const,
      verifierPluginId: 'etherscan',
      mappingSuggestion: 'blockscout',
      needsConfig: false,
      apiUrl: 'https://api.etherscan.io/v2/api',
      label: 'Etherscan',
    };

    expect(ExplorerEntrySchema.parse(entry)).toEqual(entry);
    expect(ExplorerSelectionSchema.parse({ '1': [entry.id] })).toEqual({
      '1': [entry.id],
    });
  });

  it('round-trips verification requests and task snapshots', () => {
    const task = {
      id: 'verification-1',
      chainId: 1,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      bundleHash: 'a'.repeat(64),
      encodedConstructorArgs: '0x1234',
      creationTxHash: '0x5678',
      explorer: {
        entryId: 'manual:entry-1',
        url: 'https://etherscan.io',
        apiUrl: 'https://api.etherscan.io/v2/api',
        verifierPluginId: 'etherscan',
        label: 'Etherscan',
      },
      explorerPageUrl:
        'https://etherscan.io/address/0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token' },
      status: 'queued' as const,
      attempts: [{ startedAt: '2026-07-11T00:00:00.000Z', outcome: 'queued' }],
      nextAttemptAt: '2026-07-11T00:01:00.000Z',
      detail: 'Waiting to submit',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    };

    expect(VerificationTaskSchema.parse(task)).toEqual(task);
    expect(
      CreateVerificationRequestSchema.parse({
        contract,
        chainId: 1,
        address: task.address,
        args: { supply: '1000' },
        explorerEntryIds: [task.explorer.entryId],
      }),
    ).toMatchObject({ contract, chainId: 1 });
    expect(
      GuessArgsRequestSchema.parse({
        contract,
        chainId: 1,
        address: task.address,
      }),
    ).toMatchObject({ contract, chainId: 1 });
  });

  it('accepts a confirmed contract-type verification request', () => {
    const contractType = { id: 'proxy', origin: 'contract-type' as const, contractName: 'ProxyAdmin', pluginId: 'ct', artifactKey: 'admin', versionLabel: 'v1', contentHash: 'a'.repeat(64) };
    expect(CreateVerificationRequestSchema.parse({ contract: contractType, chainId: 1, address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', confirmUnverifiedProvenance: true, explorerEntryIds: ['e'] })).toMatchObject({ contract: contractType, confirmUnverifiedProvenance: true });
  });

  it.each([
    () =>
      VerificationTaskSchema.parse({
        ...validTask(),
        status: 'not-a-status',
      }),
    () => ListExplorersQuerySchema.parse({ chainId: 'mainnet' }),
    () =>
      AddExplorerRequestSchema.parse({
        chainId: 1,
        url: 'https://user:secret@etherscan.io',
      }),
  ])('rejects invalid verification and explorer values', (parse) => {
    expect(parse).toThrow();
  });

  it('accepts explorer selection in both preview and launch requests', () => {
    const request = {
      plan: {
        schemaVersion: 1,
        contracts: [contract],
        steps: [{ id: 'deploy-token', kind: 'deploy' as const, contractId: 'token' }],
        chains: [1],
        signers: {},
      },
      rpcSelection: { '1': 'rpc-1' },
      explorerSelection: { '1': ['manual:entry-1'] },
    };

    expect(ValidateDeploymentRequestSchema.parse(request)).toEqual(request);
    expect(
      CreateRunRequestSchema.parse({
        ...request,
        name: 'Verify Token',
        idempotencyKey: 'key-1',
      }),
    ).toMatchObject(request);
  });
});

function validTask() {
  return {
    id: 'verification-1',
    chainId: 1,
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    bundleHash: 'a'.repeat(64),
    encodedConstructorArgs: '0x',
    explorer: {
      entryId: 'manual:entry-1',
      url: 'https://etherscan.io',
      verifierPluginId: 'etherscan',
      label: 'Etherscan',
    },
    origin: { kind: 'manual' as const },
    status: 'queued' as const,
    attempts: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}
