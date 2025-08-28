import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type { NoParams, NoResult } from "../index.js";
import type { PathOptions } from "../../types.js";

// SSH credentials for Git operations
export interface GitCredentials {
  type: "ssh";
  privateKey: string;
  publicKey: string;
}

export interface GitCredentialsParams {
  gitCredentials?: GitCredentials; // For operations that might need authentication
}

// Extended path options that can include credentials (injected by CLI)
export interface PathOptionsWithCredentials
  extends PathOptions,
    GitCredentialsParams {}

export interface RepoCheckoutBranchOptions {
  branch: string;
  gitCredentials?: GitCredentials; // For operations that might need authentication
}

export interface RepoCheckoutCommitOptions {
  commit: string;
  gitCredentials?: GitCredentials; // For operations that might need authentication
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

export interface RepoGetFileOptions {
  filePath: string; // Relative path from repository root
}

export interface RepoGetFileResult {
  content: string;
}

export type RepoManagerOperations = {
  init: {
    params: PathOptionsWithCredentials;
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
    params: GitCredentialsParams;
    result: NoResult;
  };
  getRepoInfo: {
    params: GitCredentialsParams;
    result: RepoInfoResult;
  };
  getFile: {
    params: RepoGetFileOptions;
    result: RepoGetFileResult;
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
