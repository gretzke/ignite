// API-request types for repo-manager operations
// Plugins do not see pathOrUrl – it's handler-only, carried by API requests

import { PathOptions } from "@ignite/plugin-types/base/repo-manager";

// Git credentials interface for secure credential passing
export interface GitCredentialsData {
  initialized: boolean;
  credentialTypes: string[];
  ssh?: {
    hasAgent: boolean;
    hasKeyPath: boolean;
    keyPath?: string;
  };
}

export interface CheckoutBranchRequest extends PathOptions {
  branch: string;
}

export interface CheckoutCommitRequest extends PathOptions {
  commit: string;
}

// API-response types reuse plugin operation results
import type {
  RepoGetBranchesResult,
  RepoInfoResult,
} from "@ignite/plugin-types/base/repo-manager";

export type { RepoGetBranchesResult, RepoInfoResult };
