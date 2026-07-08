// Built-in Infura RPC-provider plugin.
//
// This plugin has no filesystem/network side effects of its own: it just
// maps a user-supplied Infura API key onto Infura's per-chain URL scheme.
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
  { subdomain: "mainnet", chainId: 1, name: "Mainnet" },
  { subdomain: "sepolia", chainId: 11155111, name: "Sepolia" },
  { subdomain: "holesky", chainId: 17000, name: "Holesky" },
  { subdomain: "optimism-mainnet", chainId: 10, name: "Optimism" },
  {
    subdomain: "optimism-sepolia",
    chainId: 11155420,
    name: "Optimism Sepolia",
  },
  { subdomain: "arbitrum-mainnet", chainId: 42161, name: "Arbitrum" },
  {
    subdomain: "arbitrum-sepolia",
    chainId: 421614,
    name: "Arbitrum Sepolia",
  },
  { subdomain: "polygon-mainnet", chainId: 137, name: "Polygon" },
  { subdomain: "polygon-amoy", chainId: 80002, name: "Polygon Amoy" },
  { subdomain: "base-mainnet", chainId: 8453, name: "Base" },
  { subdomain: "base-sepolia", chainId: 84532, name: "Base Sepolia" },
  { subdomain: "linea-mainnet", chainId: 59144, name: "Linea" },
  { subdomain: "avalanche-mainnet", chainId: 43114, name: "Avalanche" },
  { subdomain: "bsc-mainnet", chainId: 56, name: "BSC" },
  { subdomain: "scroll-mainnet", chainId: 534352, name: "Scroll" },
];

export class InfuraPlugin extends RpcProviderPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "infura",
      type: PluginType.RPC_PROVIDER,
      name: "Infura",
      version: PLUGIN_VERSION,
      baseImage: "ignite/rpc-provider_infura:latest",
      permissions: [],
      configFields: [
        {
          key: "api-key",
          label: "API Key",
          type: "string",
          secret: true,
          required: true,
          description:
            "Your Infura project API key. Stored in the encrypted vault; " +
            "endpoints appear for every chain Infura supports.",
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
      return { success: true, data: { chains: null } };
    }

    const chains = NETWORKS.map(({ subdomain, chainId, name }) => ({
      chainId,
      url: `https://${subdomain}.infura.io/v3/${apiKey}`,
      label: `Infura ${name}`,
    }));
    return { success: true, data: { chains } };
  }
}

const plugin = new InfuraPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
runPluginCLI<RpcProviderOperation>(plugin);
