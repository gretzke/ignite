// Base class for rpc-provider plugins (Infura, Alchemy, etc.)
import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type { IRpcProviderPlugin, SupportedChainsResult } from "./types.js";
import type { PluginResponse } from "../../types.js";

export abstract class RpcProviderPlugin
  extends BasePlugin<PluginType.RPC_PROVIDER>
  implements IRpcProviderPlugin
{
  public readonly type = PluginType.RPC_PROVIDER as const;

  // Declared with no parameters (params: NoParams) to mirror the compiler
  // base; the runtime options object (which carries the core-resolved
  // `config` map) still reaches implementations that declare an optional
  // options parameter.
  abstract getSupportedChains(): Promise<PluginResponse<SupportedChainsResult>>;
}

// Re-export types for convenience
export type {
  RpcProviderOperations,
  RpcProviderOperation,
  IRpcProviderPlugin,
  SupportedChainEndpoint,
  SupportedChainsResult,
} from "./types.js";
