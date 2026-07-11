// Verification tasks are durable core state. These wire contracts expose the
// task snapshot, never the source bundle or explorer credentials.
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";
import type { ArgValues, ContractSource, Hex } from "./deployments.js";

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export interface ExplorerTargetSnapshot {
  entryId: string;
  url: string;
  apiUrl?: string;
  verifierPluginId: string;
  label: string;
  // Optional explorer page template with an {address} placeholder, for
  // explorers whose browse URL is not `${url}/address/${addr}` (e.g.
  // Sourcify's repo.sourcify.dev/{chainId}/{address}).
  pageUrlTemplate?: string;
}

export type VerificationStatus =
  | "queued"
  | "submitting"
  | "polling"
  | "verified"
  | "already-verified"
  | "failed"
  | "cancelled"
  | "superseded";

export interface VerificationAttempt {
  startedAt: string;
  outcome: string;
  error?: string;
  pollTicket?: string;
}

export interface VerificationTask {
  id: string;
  chainId: number;
  address: string;
  bundleHash: string;
  encodedConstructorArgs: string;
  creationTxHash?: string;
  explorer: ExplorerTargetSnapshot;
  explorerPageUrl?: string;
  origin:
    | { runId: string; stepId: string; contractId: string }
    | { kind: "manual" };
  status: VerificationStatus;
  attempts: VerificationAttempt[];
  nextAttemptAt?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationEvent {
  epoch: string;
  seq: number;
  ts: number;
  task: VerificationTask;
}

export interface CreateVerificationRequest {
  contract: ContractSource;
  chainId: number;
  address: string;
  args?: ArgValues;
  encodedConstructorArgs?: string;
  creationTxHash?: string;
  explorerEntryIds: string[];
}

export interface GuessArgsRequest {
  contract: ContractSource;
  chainId: number;
  address: string;
}

export interface GuessArgsData {
  args: ArgValues;
  encodedTail: string;
  txHash: string;
}

export interface ListVerificationsQuery {
  runId?: string;
  status?: VerificationStatus;
}

export interface ListVerificationsData {
  tasks: VerificationTask[];
}

export interface CreateVerificationData {
  tasks: VerificationTask[];
}

export interface VerificationTaskData {
  task: VerificationTask;
}

export interface VerificationTaskParams {
  id: string;
}

const ContractSourceWireSchema = z.object({
  id: z.string().min(1),
  repoPathOrUrl: z.string().min(1),
  frameworkId: z.string().min(1),
  artifactPath: z.string().min(1),
  contractName: z.string().min(1),
  sourcePath: z.string().min(1),
}) satisfies z.ZodType<ContractSource>;

export const VerificationStatusSchema = z.enum([
  "queued",
  "submitting",
  "polling",
  "verified",
  "already-verified",
  "failed",
  "cancelled",
  "superseded",
]) satisfies z.ZodType<VerificationStatus>;

export const ExplorerTargetSnapshotSchema = z.object({
  entryId: z.string().min(1),
  url: z.string().url(),
  apiUrl: z.string().url().optional(),
  verifierPluginId: z.string().min(1),
  label: z.string().min(1),
  pageUrlTemplate: z.string().url().optional(),
}) satisfies z.ZodType<ExplorerTargetSnapshot>;

export const VerificationAttemptSchema = z.object({
  startedAt: z.string(),
  outcome: z.string(),
  error: z.string().optional(),
  pollTicket: z.string().optional(),
}) satisfies z.ZodType<VerificationAttempt>;

export const VerificationTaskSchema = z.object({
  id: z.string().min(1),
  chainId: z.number().int().positive(),
  address: z.string().regex(HEX_ADDRESS),
  bundleHash: z.string().regex(SHA256_HEX),
  encodedConstructorArgs: z.string().regex(HEX),
  creationTxHash: z.string().regex(HEX).optional(),
  explorer: ExplorerTargetSnapshotSchema,
  explorerPageUrl: z.string().url().optional(),
  origin: z.union([
    z.object({
      runId: z.string().min(1),
      stepId: z.string().min(1),
      contractId: z.string().min(1),
    }),
    z.object({ kind: z.literal("manual") }),
  ]),
  status: VerificationStatusSchema,
  attempts: z.array(VerificationAttemptSchema),
  nextAttemptAt: z.string().optional(),
  detail: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<VerificationTask>;

export const VerificationEventSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  task: VerificationTaskSchema,
}) satisfies z.ZodType<VerificationEvent>;

export const CreateVerificationRequestSchema =
  createRequestSchema<CreateVerificationRequest>(
    "CreateVerificationRequestSchema",
  )(
    z.object({
      contract: ContractSourceWireSchema,
      chainId: z.number().int().positive(),
      address: z.string().regex(HEX_ADDRESS),
      args: z.record(z.string(), z.unknown()).optional(),
      encodedConstructorArgs: z.string().regex(HEX).optional(),
      creationTxHash: z.string().regex(HEX).optional(),
      explorerEntryIds: z.array(z.string().min(1)).min(1),
    }),
  );

export const GuessArgsRequestSchema = createRequestSchema<GuessArgsRequest>(
  "GuessArgsRequestSchema",
)(
  z.object({
    contract: ContractSourceWireSchema,
    chainId: z.number().int().positive(),
    address: z.string().regex(HEX_ADDRESS),
  }),
);

export const ListVerificationsQuerySchema = z.object({
  runId: z.string().min(1).optional(),
  status: VerificationStatusSchema.optional(),
}) satisfies z.ZodType<ListVerificationsQuery>;

export const VerificationTaskParamsSchema =
  createRequestSchema<VerificationTaskParams>("VerificationTaskParamsSchema")(
    z.object({ id: z.string().min(1) }),
  );

export const ListVerificationsResponseSchema =
  createApiResponseSchema<ListVerificationsData>(
    "ListVerificationsResponseSchema",
  )(z.object({ tasks: z.array(VerificationTaskSchema) }));

export const CreateVerificationResponseSchema =
  createApiResponseSchema<CreateVerificationData>(
    "CreateVerificationResponseSchema",
  )(z.object({ tasks: z.array(VerificationTaskSchema) }));

export const GuessArgsResponseSchema = createApiResponseSchema<GuessArgsData>(
  "GuessArgsResponseSchema",
)(
  z.object({
    args: z.record(z.string(), z.unknown()),
    encodedTail: z.string().regex(HEX) as z.ZodType<Hex>,
    txHash: z.string().regex(HEX),
  }),
);

export const VerificationTaskResponseSchema =
  createApiResponseSchema<VerificationTaskData>(
    "VerificationTaskResponseSchema",
  )(z.object({ task: VerificationTaskSchema }));

export const verificationRoutes = {
  listVerifications: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/verifications`,
    querystring: ListVerificationsQuerySchema,
    schema: {
      tags: ["verifications"],
      response: { 200: ListVerificationsResponseSchema },
    },
  },
  createVerification: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/verifications`,
    schema: {
      tags: ["verifications"],
      body: CreateVerificationRequestSchema,
      response: { 200: CreateVerificationResponseSchema },
    },
  },
  guessConstructorArgs: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/verifications/guess-args`,
    schema: {
      tags: ["verifications"],
      body: GuessArgsRequestSchema,
      response: { 200: GuessArgsResponseSchema },
    },
  },
  retryVerification: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/verifications/:id/retry`,
    params: VerificationTaskParamsSchema,
    schema: {
      tags: ["verifications"],
      response: { 200: VerificationTaskResponseSchema },
    },
  },
  cancelVerification: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/verifications/:id/cancel`,
    params: VerificationTaskParamsSchema,
    schema: {
      tags: ["verifications"],
      response: { 200: VerificationTaskResponseSchema },
    },
  },
} as const;
