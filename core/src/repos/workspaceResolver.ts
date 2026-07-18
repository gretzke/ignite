import type { ContractSource } from '@ignite/api';
import { RepoService } from './RepoService.js';
import { VersionStore } from './VersionStore.js';
import { IgniteError } from '../types/errors.js';

export interface ContractWorkspaceResolverDeps {
  repos: Pick<RepoService, 'resolveExistingWorkspacePath' | 'ensureVersion'> & Partial<Pick<RepoService, 'assertPinnedIntegrity'>>;
  versionStore: Pick<VersionStore, 'checkoutPath'>;
}

export async function resolveContractWorkspace(
  source: ContractSource,
  profileId: string,
  options: { verifyIntegrity?: boolean } = {},
  deps: ContractWorkspaceResolverDeps = {
    repos: RepoService.getInstance(),
    versionStore: new VersionStore(),
  }
): Promise<string> {
  // Contract-type sources are resolved by ContractTypeService before a
  // workspace is needed. Reaching this boundary is an internal routing bug.
  if (source.origin === 'contract-type') throw new IgniteError('Contract-type source reached workspace resolution', 'CONTRACT_TYPE_OP_FAILED');
  if (!source.pin) return deps.repos.resolveExistingWorkspacePath(source.repoPathOrUrl, profileId);
  const worktree = deps.versionStore.checkoutPath(source.pin.url, source.pin.commit);
  await deps.repos.ensureVersion(profileId, source.pin.url, source.pin.commit, {
    ref: source.pin.ref,
    refLabel: source.pin.ref,
    refKind: source.pin.refKind,
  });
  if (options.verifyIntegrity) {
    if (!deps.repos.assertPinnedIntegrity) throw Object.assign(new Error('Pinned integrity verification is unavailable'), { code: 'PINNED_INTEGRITY_UNAVAILABLE' });
    await deps.repos.assertPinnedIntegrity(worktree, source.pin.commit);
  }
  return worktree;
}
