// Cloned Repository Manager Plugin
import {
  PathOptionsWithCredentials,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
  GitCredentialsParams,
} from "../../shared/base/repo-manager/types.ts";
import {
  RepoManagerPlugin,
  PluginType,
  type PluginMetadata,
  runPluginCLI,
  type RepoManagerOperation,
  PluginResponse,
  NoResult,
  NoParams,
} from "../../shared/index.ts";
import {
  ensureGitRepo,
  execGit,
  listAllRefs,
  getCurrentBranch,
  getCurrentCommit,
  isUpToDateWithRemote,
} from "../../shared/utils/git.ts";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class ClonedRepoPlugin extends RepoManagerPlugin {
  public readonly type = PluginType.REPO_MANAGER as const;

  // Store the pathOrUrl during init for URL conversion
  private initPathOrUrl: string | null = null;

  // Get repository URL for Git operations
  // During init: return the pathOrUrl being cloned
  // After init: return the remote URL from the cloned repo
  protected async getRepoUrl(): Promise<string | null> {
    // During init, return the URL we're cloning from
    if (this.initPathOrUrl) {
      return this.initPathOrUrl;
    }

    // After init, get remote URL from the cloned repository
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
      id: "cloned-repo",
      type: PluginType.REPO_MANAGER,
      name: "Cloned Repository Manager",
      version: PLUGIN_VERSION,
      baseImage: "ignite/base_repo-manager:latest",
    };
  }

  // No plugin-side operations - CLI handles all operations directly
  // This container just maintains the volume
  async init(
    options: PathOptionsWithCredentials,
  ): Promise<PluginResponse<NoResult>> {
    // Store pathOrUrl for URL conversion during init
    this.initPathOrUrl = options.pathOrUrl;

    try {
      return await this.withGitCredentials(options.gitCredentials, async () => {
        // path is a Git URL here
        const hasRepo = await ensureGitRepo();
        if (hasRepo.success) {
          return { success: true, data: {} } as const;
        }

        const clone = await execGit([
          "clone",
          "--depth",
          "1",
          "--recurse-submodules",
          "--shallow-submodules",
          options.pathOrUrl,
          "/workspace",
        ]);

        if (clone.success) {
          await execGit([
            "fetch",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
          ]);
        }

        if (!clone.success) {
          return {
            success: false,
            error: {
              code: "CLONE_FAILED",
              message: `Failed to clone repository: ${
                clone.error?.message || "Unknown error"
              }`,
              details: clone.error?.details,
            },
          } as const;
        }
        return { success: true, data: {} } as const;
      });
    } finally {
      // Clear the init URL after init is complete
      this.initPathOrUrl = null;
    }
  }

  async checkoutBranch(
    options: RepoCheckoutBranchOptions,
  ): Promise<PluginResponse<NoResult>> {
    return this.withGitCredentials(options.gitCredentials, async () => {
      const ensured = await ensureGitRepo();
      if (!ensured.success) return ensured as any;
      const fetchRes = await execGit(["fetch", "--all", "--prune"]);
      if (!fetchRes.success) return fetchRes as any;
      const reset = await execGit(["reset", "--hard"]);
      if (!reset.success) return reset as any;

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
      const ensured = await ensureGitRepo();
      if (!ensured.success) return ensured as any;
      const fetchRes = await execGit(["fetch", "--all", "--prune"]);
      if (!fetchRes.success) return fetchRes as any;
      const reset = await execGit(["reset", "--hard"]);
      if (!reset.success) return reset as any;
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
      const ensured = await ensureGitRepo();
      if (!ensured.success) return ensured as any;
      const pull = await execGit(["pull", "--ff-only"]);
      if (!pull.success) return pull as any;
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
      const up = await isUpToDateWithRemote();
      if (!up.success) return up as any;

      return {
        success: true,
        data: {
          branch: branch.data,
          commit: commit.data,
          dirty: false, // Cloned repos are never dirty (reset --hard)
          upToDate: up.data,
        },
      } as const;
    });
  }
}

const plugin = new ClonedRepoPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint
runPluginCLI<RepoManagerOperation>(plugin);
