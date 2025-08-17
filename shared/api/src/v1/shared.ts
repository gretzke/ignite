import { PathOptions } from "@ignite/plugin-types/base/repo-manager";
import { createRequestSchema } from "../utils/schema.js";
import { z } from "zod";

export const PathShape = z.object({ pathOrUrl: z.string().min(1) });
export const PathRequestSchema =
  createRequestSchema<PathOptions>("PathRequestSchema")(PathShape);
