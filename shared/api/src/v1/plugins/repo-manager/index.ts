// Repo-manager routes
import { z } from "zod";
import { V1_BASE_PATH } from "../../constants.js";
import {
  createRequestSchema,
  createApiResponseSchema,
} from "../../../utils/schema.js";
import type {
  CheckoutBranchRequest,
  CheckoutCommitRequest,
  GetFileRequest,
  RepoGetBranchesResult,
  RepoInfoResult,
  RepoGetFileResult,
  RepoCheckResult,
} from "./types.js";
import { PathShape, PathRequestSchema } from "../../shared.js";
import { JobStartedResponseSchema } from "../../jobs.js";
import { ContractSourcePinSchema } from "../../deployments.js";

export * from "./types.js";

const CheckoutBranchRequestSchema = createRequestSchema<CheckoutBranchRequest>(
  "CheckoutBranchRequest",
)(
  PathShape.extend({
    branch: z.string(),
  }),
);

const CheckoutCommitRequestSchema = createRequestSchema<CheckoutCommitRequest>(
  "CheckoutCommitRequest",
)(
  PathShape.extend({
    commit: z.string(),
  }),
);

const GetFileRequestSchema = createRequestSchema<GetFileRequest>(
  "GetFileRequest",
)(
  PathShape.extend({
    filePath: z.string(),
    pin: ContractSourcePinSchema.optional(),
  }),
);

const GetBranchesResponseSchema =
  createApiResponseSchema<RepoGetBranchesResult>("RepoGetBranchesResult")(
    z.object({
      branches: z.array(z.string()),
    }),
  );

const GetRepoInfoResponseSchema = createApiResponseSchema<RepoInfoResult>(
  "RepoInfoResult",
)(
  z.object({
    branch: z.string().nullable(),
    commit: z.string(),
    dirty: z.boolean(),
    upToDate: z.boolean(),
  }),
);

const GetFileResponseSchema = createApiResponseSchema<RepoGetFileResult>(
  "RepoGetFileResult",
)(
  z.object({
    content: z.string(),
  }),
);

const CheckReposRequestSchema = createRequestSchema<{ pathOrUrl?: string }>(
  "CheckReposRequest",
)(z.object({ pathOrUrl: z.string().min(1).optional() }));

const RepoCheckResponseSchema = createApiResponseSchema<RepoCheckResult>(
  "RepoCheckResponseSchema",
)(
  z.object({
    started: z.array(z.object({ pathOrUrl: z.string(), jobId: z.string() })),
  }),
);

// Route registry
export const repoManagerRoutes = {
  init: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/init`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 200: JobStartedResponseSchema },
    },
  },
  getBranches: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/branches`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 200: GetBranchesResponseSchema },
    },
  },
  checkoutBranch: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/checkout/branch`,
    schema: {
      tags: ["repo-manager"],
      body: CheckoutBranchRequestSchema,
      response: { 204: z.null() },
    },
  },
  checkoutCommit: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/checkout/commit`,
    schema: {
      tags: ["repo-manager"],
      body: CheckoutCommitRequestSchema,
      response: { 204: z.null() },
    },
  },
  pullChanges: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/pull`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 204: z.null() },
    },
  },
  resetRepo: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/reset`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 204: z.null() },
    },
  },
  getRepoInfo: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/info`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 200: GetRepoInfoResponseSchema },
    },
  },
  checkRepos: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/check`,
    schema: {
      tags: ["repo-manager"],
      body: CheckReposRequestSchema,
      response: { 200: RepoCheckResponseSchema },
    },
  },
  getFile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/file`,
    schema: {
      tags: ["repo-manager"],
      body: GetFileRequestSchema,
      response: {
        200: GetFileResponseSchema,
        403: z.null(), // Forbidden (security violations)
        404: z.null(), // File not found
      },
    },
  },
} as const;
