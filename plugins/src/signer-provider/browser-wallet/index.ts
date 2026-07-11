import {
  SignerProviderPlugin,
  PluginType,
  type PluginMetadata,
  type PluginResponse,
  type GetAccountsResult,
  type SignerAccount,
  type SignTransactionParams,
  type SignTransactionResult,
  type SendTransactionParams,
  type SendTransactionResult,
  type Hex,
} from "../../shared/index.ts";

export type { SendTransactionParams };

declare const PLUGIN_VERSION: string;

export interface Eip1193Provider {
  request(args: {
    method: string;
    params?: unknown[] | object;
  }): Promise<unknown>;
}

export interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; rdns: string };
  provider: Eip1193Provider;
}

interface WalletWindow {
  addEventListener(
    type: "eip6963:announceProvider",
    listener: (event: { detail?: Eip6963ProviderDetail }) => void,
  ): void;
  removeEventListener(
    type: "eip6963:announceProvider",
    listener: (event: { detail?: Eip6963ProviderDetail }) => void,
  ): void;
  dispatchEvent(event: Event): boolean;
}

const ACCOUNT_ID_SEP = ":";
const DISCOVERY_WINDOW_MS = 300;

let discoveredProviders = new Map<string, Eip6963ProviderDetail>();

function walletWindow(): WalletWindow | null {
  const maybeWindow = (globalThis as { window?: unknown }).window;
  return maybeWindow &&
    typeof (maybeWindow as WalletWindow).addEventListener === "function" &&
    typeof (maybeWindow as WalletWindow).dispatchEvent === "function"
    ? (maybeWindow as WalletWindow)
    : null;
}

function walletSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Stable per-wallet key. Extensions are supposed to announce unique rdns
// values, but MetaMask and MetaMask Flask can both announce io.metamask, so
// the name is part of the key UNCONDITIONALLY: a key derived only-on-
// collision would flip between rounds depending on which wallets happened
// to answer inside the discovery window, breaking previously issued
// account ids.
export function walletKey(info: { rdns: string; name: string }): string {
  return `${info.rdns}~${walletSlug(info.name)}`;
}

export function keyDiscoveredProviders(
  announcements: Eip6963ProviderDetail[],
): Map<string, Eip6963ProviderDetail> {
  const keyed = new Map<string, Eip6963ProviderDetail>();
  for (const detail of announcements) {
    keyed.set(walletKey(detail.info), detail);
  }
  return keyed;
}

async function discoverProviders(): Promise<
  Map<string, Eip6963ProviderDetail>
> {
  const win = walletWindow();
  if (!win) return discoveredProviders;

  const announcements: Eip6963ProviderDetail[] = [];
  const onAnnounce = (event: { detail?: Eip6963ProviderDetail }) => {
    const detail = event.detail;
    if (detail?.info?.rdns && detail.provider) {
      announcements.push(detail);
    }
  };

  win.addEventListener("eip6963:announceProvider", onAnnounce);
  try {
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_WINDOW_MS));
  } finally {
    win.removeEventListener("eip6963:announceProvider", onAnnounce);
  }

  // MERGE rounds instead of replacing: a wallet that misses one 300ms
  // announcement window must not make its accounts "unavailable" for that
  // round. A lingering entry for a removed extension fails harmlessly at
  // request time. Reference-identical providers (cohabiting MetaMask/Flask
  // sharing one pipe) are deliberately NOT collapsed: collapsing re-keyed
  // entries and invalidated already-issued account ids, and a duplicate-
  // looking choice is far less damaging than a signer reference that stops
  // resolving mid-plan.
  for (const [key, detail] of keyDiscoveredProviders(announcements)) {
    discoveredProviders.set(key, detail);
  }
  return discoveredProviders;
}

export function makeAccountId(rdns: string, address: string): string {
  // Lowercased: account ids are matched by exact string equality end to end,
  // and wallets differ in address casing between calls.
  return `${rdns}${ACCOUNT_ID_SEP}${address.toLowerCase()}`;
}

export function splitAccountId(accountId: string): {
  rdns: string;
  address: Hex;
} | null {
  const sep = accountId.indexOf(ACCOUNT_ID_SEP);
  if (sep <= 0 || sep === accountId.length - 1) return null;
  return {
    rdns: accountId.slice(0, sep),
    address: accountId.slice(sep + 1) as Hex,
  };
}

export function providerDetailForTest(
  rdns: string,
  name: string,
  provider: Eip1193Provider,
): Eip6963ProviderDetail {
  return {
    info: { uuid: rdns, name, rdns },
    provider,
  };
}

export async function ensureChain(
  provider: Eip1193Provider,
  chainId: number,
  rpcUrl: string,
  chain: {
    name: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
  },
): Promise<void> {
  const hexId = `0x${chainId.toString(16)}`;
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (parseInt(current, 16) === chainId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [rpcUrl],
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  }
}

function walletErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function walletErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null
    ? (error as { code?: number }).code
    : undefined;
}

function rejected(message: string): PluginResponse<never> {
  return {
    success: false,
    error: { code: "USER_REJECTED", message },
  };
}

