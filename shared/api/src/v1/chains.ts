// shared/api/src/v1/chains.ts
// Chain registry + RPC store routes. Chain/RPC data is per-user only —
// these contracts intentionally carry no secrets (RPC URLs may embed keys,
// so responses never leave localhost and are never persisted to repos).
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";

export interface ChainNativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainExplorer {
  name: string;
  url: string;
  standard?: string;
}

export interface ChainInfo {
  chainId: number;
  name: string;
  shortName?: string;
  nativeCurrency: ChainNativeCurrency;
  rpc: string[]; // public suggestions (chainlist); custom chains may be empty
  explorers?: ChainExplorer[];
  infoURL?: string;
  iconUrl?: string; // derived from the chainlist icon slug; custom chains have none
  source: "chainlist" | "custom";
}

export interface ListChainsData {
  chains: ChainInfo[];
  total: number; // matches before limit was applied
  fetchedAt: string | null; // chainlist cache timestamp, null = never fetched
}

export interface GetChainData {
  chain: ChainInfo;
}

export interface UpsertChainRequest {
  chainId: number;
  name: string;
  shortName?: string;
  nativeCurrency: ChainNativeCurrency;
  rpc?: string[];
  explorers?: ChainExplorer[];
  infoURL?: string;
}

export interface RefreshChainsData {
  fetchedAt: string;
  count: number;
}

export interface RpcVerificationResult {
  ok: boolean;
  reportedChainId?: number;
  chainIdMatch?: boolean;
  latencyMs?: number;
  blockNumber?: number;
  blockAgeSeconds?: number;
  error?: string;
  checkedAt: string; // ISO timestamp
}

export interface RpcEndpoint {
  id: string;
  url: string;
  label?: string;
  source: "manual" | "chainlist" | "plugin"; // plugin lands in D1c
  pluginId?: string;
  preferred?: boolean;
  lastVerification?: RpcVerificationResult;
}

// Reported by rpc-provider plugins (getSupportedChains). Untrusted input:
// core bounds and validates every entry before it reaches the API.
export interface ProviderChainEndpoint {
  chainId: number;
  url: string;
  label?: string;
}

// null means "the provider has nothing usable configured yet" (e.g. no API
// key) — distinct from an empty array, which means the provider ran fine but
// genuinely has nothing to report (e.g. configured but no chains match).
export interface GetSupportedChainsResult {
  chains: ProviderChainEndpoint[] | null;
}

// Per-plugin summary surfaced alongside providerEndpoints so the frontend
// can tell "this provider needs configuration" apart from "this provider is
// fine but has nothing for this chain" without guessing from endpoint counts.
export interface ProviderStatus {
  pluginId: string;
  name: string;
  state: "ok" | "needs-config";
}

export interface ListRpcsData {
  endpoints: RpcEndpoint[];
  providerEndpoints?: RpcEndpoint[];
  providerStatuses?: ProviderStatus[];
}

export interface AddRpcRequest {
  url: string;
  label?: string;
  source?: "manual" | "chainlist";
}

export interface AddRpcData {
  endpoint: RpcEndpoint;
}

export interface VerifyRpcData {
  result: RpcVerificationResult;
}

export interface CheckRpcRequest {
  url: string;
  expectedChainId: number;
}

export interface ChainParams {
  chainId: string; // numeric string; parsed in the handler
}

export interface RpcParams {
  chainId: string;
  endpointId: string;
}

export const ChainParamsSchema = createRequestSchema<ChainParams>(
  "ChainParamsSchema",
)(z.object({ chainId: z.string().regex(/^\d+$/) }));

export const RpcParamsSchema = createRequestSchema<RpcParams>(
  "RpcParamsSchema",
)(
  z.object({
    chainId: z.string().regex(/^\d+$/),
    endpointId: z.string().min(1),
  }),
);

export const ListChainsQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const ListRpcsQuerySchema = z.object({
  refresh: z.coerce.boolean().optional(),
});

export const ChainNativeCurrencySchema = z.object({
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
});

export const ChainExplorerSchema = z.object({
  name: z.string(),
  url: z.string(),
  standard: z.string().optional(),
});

export const ChainInfoSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string(),
  shortName: z.string().optional(),
  nativeCurrency: ChainNativeCurrencySchema,
  rpc: z.array(z.string()),
  explorers: z.array(ChainExplorerSchema).optional(),
  infoURL: z.string().optional(),
  iconUrl: z.string().optional(),
  source: z.enum(["chainlist", "custom"]),
});

export const RpcVerificationResultSchema = z.object({
  ok: z.boolean(),
  reportedChainId: z.number().optional(),
  chainIdMatch: z.boolean().optional(),
  latencyMs: z.number().optional(),
  blockNumber: z.number().optional(),
  blockAgeSeconds: z.number().optional(),
  error: z.string().optional(),
  checkedAt: z.string(),
});

export const RpcEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  label: z.string().optional(),
  source: z.enum(["manual", "chainlist", "plugin"]),
  pluginId: z.string().optional(),
  preferred: z.boolean().optional(),
  lastVerification: RpcVerificationResultSchema.optional(),
});

