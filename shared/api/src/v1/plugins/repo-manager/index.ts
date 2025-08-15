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
  RepoGetBranchesResult,
  RepoInfoResult,
} from "./types.js";
import { PathShape, PathRequestSchema } from "../../shared.js";

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

// Route registry
export const repoManagerRoutes = {
  init: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/init`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 204: z.null() },
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
  getRepoInfo: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/repos/info`,
    schema: {
      tags: ["repo-manager"],
      body: PathRequestSchema,
      response: { 200: GetRepoInfoResponseSchema },
    },
  },
} as const;
