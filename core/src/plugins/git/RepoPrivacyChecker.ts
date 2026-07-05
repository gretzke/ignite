import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from '../../utils/logger.js';
import {
  normalizeRepoUrl,
  isGitHubUrl,
  parseGitHubUrl,
} from '@ignite/plugin-types';

const execFileAsync = promisify(execFile);

export interface RepoPrivacyInfo {
  repoUrl: string;
  isPublic: boolean | null;
  checkedAt: number;
  method: 'github_api' | 'git_test' | 'unknown';
}

interface RepoPrivacyCheckerDeps {
  fetchFn: typeof globalThis.fetch;
  // Resolves if anonymous ls-remote succeeded; rejects with the git error otherwise.
  lsRemote: (repoUrl: string) => Promise<unknown>;
  now: () => number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class RepoPrivacyChecker {
  private cache = new Map<string, RepoPrivacyInfo>();
  private deps: RepoPrivacyCheckerDeps;

  constructor(deps?: Partial<RepoPrivacyCheckerDeps>) {
    this.deps = {
      fetchFn: deps?.fetchFn ?? globalThis.fetch.bind(globalThis),
      lsRemote:
        deps?.lsRemote ??
        ((repoUrl: string) =>
          execFileAsync('git', ['ls-remote', '--heads', repoUrl], {
            timeout: 10000,
          })),
      now: deps?.now ?? Date.now,
    };
  }

  async isRepoPublic(repoUrl: string): Promise<boolean | null> {
    const normalizedUrl = normalizeRepoUrl(repoUrl);
    const cached = this.cache.get(normalizedUrl);
    if (cached && this.deps.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached.isPublic;
    }
    const isPublic = isGitHubUrl(normalizedUrl)
      ? await this.checkGitHubRepoPrivacy(normalizedUrl)
      : await this.checkRepoPrivacyWithGit(normalizedUrl);
    this.cache.set(normalizedUrl, {
      repoUrl: normalizedUrl,
      isPublic,
      checkedAt: this.deps.now(),
      method: isGitHubUrl(normalizedUrl) ? 'github_api' : 'git_test',
    });
    return isPublic;
  }

  // Moved from GitCredentialManager.checkGitHubRepoPrivacy (788-837);
  // globalThis.fetch -> this.deps.fetchFn, parseGitHubUrl now imported.
  private async checkGitHubRepoPrivacy(
    repoUrl: string
  ): Promise<boolean | null> {
    const logger = getLogger();
    try {
      const githubRepo = parseGitHubUrl(repoUrl);
      if (!githubRepo) {
        logger.debug('Could not parse GitHub URL');
        return null;
      }
      const apiUrl = `https://api.github.com/repos/${githubRepo.owner}/${githubRepo.name}`;
      const controller = new globalThis.AbortController();
      const timeoutId = globalThis.setTimeout(() => controller.abort(), 5000);
      const response = await this.deps.fetchFn(apiUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ignite-cli' },
      });
      globalThis.clearTimeout(timeoutId);
      if (response.status === 404) {
        // Could be private repo or doesn't exist
        return false;
      }
      if (response.ok) {
        const data = (await response.json()) as { private: boolean };
        return !data.private;
      }
      logger.debug(`GitHub API returned status: ${response.status}`);
      return null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('GitHub API request timed out');
      } else {
        logger.debug(
          `GitHub API error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  // Moved from GitCredentialManager.checkRepoPrivacyWithGit (856-896);
  // the anonymous ls-remote probe now goes through this.deps.lsRemote.
  private async checkRepoPrivacyWithGit(
    repoUrl: string
  ): Promise<boolean | null> {
    const logger = getLogger();
    try {
      await this.deps.lsRemote(repoUrl);
      // Anonymous access succeeded -> public
      return true;
    } catch (error) {
      const errorMessage =
        (error as { stderr?: string; message?: string }).stderr ||
        (error instanceof Error ? error.message : String(error));
      if (
        errorMessage.includes('Authentication failed') ||
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('could not read')
      ) {
        // Authentication required = private repo
        return false;
      }
      if (
        errorMessage.includes('not found') ||
        errorMessage.includes('does not exist')
      ) {
        logger.debug(`Repository not found: ${repoUrl}`);
        return null;
      }
      logger.debug(`Git ls-remote error: ${errorMessage}`);
      return null;
    }
  }
}
