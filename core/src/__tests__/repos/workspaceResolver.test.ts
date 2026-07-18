import { describe, expect, it, vi } from 'vitest';
import type { ContractSource } from '@ignite/api';
import { resolveContractWorkspace } from '../../repos/workspaceResolver.js';

const base: ContractSource = {
  id: 'token', repoPathOrUrl: '/workspace', frameworkId: 'foundry',
  artifactPath: 'out/Token.json', contractName: 'Token', sourcePath: 'src/Token.sol',
};

describe('resolveContractWorkspace', () => {
  it('uses registered workspace resolution for unpinned sources', async () => {
    const resolveExistingWorkspacePath = vi.fn(async () => '/resolved');
    const result = await resolveContractWorkspace(base, 'p1', {}, {
      repos: { resolveExistingWorkspacePath, ensureVersion: vi.fn(), assertPinnedIntegrity: vi.fn() },
      versionStore: { checkoutPath: vi.fn() },
    });
    expect(result).toBe('/resolved');
    expect(resolveExistingWorkspacePath).toHaveBeenCalledWith('/workspace', 'p1');
  });

  it('materializes a pin through VersionStore and verifies integrity when requested', async () => {
    const source: ContractSource = { ...base, repoPathOrUrl: 'https://example.test/repo.git', pin: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40), ref: 'v1', refKind: 'tag' } };
    const assertPinnedIntegrity = vi.fn(async () => {});
    const result = await resolveContractWorkspace(source, 'p1', { verifyIntegrity: true }, {
      repos: { resolveExistingWorkspacePath: vi.fn(), ensureVersion: vi.fn(async () => ({ checkout: '/versions/repo/a' })), assertPinnedIntegrity },
      versionStore: { checkoutPath: vi.fn(() => '/versions/repo/a') },
    });
    expect(result).toBe('/versions/repo/a');
    expect(assertPinnedIntegrity).toHaveBeenCalledWith('/versions/repo/a', 'a'.repeat(40));
  });
});
