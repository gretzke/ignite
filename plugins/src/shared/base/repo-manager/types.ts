import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type { NoParams, NoResult } from "../index.js";

export interface PathOptions {
  pathOrUrl: string;
}

export interface RepoCheckoutBranchOptions {
  branch: string;
}

export interface RepoCheckoutCommitOptions {
  commit: string;
}

export interface RepoGetBranchesResult {
  branches: string[];
}

export interface RepoInfoResult {
  branch: string | null;
  commit: string;
  dirty: boolean;
  upToDate: boolean;
}

export type RepoManagerOperations = {
  init: {
    params: PathOptions;
    result: NoResult;
  };
  checkoutBranch: {
    params: RepoCheckoutBranchOptions;
    result: NoResult;
  };
  checkoutCommit: {
    params: RepoCheckoutCommitOptions;
    result: NoResult;
  };
  getBranches: {
    params: NoParams;
    result: RepoGetBranchesResult;
  };
  pullChanges: {
    params: NoParams;
    result: NoResult;
  };
  getRepoInfo: {
    params: NoParams;
    result: RepoInfoResult;
  };
};

export type RepoManagerOperation = keyof RepoManagerOperations;

export type IRepoManagerPlugin = {
  type: PluginType.REPO_MANAGER;
} & {
  [K in keyof RepoManagerOperations]: (
    options: RepoManagerOperations[K]["params"],
  ) => Promise<PluginResponse<RepoManagerOperations[K]["result"]>>;
};
