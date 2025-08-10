// Compiler plugin routes
import { z } from "zod";
import type { DetectOptions, DetectionResult } from "./types.js";
import type { ApiResponse } from "../../index.js";
import { V1_BASE_PATH } from "../../index.js";
import {
  createRequestSchema,
  createApiResponseSchema,
} from "../../../utils/schema.js";

export * from "./types.js";

// API Response interface - uses plugin ApiResponse directly
export interface DetectResponse extends ApiResponse<DetectionResult> {}

// Type-safe schema that enforces DetectOptions interface compliance
export const DetectRequestSchema = createRequestSchema<DetectOptions>()(
  z.object({
    workspacePath: z.string().optional(),
  }),
);

export const DetectResponseSchema = createApiResponseSchema<DetectionResult>()(
  z.object({
    detected: z.boolean(),
  }),
);

// Route definitions
export const compilerRoutes = {
  detect: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/detect`,
    schema: {
      body: DetectRequestSchema,
      response: {
        200: DetectResponseSchema,
      },
    },
  },
  // TODO: Add compile route when needed
  // compile: {
  //   method: "POST" as const,
  //   path: `${V1_BASE_PATH}/compile`,
  //   schema: {
  //     body: CompileRequestSchema,
  //     response: {
  //       200: CompileResponseSchema,
  //     },
  //   },
  // }
} as const;
