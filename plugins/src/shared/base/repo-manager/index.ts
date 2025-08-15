import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import { NoParams, NoResult } from "../index.js";
import type {
  IRepoManagerPlugin,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
  PathOptions,
} from "./types.js";

export abstract class RepoManagerPlugin
  extends BasePlugin<PluginType.REPO_MANAGER>
  implements IRepoManagerPlugin
{
  public readonly type = PluginType.REPO_MANAGER as const;

  // Temporary no-op implementations to satisfy executor typing.
  // Concrete plugins will implement real logic in the next step.
  abstract init(_options: PathOptions): Promise<PluginResponse<NoResult>>;

  abstract checkoutBranch(
    _options: RepoCheckoutBranchOptions,
  ): Promise<PluginResponse<NoResult>>;

  abstract checkoutCommit(
    _options: RepoCheckoutCommitOptions,
  ): Promise<PluginResponse<NoResult>>;

  abstract getBranches(
    _options: NoParams,
  ): Promise<PluginResponse<RepoGetBranchesResult>>;

  abstract pullChanges(_options: NoParams): Promise<PluginResponse<NoResult>>;

  abstract getRepoInfo(
    _options: NoParams,
  ): Promise<PluginResponse<RepoInfoResult>>;
}

// Re-export types for convenience
export type {
  PathOptions,
  RepoManagerOperations,
  RepoManagerOperation,
  IRepoManagerPlugin,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
} from "./types.js";
