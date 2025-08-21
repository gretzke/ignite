import path from 'path';
import { URL } from 'node:url';
import { hashWorkspacePath } from '../../utils/startup.js';
import { ProfileManager } from '../../filesystem/ProfileManager.js';

export enum RepoContainerKind {
  LOCAL = 'local',
  CLONED = 'cloned',
}

// Utility class for repository container operations
export class RepoContainerUtils {
  // Determine if a path/URL is local or cloned repository
  static deriveRepoKind(pathOrUrl: string): RepoContainerKind {
    // Windows paths like C:\...
    if (/^[A-Za-z]:\\/.test(pathOrUrl)) return RepoContainerKind.LOCAL;
    // Unix-like absolute or ~
    if (pathOrUrl.startsWith('/') || pathOrUrl.startsWith('~')) {
      return RepoContainerKind.LOCAL;
    }
    // SSH-like git@host:owner/repo(.git)?
    if (/^git@[^:]+:.+/.test(pathOrUrl)) return RepoContainerKind.CLONED;
    try {
      const u = new URL(pathOrUrl);
      if (u.protocol === 'file:') return RepoContainerKind.LOCAL;
      if (['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) {
        return RepoContainerKind.CLONED;
      }
    } catch {
      // Not a URL
    }
    // Fallback: if contains :// assume cloned, else local
    return pathOrUrl.includes('://')
      ? RepoContainerKind.CLONED
      : RepoContainerKind.LOCAL;
  }

  // Generate container name based on repo kind and path/URL
  static async deriveRepoContainerName(
    kind: RepoContainerKind,
    pathOrUrl: string,
    isSession = false
  ): Promise<string> {
    // Get current profile ID
    const profileManager = await ProfileManager.getInstance();
    const profileId = profileManager.getCurrentProfile();
    if (kind === RepoContainerKind.LOCAL) {
      const suffix = isSession ? '-session' : '';
      const hash = hashWorkspacePath(pathOrUrl);
      const repoName = path
        .basename(pathOrUrl)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      return `ignite-repo-local-${repoName}-${hash}-${profileId}${suffix}`;
    }
    // cloned
    let owner = 'unknown';
    let repo = 'repo';
    try {
      const u = new URL(pathOrUrl);
      const parts = u.pathname
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
      if (parts.length >= 2) {
        owner = parts[parts.length - 2]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-');
        repo = parts[parts.length - 1]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-');
      } else if (parts.length === 1) {
        repo = parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      }
    } catch {
      const base = pathOrUrl.split('/').filter(Boolean).pop() ?? 'repo';
      repo = base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    const hash = hashWorkspacePath(pathOrUrl);
    return `ignite-repo-cloned-${owner}-${repo}-${hash}-${profileId}`;
  }

  // Determine if a local path corresponds to the current CLI session workspace
  static isSessionLocal(kind: RepoContainerKind, pathOrUrl: string): boolean {
    if (kind !== RepoContainerKind.LOCAL) return false;
    const session = (process.env.IGNITE_WORKSPACE_PATH || '').trim();
    if (!session) return false;
    const normalizedA = path.resolve(session);
    const normalizedB = path.resolve(pathOrUrl);
    return normalizedA === normalizedB;
  }
}
