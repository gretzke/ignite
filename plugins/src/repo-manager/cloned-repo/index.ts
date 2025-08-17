// Cloned Repository Manager Plugin
import {
  PathOptions,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
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
  async init(options: PathOptions): Promise<PluginResponse<NoResult>> {
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
  }

  async checkoutBranch(
    options: RepoCheckoutBranchOptions,
  ): Promise<PluginResponse<NoResult>> {
    const ensured = await ensureGitRepo();
    if (!ensured.success) return ensured as any;
    const fetchRes = await execGit(["fetch", "--all", "--prune"]);
    if (!fetchRes.success) return fetchRes as any;
    const reset = await execGit(["reset", "--hard"]);
    if (!reset.success) return reset as any;
    const co = await execGit(["checkout", options.branch]);
    if (!co.success) return co as any;
    return { success: true, data: {} } as const;
  }

  async checkoutCommit(
    options: RepoCheckoutCommitOptions,
  ): Promise<PluginResponse<NoResult>> {
    const ensured = await ensureGitRepo();
    if (!ensured.success) return ensured as any;
    const fetchRes = await execGit(["fetch", "--all", "--prune"]);
    if (!fetchRes.success) return fetchRes as any;
    const reset = await execGit(["reset", "--hard"]);
    if (!reset.success) return reset as any;
    const co = await execGit(["checkout", "--detach", options.commit]);
    if (!co.success) return co as any;
    return { success: true, data: {} } as const;
  }

  async getBranches(
    _options: NoParams,
  ): Promise<PluginResponse<RepoGetBranchesResult>> {
    const ensured = await ensureGitRepo();
    if (!ensured.success) return ensured as any;
    const refs = await listAllRefs();
    if (!refs.success) return refs as any;
    return { success: true, data: { branches: refs.data } } as const;
  }

  async pullChanges(_options: NoParams): Promise<PluginResponse<NoResult>> {
    const ensured = await ensureGitRepo();
    if (!ensured.success) return ensured as any;
    const pull = await execGit(["pull", "--ff-only"]);
    if (!pull.success) return pull as any;
    return { success: true, data: {} } as const;
  }

  async getRepoInfo(
    _options: NoParams,
  ): Promise<PluginResponse<RepoInfoResult>> {
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
        dirty: false,
        upToDate: up.data,
      },
    } as const;
  }
}

const plugin = new ClonedRepoPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint
console.log(`📁 Cloned repo container ready at: /workspace`);
runPluginCLI<RepoManagerOperation>(plugin);