export const ProviderChainEndpointSchema = z.object({
  chainId: z.number().int().positive(),
  url: z.string(),
  label: z.string().optional(),
});

export const GetSupportedChainsResultSchema = z.object({
  chains: z.array(ProviderChainEndpointSchema).nullable(),
});

export const ProviderStatusSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  state: z.enum(["ok", "needs-config"]),
});

export const ListChainsResponseSchema =
  createApiResponseSchema<ListChainsData>("ListChainsResponseSchema")(
    z.object({
      chains: z.array(ChainInfoSchema),
      total: z.number(),
      fetchedAt: z.string().nullable(),
    }),
  );

export const GetChainResponseSchema = createApiResponseSchema<GetChainData>(
  "GetChainResponseSchema",
)(z.object({ chain: ChainInfoSchema }));

export const UpsertChainRequestSchema =
  createRequestSchema<UpsertChainRequest>("UpsertChainRequestSchema")(
    z.object({
      chainId: z.number().int().positive(),
      name: z.string().min(1),
      shortName: z.string().optional(),
      nativeCurrency: ChainNativeCurrencySchema,
      rpc: z.array(z.string()).optional(),
      explorers: z.array(ChainExplorerSchema).optional(),
      infoURL: z.string().optional(),
    }),
  );

export const RefreshChainsResponseSchema =
  createApiResponseSchema<RefreshChainsData>("RefreshChainsResponseSchema")(
    z.object({ fetchedAt: z.string(), count: z.number() }),
  );

export const ListRpcsResponseSchema = createApiResponseSchema<ListRpcsData>(
  "ListRpcsResponseSchema",
)(z.object({
  endpoints: z.array(RpcEndpointSchema),
  providerEndpoints: z.array(RpcEndpointSchema).optional(),
  providerStatuses: z.array(ProviderStatusSchema).optional(),
}));

export const AddRpcRequestSchema = createRequestSchema<AddRpcRequest>(
  "AddRpcRequestSchema",
)(
  z.object({
    url: z.string().min(1),
    label: z.string().optional(),
    source: z.enum(["manual", "chainlist"]).optional(),
  }),
);

export const AddRpcResponseSchema = createApiResponseSchema<AddRpcData>(
  "AddRpcResponseSchema",
)(z.object({ endpoint: RpcEndpointSchema }));

export const VerifyRpcResponseSchema = createApiResponseSchema<VerifyRpcData>(
  "VerifyRpcResponseSchema",
)(z.object({ result: RpcVerificationResultSchema }));

export const CheckRpcRequestSchema = createRequestSchema<CheckRpcRequest>(
  "CheckRpcRequestSchema",
)(
  z.object({
    url: z.string().min(1),
    expectedChainId: z.number().int().positive(),
  }),
);

// Route definitions
export const chainRoutes = {
  listChains: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/chains`,
    querystring: ListChainsQuerySchema,
    schema: {
      tags: ["chains"],
      response: { 200: ListChainsResponseSchema },
    },
  },
  refreshChains: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/chains/refresh`,
    schema: {
      tags: ["chains"],
      response: { 200: RefreshChainsResponseSchema },
    },
  },
  // Static segment must be declared before parametric sibling for clarity;
  // find-my-way prefers static matches regardless of order.
  checkRpc: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/chains/rpc-check`,
    schema: {
      tags: ["chains"],
      body: CheckRpcRequestSchema,
      response: { 200: VerifyRpcResponseSchema },
    },
  },
  getChain: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/chains/:chainId`,
    params: ChainParamsSchema,
    schema: {
      tags: ["chains"],
      response: { 200: GetChainResponseSchema },
    },
  },
  upsertChain: {
    method: "PUT" as const,
    path: `${V1_BASE_PATH}/chains`,
    schema: {
      tags: ["chains"],
      body: UpsertChainRequestSchema,
      response: { 200: GetChainResponseSchema },
    },
  },
  deleteChain: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/chains/:chainId`,
    params: ChainParamsSchema,
    schema: {
      tags: ["chains"],
      response: { 204: z.null() },
    },
  },
  listRpcs: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/chains/:chainId/rpcs`,
    params: ChainParamsSchema,
    querystring: ListRpcsQuerySchema,
    schema: {
      tags: ["chains"],
      response: { 200: ListRpcsResponseSchema },
    },
  },
  addRpc: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/chains/:chainId/rpcs`,
    params: ChainParamsSchema,
    schema: {
      tags: ["chains"],
      body: AddRpcRequestSchema,
      response: { 200: AddRpcResponseSchema },
    },
  },
  deleteRpc: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/chains/:chainId/rpcs/:endpointId`,
    params: RpcParamsSchema,
    schema: {
      tags: ["chains"],
      response: { 204: z.null() },
    },
  },
  setPreferredRpc: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/chains/:chainId/rpcs/:endpointId/preferred`,
    params: RpcParamsSchema,
    schema: {
      tags: ["chains"],
      response: { 200: ListRpcsResponseSchema },
    },
  },
  verifyRpc: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/chains/:chainId/rpcs/:endpointId/verify`,
    params: RpcParamsSchema,
    schema: {
      tags: ["chains"],
      response: { 200: VerifyRpcResponseSchema },
    },
  },
} as const;
