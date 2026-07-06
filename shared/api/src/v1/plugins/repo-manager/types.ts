// API-request types for repo-manager operations
// Plugins do not see pathOrUrl – it's handler-only, carried by API requests

import { PathOptions } from "@ignite/plugin-types";

export interface CheckoutBranchRequest extends PathOptions {
  branch: string;
}

export interface CheckoutCommitRequest extends PathOptions {
  commit: string;
}

export interface GetFileRequest extends PathOptions {
  filePath: string;
}

// API-response types — previously re-exported from the (now-deleted)
// containerized repo-manager plugin's base types; RepoService is the sole
// producer now, so these live here as the shared wire contract.
export interface RepoGetBranchesResult {
  branches: string[];
}

export interface RepoInfoResult {
  branch: string | null;
  commit: string;
  dirty: boolean;
  upToDate: boolean;
}

export interface RepoGetFileResult {
  content: string;
}

// Result of a fingerprint drift check: lifecycle recompile jobs started for
// repos whose sources/config changed since their last compile.
export interface RepoCheckResult {
  started: Array<{ pathOrUrl: string; jobId: string }>;
}
