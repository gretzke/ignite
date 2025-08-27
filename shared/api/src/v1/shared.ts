import { PathOptions } from "@ignite/plugin-types";
import { createRequestSchema } from "../utils/schema.js";
import { z } from "zod";

export const PathShape = z.object({ pathOrUrl: z.string().min(1) });
export const PathRequestSchema =
  createRequestSchema<PathOptions>("PathRequestSchema")(PathShape);
