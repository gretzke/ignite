// Local Repository Manager Plugin
import {
  RepoManagerPlugin,
  PluginType,
  type PluginMetadata,
  runPluginCLI,
  type RepoManagerOperation,
  PluginResponse,
  RepoGetBranchesResult,
  NoResult,
  NoParams,
} from "../../shared/index.ts";
import {
  ensureCleanRepo,
  ensureGitRepo,
  execGit,
  listAllRefs,
  getCurrentBranch,
  getCurrentCommit,
  isUpToDateWithRemote,
} from "../../shared/utils/git.ts";
import type {
  PathOptionsWithCredentials,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoInfoResult,
  GitCredentialsParams,
} from "../../shared/base/repo-manager/types.js";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class LocalRepoPlugin extends RepoManagerPlugin {
  public readonly type = PluginType.REPO_MANAGER as const;

  // Get repository URL for Git operations
  // For local repos, always return the remote URL
  protected async getRepoUrl(): Promise<string | null> {
    try {
      const result = await execGit(["remote", "get-url", "origin"]);
      return result.success ? result.data.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "local-repo",
      type: PluginType.REPO_MANAGER,
      name: "Local Repository Manager",
      version: PLUGIN_VERSION,
      baseImage: "ignite/base_repo-manager:latest",
    };
  }

  // No plugin-side operations - CLI handles all operations directly
  // This container just maintains the volume
  async init(
    options: PathOptionsWithCredentials,
  ): Promise<PluginResponse<NoResult>> {
    return this.withGitCredentials(options.gitCredentials, async () => {
      const ensured = await ensureGitRepo();
      if (!ensured.success) return ensured as any;
      return { success: true, data: {} } as const;
    });
  }

  async checkoutBranch(
    options: RepoCheckoutBranchOptions,
  ): Promise<PluginResponse<NoResult>> {
    return this.withGitCredentials(options.gitCredentials, async () => {
      const clean = await ensureCleanRepo();
      if (!clean.success) return clean as any;
      const fetchRes = await execGit(["fetch", "--all", "--prune"]);
      if (!fetchRes.success) return fetchRes as any;

      // Handle remote branch checkout by creating local tracking branch
      if (options.branch.startsWith("origin/")) {
        const localBranchName = options.branch.replace("origin/", "");

        // Check if local branch already exists
        const branchExists = await execGit([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${localBranchName}`,
        ]);

        if (branchExists.success) {
          // Local branch exists, just checkout
          const co = await execGit(["checkout", localBranchName]);
          if (!co.success) return co as any;
        } else {
          // Create new local tracking branch
          const co = await execGit([
            "checkout",
            "-b",
            localBranchName,
            options.branch,
          ]);
          if (!co.success) return co as any;
        }
      } else {
        // Regular branch checkout
        const co = await execGit(["checkout", options.branch]);
        if (!co.success) return co as any;
      }

      return { success: true, data: {} } as const;
    });
  }

  async checkoutCommit(
    options: RepoCheckoutCommitOptions,
  ): Promise<PluginResponse<NoResult>> {
    return this.withGitCredentials(options.gitCredentials, async () => {
      const clean = await ensureCleanRepo();
      if (!clean.success) return clean as any;
      const fetchRes = await execGit(["fetch", "--all", "--prune"]);
      if (!fetchRes.success) return fetchRes as any;
      const co = await execGit(["checkout", "--detach", options.commit]);
      if (!co.success) return co as any;
      return { success: true, data: {} } as const;
    });
  }

  async getBranches(
    _options: NoParams,
  ): Promise<PluginResponse<RepoGetBranchesResult>> {
    // getBranches doesn't need credentials - it's read-only local operation
    const ensured = await ensureGitRepo();
    if (!ensured.success) return ensured as any;
    const refs = await listAllRefs();
    if (!refs.success) return refs as any;
    return { success: true, data: { branches: refs.data } } as const;
  }

  async pullChanges(
    options: GitCredentialsParams,
  ): Promise<PluginResponse<NoResult>> {
    return this.withGitCredentials(options.gitCredentials, async () => {
      const clean = await ensureCleanRepo();
      if (!clean.success) return clean as any;
      const fetchRes = await execGit(["pull", "--ff-only"]);
      if (!fetchRes.success) return fetchRes as any;
      return { success: true, data: {} } as const;
    });
  }

  async getRepoInfo(
    options: GitCredentialsParams,
  ): Promise<PluginResponse<RepoInfoResult>> {
    return this.withGitCredentials(options.gitCredentials, async () => {
      const ensured = await ensureGitRepo();
      if (!ensured.success) return ensured as any;
      const [branch, commit] = await Promise.all([
        getCurrentBranch(),
        getCurrentCommit(),
      ]);
      if (!branch.success) return branch as any;
      if (!commit.success) return commit as any;

      const res = await execGit(["status", "--porcelain"]);
      if (!res.success) return res as any;
      const dirty = res.data.stdout.trim().length > 0;

      const up = await isUpToDateWithRemote();
      if (!up.success) return up as any;

      return {
        success: true,
        data: {
          branch: branch.data,
          commit: commit.data,
          dirty,
          upToDate: up.data,
        },
      } as const;
    });
  }
}

const plugin = new LocalRepoPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint
runPluginCLI<RepoManagerOperation>(plugin);
