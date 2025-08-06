import { PluginType } from "../../types.js";
import type { PluginResult } from "../../types.js";

export type RepoManagerOperations = {
  // Empty - CLI handles all operations directly
  // Operations like mount/unmount are implemented as handler methods, not plugin operations
};

export type RepoManagerOperation = keyof RepoManagerOperations;

export type IRepoManagerPlugin = {
  type: PluginType.REPO_MANAGER;
} & {
  [K in keyof RepoManagerOperations]: (
    options: RepoManagerOperations[K]["params"],
  ) => Promise<PluginResult<RepoManagerOperations[K]["result"]>>;
};
