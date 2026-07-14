import type { ContractSource } from '@ignite/api';
import { RepoService } from './RepoService.js';
import { PinnedStore } from './PinnedStore.js';

export interface ContractWorkspaceResolverDeps {
  repos: Pick<RepoService, 'resolveExistingWorkspacePath'> & Partial<Pick<RepoService, 'assertPinnedIntegrity'>>;
  pinnedStore: Pick<PinnedStore, 'worktreePath'>;
}

export async function resolveContractWorkspace(
  source: ContractSource,
  profileId: string,
  options: { verifyIntegrity?: boolean } = {},
  deps: ContractWorkspaceResolverDeps = {
    repos: RepoService.getInstance(),
    pinnedStore: new PinnedStore(),
  }
): Promise<string> {
  if (!source.pin) return deps.repos.resolveExistingWorkspacePath(source.repoPathOrUrl, profileId);
  const worktree = deps.pinnedStore.worktreePath(profileId, source.pin.url, source.pin.commit);
  if (options.verifyIntegrity) {
    if (!deps.repos.assertPinnedIntegrity) throw Object.assign(new Error('Pinned integrity verification is unavailable'), { code: 'PINNED_INTEGRITY_UNAVAILABLE' });
    await deps.repos.assertPinnedIntegrity(worktree, source.pin.commit);
  }
  return worktree;
}
