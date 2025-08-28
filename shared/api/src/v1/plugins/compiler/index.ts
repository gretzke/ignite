// Compiler plugin routes
import { z } from "zod";
import { PathOptions } from "@ignite/plugin-types";
import { V1_BASE_PATH } from "../../constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../../../utils/schema.js";
import { PathRequestSchema, PathShape } from "../../shared.js";
import type {
  ArtifactListResult,
  ArtifactData,
  GetArtifactDataRequest,
} from "./types.js";

export * from "./types.js";

export interface DetectResponse {
  frameworks: Array<{ id: string; name: string }>;
}

export interface CompilerOperationRequest extends PathOptions {
  pluginId: string;
}

export const DetectResponseSchema = createApiResponseSchema<DetectResponse>(
  "DetectResponseSchema",
)(
  z.object({
    frameworks: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    ),
  }),
);

export const ArtifactListResponseSchema =
  createApiResponseSchema<ArtifactListResult>("ArtifactListResponseSchema")(
    z.object({
      artifacts: z.array(
        z.object({
          contractName: z.string(),
          sourcePath: z.string(),
          artifactPath: z.string(),
        }),
      ),
    }),
  );

export const CompilerOperationRequestSchema =
  createRequestSchema<CompilerOperationRequest>("CompilerOperationRequest")(
    PathShape.extend({
      pluginId: z.string(),
    }),
  );

export const GetArtifactDataRequestSchema =
  createRequestSchema<GetArtifactDataRequest>("GetArtifactDataRequest")(
    PathShape.extend({
      pluginId: z.string(),
      artifactPath: z.string(),
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
        200: DetectResponseSchema,
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
        204: z.null(),
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
        204: z.null(),
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
