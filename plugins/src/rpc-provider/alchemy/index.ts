// Built-in Alchemy RPC-provider plugin.
//
// This plugin has no filesystem/network side effects of its own: it just
// maps a user-supplied Alchemy API key onto Alchemy's per-chain URL scheme.
// The key itself never touches disk here — Ignite resolves it from the
// encrypted vault and passes it in on stdin as `options.config['api-key']`
// (built-in plugins are natively trusted, so every declared secret is
// auto-granted at injection time).
import {
  RpcProviderPlugin,
  PluginType,
  type PluginMetadata,
  type PluginResponse,
  type RpcProviderOperation,
  type SupportedChainsResult,
} from "../../shared/index.ts";
import { runPluginCLI } from "../../shared/plugin-runner.js";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

// subdomain -> { chainId, name } used to build both the URL and the label.
const NETWORKS = [
  { subdomain: "eth-mainnet", chainId: 1, name: "Ethereum" },
  { subdomain: "eth-sepolia", chainId: 11155111, name: "Ethereum Sepolia" },
  { subdomain: "opt-mainnet", chainId: 10, name: "Optimism" },
  { subdomain: "opt-sepolia", chainId: 11155420, name: "Optimism Sepolia" },
  { subdomain: "arb-mainnet", chainId: 42161, name: "Arbitrum" },
  { subdomain: "arb-sepolia", chainId: 421614, name: "Arbitrum Sepolia" },
  { subdomain: "polygon-mainnet", chainId: 137, name: "Polygon" },
  { subdomain: "polygon-amoy", chainId: 80002, name: "Polygon Amoy" },
  { subdomain: "base-mainnet", chainId: 8453, name: "Base" },
  { subdomain: "base-sepolia", chainId: 84532, name: "Base Sepolia" },
  { subdomain: "zksync-mainnet", chainId: 324, name: "zkSync" },
  { subdomain: "worldchain-mainnet", chainId: 480, name: "World Chain" },
  { subdomain: "unichain-mainnet", chainId: 130, name: "Unichain" },
  {
    subdomain: "unichain-sepolia",
    chainId: 1301,
    name: "Unichain Sepolia",
  },
];

export class AlchemyPlugin extends RpcProviderPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "alchemy",
      type: PluginType.RPC_PROVIDER,
      name: "Alchemy",
      version: PLUGIN_VERSION,
      baseImage: "ignite/rpc-provider_alchemy:latest",
      permissions: [],
      configFields: [
        {
          key: "api-key",
          label: "API Key",
          type: "string",
          secret: true,
          required: true,
          description:
            "Your Alchemy project API key. Stored in the encrypted vault; " +
            "endpoints appear for every chain Alchemy supports.",
        },
      ],
    };
  }

  async getSupportedChains(options?: {
    config?: Record<string, unknown>;
  }): Promise<PluginResponse<SupportedChainsResult>> {
    const rawKey = options?.config?.["api-key"];
    const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!apiKey) {
      return { success: true, data: { chains: [] } };
    }

    const chains = NETWORKS.map(({ subdomain, chainId, name }) => ({
      chainId,
      url: `https://${subdomain}.g.alchemy.com/v2/${apiKey}`,
      label: `Alchemy ${name}`,
    }));
    return { success: true, data: { chains } };
  }
}

const plugin = new AlchemyPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
runPluginCLI<RpcProviderOperation>(plugin);
