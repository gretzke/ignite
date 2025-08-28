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

// API-response types reuse plugin operation results
import type {
  RepoGetBranchesResult,
  RepoInfoResult,
  RepoGetFileResult,
} from "@ignite/plugin-types/base/repo-manager";

export type { RepoGetBranchesResult, RepoInfoResult, RepoGetFileResult };
