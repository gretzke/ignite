// Explorer discovery and user-managed explorer mappings. Mappings are
// deliberately separate from suggestions: core never activates a suggested
// verifier plugin until the user confirms it.
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";

const CHAIN_ID_KEY = /^[1-9]\d*$/;

export interface ExplorerEntry {
  id: string;
  chainId: number;
  url: string;
  source: "chain" | "plugin" | "manual";
  verifierPluginId?: string;
  mappingSuggestion?: string;
  needsConfig?: boolean;
  apiUrl?: string;
  label?: string;
  pageUrlTemplate?: string;
}

export interface ExplorerSelection {
  [chainId: string]: string[];
}

export interface ListExplorersQuery {
  chainId: number;
}

export interface ListExplorersData {
  entries: ExplorerEntry[];
  selection: string[];
}

export interface AddExplorerRequest {
  chainId: number;
  url: string;
  verifierPluginId?: string;
  apiUrl?: string;
  label?: string;
}

export interface UpdateExplorerRequest {
  url?: string;
  verifierPluginId?: string;
  apiUrl?: string;
  label?: string;
}

export interface ExplorerParams {
  id: string;
}

export interface ExplorerData {
  entry: ExplorerEntry;
}

export interface SetExplorerSelectionRequest {
  chainId: number;
  entryIds: string[];
}

export interface SetExplorerSelectionData {
  selection: ExplorerSelection;
}

function isExplorerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export const ExplorerUrlSchema = z
  .string()
  .url()
  .refine(isExplorerUrl, {
    message: "Explorer URLs must use http(s) and may not contain credentials",
  });

export const ExplorerEntrySchema = z.object({
  id: z.string().min(1),
  chainId: z.number().int().positive(),
  url: ExplorerUrlSchema,
  source: z.enum(["chain", "plugin", "manual"]),
  verifierPluginId: z.string().min(1).optional(),
  mappingSuggestion: z.string().min(1).optional(),
  needsConfig: z.boolean().optional(),
  apiUrl: ExplorerUrlSchema.optional(),
  label: z.string().min(1).optional(),
  pageUrlTemplate: z.string().url().optional(),
}) satisfies z.ZodType<ExplorerEntry>;

export const ExplorerSelectionSchema = z.record(
  z.string().regex(CHAIN_ID_KEY),
  z.array(z.string().min(1)),
) satisfies z.ZodType<ExplorerSelection>;

export const ListExplorersQuerySchema = z.object({
  chainId: z.coerce.number().int().positive(),
}) satisfies z.ZodType<ListExplorersQuery>;

export const AddExplorerRequestSchema = createRequestSchema<AddExplorerRequest>(
  "AddExplorerRequestSchema",
)(
  z.object({
    chainId: z.number().int().positive(),
    url: ExplorerUrlSchema,
    verifierPluginId: z.string().min(1).optional(),
    apiUrl: ExplorerUrlSchema.optional(),
    label: z.string().min(1).optional(),
  }),
);

export const UpdateExplorerRequestSchema =
  createRequestSchema<UpdateExplorerRequest>("UpdateExplorerRequestSchema")(
    z.object({
      url: ExplorerUrlSchema.optional(),
      verifierPluginId: z.string().min(1).optional(),
      apiUrl: ExplorerUrlSchema.optional(),
      label: z.string().min(1).optional(),
    }),
  );

export const ExplorerParamsSchema = createRequestSchema<ExplorerParams>(
  "ExplorerParamsSchema",
)(z.object({ id: z.string().min(1) }));

export const SetExplorerSelectionRequestSchema =
  createRequestSchema<SetExplorerSelectionRequest>(
    "SetExplorerSelectionRequestSchema",
  )(
    z.object({
      chainId: z.number().int().positive(),
      entryIds: z.array(z.string().min(1)),
    }),
  );

export const ListExplorersResponseSchema =
  createApiResponseSchema<ListExplorersData>("ListExplorersResponseSchema")(
    z.object({
      entries: z.array(ExplorerEntrySchema),
      selection: z.array(z.string().min(1)),
    }),
  );

export const ExplorerResponseSchema = createApiResponseSchema<ExplorerData>(
  "ExplorerResponseSchema",
)(z.object({ entry: ExplorerEntrySchema }));

export const SetExplorerSelectionResponseSchema =
  createApiResponseSchema<SetExplorerSelectionData>(
    "SetExplorerSelectionResponseSchema",
  )(z.object({ selection: ExplorerSelectionSchema }));

export const explorerRoutes = {
  listExplorers: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/explorers`,
    querystring: ListExplorersQuerySchema,
    schema: {
      tags: ["explorers"],
      response: { 200: ListExplorersResponseSchema },
    },
  },
  addExplorer: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/explorers`,
    schema: {
      tags: ["explorers"],
      body: AddExplorerRequestSchema,
      response: { 200: ExplorerResponseSchema },
    },
  },
  updateExplorer: {
    method: "PATCH" as const,
    path: `${V1_BASE_PATH}/explorers/:id`,
    params: ExplorerParamsSchema,
    schema: {
      tags: ["explorers"],
      body: UpdateExplorerRequestSchema,
      response: { 200: ExplorerResponseSchema },
    },
  },
  removeExplorer: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/explorers/:id`,
    params: ExplorerParamsSchema,
    schema: {
      tags: ["explorers"],
      response: { 204: z.null() },
    },
  },
  setExplorerSelection: {
    method: "PUT" as const,
    path: `${V1_BASE_PATH}/explorers/selection`,
    schema: {
      tags: ["explorers"],
      body: SetExplorerSelectionRequestSchema,
      response: { 200: SetExplorerSelectionResponseSchema },
    },
  },
} as const;
