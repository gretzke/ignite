// Built-in private-key signer plugin (sign-only). Keys are stored in the
// encrypted vault as items of the `keys` list config field; Ignite resolves
// and injects them on stdin as options.config.keys =
// [{id, label, "private-key"}].
// This process runs in an ephemeral container with no network: the raw key
// cannot leave except as the signed tx on stdout, which core verifies before
// broadcast.
import { privateKeyToAccount } from "viem/accounts";
import {
  SignerProviderPlugin,
  PluginType,
  type PluginMetadata,
  type PluginResponse,
  type SignerProviderOperation,
  type GetAccountsResult,
  type SignTransactionParams,
  type SignTransactionResult,
  type SignerAccount,
  type Hex,
} from "../../shared/index.ts";
import { runPluginCLI } from "../../shared/plugin-runner.js";

declare const PLUGIN_VERSION: string;

// Item shape injected by core for the `keys` list field. The secret item
// field's key is `private-key` (itemField keys are lowercase-kebab like every
// other config key — the API schema enforces ^[a-z0-9][a-z0-9_-]*$).
interface KeyItem {
  id: string;
  label?: string;
  "private-key"?: string;
}

function readKeys(options?: { config?: Record<string, unknown> }): KeyItem[] {
  const raw = options?.config?.["keys"];
  return Array.isArray(raw) ? (raw as KeyItem[]) : [];
}

function normalizeKey(privateKey: string): Hex | null {
  const trimmed = privateKey.trim();
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex as Hex) : null;
}

export class PrivateKeyPlugin extends SignerProviderPlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: "private-key",
      types: [PluginType.SIGNER_PROVIDER],
      name: "Private Key",
      version: PLUGIN_VERSION,
      baseImage: "ignite/signer-provider_private-key:latest",
      permissions: [],
      configFields: [
        {
          key: "keys",
          label: "Private Keys",
          type: "list",
          description:
            "Raw private keys stored in the encrypted vault. Each key " +
            "becomes a selectable signing account.",
          itemFields: [
            { key: "label", label: "Label", type: "string", required: true },
            {
              key: "private-key",
              label: "Private Key",
              type: "string",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    };
  }

  async getAccounts(options?: {
    config?: Record<string, unknown>;
  }): Promise<PluginResponse<GetAccountsResult>> {
    const items = readKeys(options);
    if (items.length === 0) {
      return { success: true, data: { accounts: null } };
    }

    const accounts: SignerAccount[] = [];
    for (const item of items) {
      const raw = item["private-key"];
      const key = raw ? normalizeKey(raw) : null;
      if (!key) continue;
      accounts.push({
        id: item.id,
        address: privateKeyToAccount(key).address,
        label: item.label,
        capability: "sign-only",
      });
    }

    return { success: true, data: { accounts } };
  }

  async signTransaction(
    options: SignTransactionParams & { config?: Record<string, unknown> },
  ): Promise<PluginResponse<SignTransactionResult>> {
    const item = readKeys(options).find((k) => k.id === options.accountId);
    const raw = item?.["private-key"];
    const key = raw ? normalizeKey(raw) : null;
    if (!key) {
      return {
        success: false,
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: `No usable key for account '${options.accountId}'`,
        },
      };
    }

    const tx = options.tx;
    const rawTransaction = await privateKeyToAccount(key).signTransaction({
      chainId: tx.chainId,
      to: tx.to ?? undefined,
      data: tx.data,
      value: BigInt(tx.value),
      nonce: tx.nonce,
      gas: BigInt(tx.gas),
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      type: "eip1559",
    });
    return { success: true, data: { rawTransaction: rawTransaction as Hex } };
  }
}

const plugin = new PrivateKeyPlugin();
export default plugin;
runPluginCLI<SignerProviderOperation>(plugin);