export async function sendTransactionWithProviders(
  options: SendTransactionParams,
  providers: Map<string, Eip6963ProviderDetail>,
): Promise<PluginResponse<SendTransactionResult>> {
  const account = splitAccountId(options.accountId);
  if (!account) {
    return {
      success: false,
      error: {
        code: "WALLET_NOT_FOUND",
        message: "Wallet account is no longer available",
      },
    };
  }

  const provider = providers.get(account.rdns)?.provider;
  if (!provider) {
    // Account ids from an older bundle generation (bare rdns, no ~name
    // suffix) can never route safely — say so instead of a generic miss, or
    // the user retries forever against a stale plan.
    const legacyId = [...providers.keys()].some((key) =>
      key.startsWith(`${account.rdns}~`),
    );
    return {
      success: false,
      error: {
        code: "WALLET_NOT_FOUND",
        message: legacyId
          ? "This account was selected under an older wallet identifier — re-select the account and relaunch"
          : "Wallet account is no longer available",
      },
    };
  }

  try {
    await ensureChain(
      provider,
      options.tx.chainId,
      options.rpcUrl,
      options.chain,
    );
  } catch (error) {
    if (walletErrorCode(error) === 4001) {
      return {
        success: false,
        error: {
          code: "CHAIN_SWITCH_REJECTED",
          message: "Wallet chain switch was rejected",
        },
      };
    }
    return {
      success: false,
      error: {
        code: "CHAIN_SWITCH_FAILED",
        message: walletErrorMessage(error, "Wallet chain switch failed"),
      },
    };
  }

  try {
    const txHash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: account.address,
          to: options.tx.to ?? undefined,
          value: options.tx.value,
          data: options.tx.data,
          gas: options.tx.gas,
        },
      ],
    });
    return { success: true, data: { txHash: txHash as Hex } };
  } catch (error) {
    if (walletErrorCode(error) === 4001) {
      return rejected("Transaction was rejected");
    }
    return {
      success: false,
      error: {
        code: "SEND_TRANSACTION_FAILED",
        message: walletErrorMessage(error, "Wallet transaction failed"),
      },
    };
  }
}

async function accountsForProvider(
  walletKey: string,
  detail: Eip6963ProviderDetail,
  method: "eth_accounts" | "eth_requestAccounts",
): Promise<SignerAccount[]> {
  const raw = await detail.provider.request({ method });
  const addresses = Array.isArray(raw) ? raw : [];
  return addresses
    .filter((address): address is Hex => typeof address === "string")
    .map((address) => ({
      // Account ids embed the discovery-map KEY, not the raw announced
      // rdns: colliding announcements (MetaMask vs Flask both io.metamask)
      // are only unambiguous under the disambiguated key.
      id: makeAccountId(walletKey, address),
      address,
      label: `${detail.info.name} ${address.slice(0, 6)}...${address.slice(-4)}`,
      capability: "sign-and-send" as const,
    }));
}

export class BrowserWalletPlugin extends SignerProviderPlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: "browser-wallet",
      types: [PluginType.SIGNER_PROVIDER],
      runtime: "frontend",
      name: "Browser Wallet",
      version: PLUGIN_VERSION,
      baseImage: "",
      permissions: [],
      configFields: [],
    };
  }

  async getAccounts(): Promise<PluginResponse<GetAccountsResult>> {
    const providers = await discoverProviders();
    const accounts: SignerAccount[] = [];
    for (const [walletKey, detail] of providers) {
      try {
        accounts.push(
          ...(await accountsForProvider(walletKey, detail, "eth_accounts")),
        );
      } catch {
        // Ignore one broken wallet provider without hiding the rest.
      }
    }
    return { success: true, data: { accounts } };
  }

  // Frontend-only helper (like connect): lets the UI offer one connect
  // button per installed wallet extension instead of prompting all of them.
  async listWallets(): Promise<
    PluginResponse<{ wallets: Array<{ rdns: string; name: string }> }>
  > {
    const providers = await discoverProviders();
    return {
      success: true,
      data: {
        wallets: [...providers.entries()].map(([walletKey, detail]) => ({
          rdns: walletKey,
          name: detail.info.name,
        })),
      },
    };
  }

  async connect(params?: {
    rdns?: string;
  }): Promise<PluginResponse<GetAccountsResult>> {
    const providers = await discoverProviders();
    const targets = params?.rdns
      ? [...providers.entries()].filter(([walletKey]) => walletKey === params.rdns)
      : [...providers.entries()];

    const accounts: SignerAccount[] = [];
    for (const [walletKey, detail] of targets) {
      try {
        accounts.push(
          ...(await accountsForProvider(walletKey, detail, "eth_requestAccounts")),
        );
      } catch (error) {
        if (walletErrorCode(error) === 4001) {
          return rejected("Wallet connection was rejected");
        }
        return {
          success: false,
          error: {
            code: "WALLET_CONNECT_FAILED",
            message: walletErrorMessage(error, "Wallet connection failed"),
          },
        };
      }
    }
    return { success: true, data: { accounts } };
  }

  async signTransaction(
    _options: SignTransactionParams,
  ): Promise<PluginResponse<SignTransactionResult>> {
    return {
      success: false,
      error: {
        code: "OPERATION_NOT_IMPLEMENTED",
        message: "Browser wallets are sign-and-send",
      },
    };
  }

  async sendTransaction(
    options: SendTransactionParams,
  ): Promise<PluginResponse<SendTransactionResult>> {
    return sendTransactionWithProviders(options, await discoverProviders());
  }
}

const plugin = new BrowserWalletPlugin();
export default plugin;
