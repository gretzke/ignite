// Filesystem routes: host directory browsing for the DirectoryPicker
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";

export interface ListDirectoryRequest {
  path: string;
}

export interface DirectoryEntryData {
  name: string;
  isGitRepo: boolean;
  isHidden: boolean;
}

export interface DirectoryColumnData {
  path: string;
  entries: DirectoryEntryData[];
}

export interface ListDirectoryData {
  resolvedPath: string;
  requestedPathExists: boolean;
  columns: DirectoryColumnData[];
}

export const ListDirectoryRequestSchema =
  createRequestSchema<ListDirectoryRequest>("ListDirectoryRequestSchema")(
    z.object({ path: z.string() }),
  );

export const ListDirectoryResponseSchema =
  createApiResponseSchema<ListDirectoryData>("ListDirectoryResponseSchema")(
    z.object({
      resolvedPath: z.string(),
      requestedPathExists: z.boolean(),
      columns: z.array(
        z.object({
          path: z.string(),
          entries: z.array(
            z.object({
              name: z.string(),
              isGitRepo: z.boolean(),
              isHidden: z.boolean(),
            }),
          ),
        }),
      ),
    }),
  );

export const filesystemRoutes = {
  listDirectory: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/filesystem/list`,
    schema: {
      tags: ["filesystem"],
      body: ListDirectoryRequestSchema,
      response: {
        200: ListDirectoryResponseSchema,
      },
    },
  },
} as const;
