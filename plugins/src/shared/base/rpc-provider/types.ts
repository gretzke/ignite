import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type { NoParams } from "../../index.js";

export type RpcProviderOperations = {
  getSupportedChains: {
    params: NoParams;
    result: SupportedChainsResult;
  };
};

// Extract valid operation names
export type RpcProviderOperation = keyof RpcProviderOperations;

// Automatically generate the interface from operations
export type IRpcProviderPlugin = {
  type: PluginType.RPC_PROVIDER;
} & {
  [K in keyof RpcProviderOperations]: (
    options: RpcProviderOperations[K]["params"],
  ) => Promise<PluginResponse<RpcProviderOperations[K]["result"]>>;
};

// One per-chain RPC endpoint reported by a provider plugin. `url` may embed
// the user's API key (resolved from the vault and injected via
// options.config), so core treats it as a secret: never logged, only
// surfaced through the RPC endpoint API.
export interface SupportedChainEndpoint {
  chainId: number;
  url: string;
  label?: string;
}

export interface SupportedChainsResult {
  chains: SupportedChainEndpoint[];
}
