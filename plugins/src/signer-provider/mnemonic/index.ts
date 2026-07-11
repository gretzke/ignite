// Built-in mnemonic signer plugin (sign-only). Each configured list item is
// one seed phrase stored in the encrypted vault and injected on stdin under
// options.config.mnemonics[]; derivation indices are non-secret per-item
// config. Phrases are never emitted in labels, errors, logs, or argv.
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

const MAX_INDICES = 64;
const ACCOUNT_ID_SEP = ".";

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

interface MnemonicItem {
  id: string;
  label?: string;
  mnemonic?: string;
  "account-indices"?: string;
}

function readItems(options?: {
  config?: Record<string, unknown>;
}): MnemonicItem[] {
  const raw = options?.config?.["mnemonics"];
  return Array.isArray(raw) ? (raw as MnemonicItem[]) : [];
}

function itemMnemonic(item: MnemonicItem): string | null {
  const trimmed = typeof item.mnemonic === "string" ? item.mnemonic.trim() : "";
  return trimmed ? trimmed : null;
}

function itemIndices(item: MnemonicItem): number[] {
  const raw = item["account-indices"];
  const text = typeof raw === "string" ? raw.trim() : undefined;
  return parseIndices(text || "0");
}

export function makeAccountId(itemId: string, index: number): string {
  return `${itemId}${ACCOUNT_ID_SEP}${index}`;
}

function parseAccountId(
  accountId: string,
): { itemId: string; index: number } | null {
  const sep = accountId.lastIndexOf(ACCOUNT_ID_SEP);
  if (sep <= 0) return null;
  const index = Number(accountId.slice(sep + 1));
  return Number.isInteger(index) && index >= 0
    ? { itemId: accountId.slice(0, sep), index }
    : null;
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
          key: "mnemonics",
          label: "Mnemonics",
          type: "list",
          description:
            "BIP-39 seed phrases stored in the encrypted vault. Each entry " +
            "exposes its derivation indices as selectable accounts.",
          itemFields: [
            { key: "label", label: "Label", type: "string", required: true },
            {
              key: "mnemonic",
              label: "Mnemonic Phrase",
              type: "string",
              secret: true,
              required: true,
            },
            {
              key: "account-indices",
              label: "Account Indices (e.g. 0-4,7; default 0)",
              type: "string",
            },
          ],
        },
      ],
    };
  }

  async getAccounts(options?: {
    config?: Record<string, unknown>;
  }): Promise<PluginResponse<GetAccountsResult>> {
    const items = readItems(options);
    if (items.length === 0) {
      return { success: true, data: { accounts: null } };
    }

    const accounts: SignerAccount[] = [];
    for (const item of items) {
      const mnemonic = itemMnemonic(item);
      if (!mnemonic) continue;
      for (const index of itemIndices(item)) {
        try {
          accounts.push({
            id: makeAccountId(item.id, index),
            address: mnemonicToAccount(mnemonic, { addressIndex: index })
              .address,
            label: `${item.label ?? item.id} #${index}`,
            capability: "sign-only",
          });
        } catch {
          // One malformed phrase must not hide the other items' accounts.
          break;
        }
      }
    }

    // Every item unreadable = the plugin still needs configuration.
    if (accounts.length === 0) {
      return { success: true, data: { accounts: null } };
    }
    return { success: true, data: { accounts } };
  }

  async signTransaction(
    options: SignTransactionParams & { config?: Record<string, unknown> },
  ): Promise<PluginResponse<SignTransactionResult>> {
    const parsed = parseAccountId(options.accountId);
    const item = parsed
      ? readItems(options).find((entry) => entry.id === parsed.itemId)
      : undefined;
    const mnemonic = item ? itemMnemonic(item) : null;
    const validIndex =
      parsed !== null &&
      item !== undefined &&
      itemIndices(item).includes(parsed.index);
    if (!parsed || !mnemonic || !validIndex) {
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
        addressIndex: parsed.index,
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
