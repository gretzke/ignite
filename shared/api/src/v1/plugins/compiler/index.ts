// Compiler plugin routes
import { z } from "zod";
import { V1_BASE_PATH } from "../../constants.js";
import { createApiResponseSchema } from "../../../utils/schema.js";
import { PathRequestSchema } from "../../shared.js";

export * from "./types.js";

export interface DetectResponse {
  frameworks: Array<{ id: string; name: string }>;
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
