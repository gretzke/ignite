// Compiler plugin routes
import { z } from "zod";
import { PathOptions } from "@ignite/plugin-types";
import { V1_BASE_PATH } from "../../constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../../../utils/schema.js";
import { PathRequestSchema, PathShape } from "../../shared.js";
import { JobStartedResponseSchema } from "../../jobs.js";
import type {
  ArtifactLocation,
  ArtifactData,
  GetArtifactDataRequest,
} from "./types.js";
import { ContractSourcePinSchema } from "../../deployments.js";

export * from "./types.js";

// Still used as the return type of the compiler.detect job's async body
// (core/src/api/plugins/compiler/index.ts) even though the detect route
// itself now responds with JobStartedResponseSchema — the job result shape
// still needs a name. DetectResponseSchema (the zod wrapper) was only ever
// used for the route's old synchronous response and has no remaining
// consumer; deleted.
export interface DetectResponse {
  frameworks: Array<{ id: string; name: string }>;
}

export interface CompilerOperationRequest extends PathOptions {
  pluginId: string;
  pin?: import('../../deployments.js').ContractSourcePin;
}

// HTTP-serving state is intentionally distinct from ArtifactListResult, the
// compiler plugin contract. Plugins always return { artifacts }; the host can
// additionally tell callers to attach to a lifecycle job or retry later.
export type ArtifactListServeResult =
  | { status: 'ready'; artifacts: ArtifactLocation[] }
  | { status: 'pending'; jobId: string }
  | { status: 'busy' };

const ArtifactLocationSchema = z.object({
  contractName: z.string(),
  sourcePath: z.string(),
  artifactPath: z.string(),
  variant: z.object({
    solcVersion: z.string().optional(),
    profile: z.string().optional(),
  }).optional(),
});

export const ArtifactListResponseSchema =
  createApiResponseSchema<ArtifactListServeResult>("ArtifactListResponseSchema")(
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('ready'), artifacts: z.array(ArtifactLocationSchema) }),
      z.object({ status: z.literal('pending'), jobId: z.string() }),
      z.object({ status: z.literal('busy') }),
    ]),
  );

export const CompilerOperationRequestSchema =
  createRequestSchema<CompilerOperationRequest>("CompilerOperationRequest")(
    PathShape.extend({
      pluginId: z.string(),
      pin: ContractSourcePinSchema.optional(),
    }),
  );

export const GetArtifactDataRequestSchema =
  createRequestSchema<GetArtifactDataRequest>("GetArtifactDataRequest")(
    PathShape.extend({
      pluginId: z.string(),
      artifactPath: z.string(),
      pin: ContractSourcePinSchema.optional(),
    }),
  );

export const ArtifactDataResponseSchema = createApiResponseSchema<ArtifactData>(
  "ArtifactDataResponseSchema",
)(
  z.object({
    solidityVersion: z.string(),
    optimizer: z.boolean(),
    optimizerRuns: z.number(),
    evmVersion: z.string().optional(),
    viaIR: z.boolean(),
    bytecodeHash: z.string(),
    abi: z.array(z.any()),
    creationCode: z.string(),
    deployedBytecode: z.string(),
    creationCodeLinkReferences: z.any().optional(),
    deployedBytecodeLinkReferences: z.any().optional(),
  }),
);

// Route definitions
export const compilerRoutes = {
  detect: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/detect`,
    schema: {
      tags: ["compiler"],
      body: PathRequestSchema,
      response: {
        200: JobStartedResponseSchema,
      },
    },
  },
  install: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/install`,
    schema: {
      tags: ["compiler"],
      body: CompilerOperationRequestSchema,
      response: {
        200: JobStartedResponseSchema,
      },
    },
  },
  compile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/compile`,
    schema: {
      tags: ["compiler"],
      body: CompilerOperationRequestSchema,
      response: {
        200: JobStartedResponseSchema,
      },
    },
  },
  listArtifacts: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/artifacts/list`,
    schema: {
      tags: ["compiler"],
      body: CompilerOperationRequestSchema,
      response: {
        200: ArtifactListResponseSchema,
      },
    },
  },
  getArtifactData: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/artifacts/data`,
    schema: {
      tags: ["compiler"],
      body: GetArtifactDataRequestSchema,
      response: {
        200: ArtifactDataResponseSchema,
        404: z.null(), // Artifact not found
      },
    },
  },
} as const;
