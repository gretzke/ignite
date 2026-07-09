// Built-in mnemonic signer plugin (sign-only). The mnemonic is stored in the
// encrypted vault and injected on stdin under options.config.mnemonic; account
// indices are non-secret config. The phrase is never emitted in labels,
// errors, logs, or command arguments.
import { mnemonicToAccount } from "viem/accounts";
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

export const MAX_INDICES = 64;

// "0-4,7" -> [0,1,2,3,4,7]; invalid input -> [].
export function parseIndices(raw: string | undefined): number[] {
  if (!raw) return [];
  const out = new Set<number>();

  for (const part of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (end < start || end - start + 1 > MAX_INDICES) return [];
      for (let i = start; i <= end; i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    } else {
      return [];
    }

    if (out.size > MAX_INDICES) return [];
  }

  return [...out].sort((a, b) => a - b);
}

function readMnemonic(options?: {
  config?: Record<string, unknown>;
}): string | null {
  const raw = options?.config?.["mnemonic"];
  if (typeof raw !== "string") return null;
  const mnemonic = raw.trim();
  return mnemonic ? mnemonic : null;
}

function readIndices(options?: { config?: Record<string, unknown> }): number[] {
  const raw = options?.config?.["account-indices"];
  const indicesText = typeof raw === "string" ? raw.trim() : undefined;
  return parseIndices(indicesText ?? "0");
}

function txPayload(tx: SignTransactionParams["tx"]) {
  return {
    chainId: tx.chainId,
    to: tx.to ?? undefined,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    type: "eip1559" as const,
  };
}

export class MnemonicPlugin extends SignerProviderPlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: "mnemonic",
      types: [PluginType.SIGNER_PROVIDER],
      name: "Mnemonic",
      version: PLUGIN_VERSION,
      baseImage: "ignite/signer-provider_mnemonic:latest",
      permissions: [],
      configFields: [
        {
          key: "mnemonic",
          label: "Mnemonic Phrase",
          type: "string",
          secret: true,
          required: true,
          description: "BIP-39 seed phrase, stored in the encrypted vault.",
        },
        {
          key: "account-indices",
          label: "Account Indices",
          type: "string",
          description:
            "Derivation indices to expose as accounts (m/44'/60'/0'/0/i). " +
            "Comma-separated, ranges allowed: e.g. 0-4,7. Defaults to 0.",
        },
      ],
    };
  }

  async getAccounts(options?: {
    config?: Record<string, unknown>;
  }): Promise<PluginResponse<GetAccountsResult>> {
    const mnemonic = readMnemonic(options);
    if (!mnemonic) {
      return { success: true, data: { accounts: null } };
    }

    const indices = readIndices(options);
    if (indices.length === 0) {
      return { success: true, data: { accounts: null } };
    }

    try {
      const accounts: SignerAccount[] = indices.map((index) => ({
        id: String(index),
        address: mnemonicToAccount(mnemonic, { addressIndex: index }).address,
        label: `Account ${index}`,
        capability: "sign-only",
      }));
      return { success: true, data: { accounts } };
    } catch {
      return { success: true, data: { accounts: null } };
    }
  }

  async signTransaction(
    options: SignTransactionParams & { config?: Record<string, unknown> },
  ): Promise<PluginResponse<SignTransactionResult>> {
    const mnemonic = readMnemonic(options);
    const indices = readIndices(options);
    const accountIndex = indices.find((index) => String(index) === options.accountId);
    if (!mnemonic || accountIndex === undefined) {
      return {
        success: false,
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: `No usable mnemonic account for '${options.accountId}'`,
        },
      };
    }

    try {
      const rawTransaction = await mnemonicToAccount(mnemonic, {
        addressIndex: accountIndex,
      }).signTransaction(txPayload(options.tx));
      return { success: true, data: { rawTransaction: rawTransaction as Hex } };
    } catch {
      return {
        success: false,
        error: {
          code: "SIGNING_FAILED",
          message: "Mnemonic account could not sign the transaction",
        },
      };
    }
  }
}

const plugin = new MnemonicPlugin();
export default plugin;
runPluginCLI<SignerProviderOperation>(plugin);
