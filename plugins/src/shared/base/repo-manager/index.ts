import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type { IRepoManagerPlugin } from "./types.js";

export abstract class RepoManagerPlugin
  extends BasePlugin<PluginType.REPO_MANAGER>
  implements IRepoManagerPlugin
{
  public readonly type = PluginType.REPO_MANAGER as const;

  // CLI handles mounting - no abstract methods needed for now
}

// Re-export types for convenience
export type {
  RepoManagerOperations,
  RepoManagerOperation,
  IRepoManagerPlugin,
} from "./types.js";
