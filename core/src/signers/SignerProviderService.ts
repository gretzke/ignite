// Fans out getAccounts to signer-provider plugins and drives the send flow.
// Plugin output is untrusted: bounded, schema-checked, and isolated per
// provider. Never log signer params/results; plugin diagnostics are sanitized.
import type {
  ListSignerAccountsData,
  SignerAccount,
  SignerProviderAccounts,
} from '@ignite/api';
import { SignerAccountSchema } from '@ignite/api';
import {
  PluginType,
  type ChainMetadata,
  type Hex,
  type PluginResponse,
  type PluginRuntime,
  type UnsignedTx,
} from '@ignite/plugin-types/types';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { PluginInvoker } from '../plugins/invoke/PluginInvoker.js';
import { TxService } from '../tx/TxService.js';
import { stripSentinelBlocks } from '../plugins/utils/pluginTransport.js';
import { getLogger } from '../utils/logger.js';
import { ErrorCodes, IgniteError } from '../types/errors.js';

const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ACCOUNTS = 200;
const MAX_LOGGED_ERROR_CHARS = 200;

type ProviderInfo = {
  id: string;
  name: string;
  runtime?: PluginRuntime;
};

interface ProviderAccountsData {
  accounts: SignerAccount[];
  state: SignerProviderAccounts['state'];
}

interface CacheEntry extends ProviderAccountsData {
  ts: number;
}

export interface SignerProviderServiceDeps {
  getProviders: () => Promise<ProviderInfo[]>;
  invoke: (
    pluginId: string,
    operation: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ) => Promise<PluginResponse<unknown>>;
  txService: TxService;
  now: () => number;
  timeoutMs: number;
  logger: { warn: (message: string) => void };
}

export interface SendArgs {
  pluginId: string;
  accountId: string;
  chainId: number;
  rpcUrl: string;
  chain: ChainMetadata;
  to: Hex;
  value: bigint;
  data: Hex;
}

export interface SendResult {
  txHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: number;
}

export class SignerProviderService {
  private static instance: SignerProviderService;
  private deps: SignerProviderServiceDeps;
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<ProviderAccountsData>>();

  constructor(deps?: Partial<SignerProviderServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? defaultGetProviders,
      invoke: deps?.invoke ?? defaultInvoke,
      txService: deps?.txService ?? new TxService(),
      now: deps?.now ?? Date.now,
      timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      logger: deps?.logger ?? getLogger(),
    };
  }

  static getInstance(): SignerProviderService {
    if (!SignerProviderService.instance) {
      SignerProviderService.instance = new SignerProviderService();
    }
    return SignerProviderService.instance;
  }

  static resetInstance(): void {
    SignerProviderService.instance =
      undefined as unknown as SignerProviderService;
  }

  async listAccounts(refresh = false): Promise<ListSignerAccountsData> {
    const providers = await this.deps.getProviders();
    const perProvider = await Promise.all(
      providers.map((provider) =>
        provider.runtime === 'frontend'
          ? Promise.resolve<ProviderAccountsData>({
              accounts: [],
              state: 'needs-browser',
            })
          : this.getProviderAccounts(provider.id, refresh)
      )
    );

    return {
      providers: providers.map((provider, i) => ({
        pluginId: provider.id,
        name: provider.name,
        state: perProvider[i].state,
        accounts: perProvider[i].accounts,
      })),
    };
  }

  invalidate(pluginId?: string): void {
    if (pluginId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(pluginId);
  }

  async resolveAccount(
    pluginId: string,
    accountId: string
  ): Promise<{ account: SignerAccount } | undefined> {
    const data = await this.listAccounts(false);
    const provider = data.providers.find((entry) => entry.pluginId === pluginId);
    const account = provider?.accounts.find((entry) => entry.id === accountId);
    return account ? { account } : undefined;
  }

  async send(
    args: SendArgs,
    ctx: { log: (line: string) => void; signal: AbortSignal }
  ): Promise<SendResult> {
    const resolved = await this.resolveAccount(args.pluginId, args.accountId);
    if (!resolved) {
      throw new IgniteError(
        `Account ${args.accountId} not found on signer provider ${args.pluginId}`,
        ErrorCodes.SIGNER_ACCOUNT_NOT_FOUND
      );
    }

    const { account } = resolved;
    ctx.log(`Building transaction (chain ${args.chainId}, from ${account.address})`);
    const tx = await this.deps.txService.buildTransaction({
      rpcUrl: args.rpcUrl,
      chainId: args.chainId,
      from: account.address as Hex,
      to: args.to,
      value: args.value,
      data: args.data,
    });

    if (account.capability === 'sign-and-send') {
      ctx.log(`Submitting via ${args.pluginId} (sign-and-send)`);
      const response = await this.deps.invoke(
        args.pluginId,
        'sendTransaction',
        {
          accountId: args.accountId,
          tx,
          rpcUrl: args.rpcUrl,
          chain: args.chain,
        },
        { signal: ctx.signal }
      );
      const txHash = this.expectHex(args.pluginId, response, 'txHash');
      ctx.log(`Submitted: ${txHash}; waiting for receipt`);
      const receipt = await this.deps.txService.waitForReceipt(
        args.rpcUrl,
        txHash,
        { signal: ctx.signal }
      );
      return { txHash, ...receipt };
    }

    ctx.log(`Signing via ${args.pluginId}`);
    const response = await this.deps.invoke(
      args.pluginId,
      'signTransaction',
      { accountId: args.accountId, tx },
      { signal: ctx.signal }
    );
    const rawTransaction = this.expectHex(
      args.pluginId,
      response,
      'rawTransaction'
    );
    await this.deps.txService.verifySignedTx(
      rawTransaction,
      tx,
      account.address as Hex
    );
    ctx.log('Signature verified; broadcasting');
    const txHash = await this.deps.txService.broadcast(
      args.rpcUrl,
      rawTransaction
    );
    ctx.log(`Broadcast: ${txHash}; waiting for receipt`);
    const receipt = await this.deps.txService.waitForReceipt(args.rpcUrl, txHash, {
      signal: ctx.signal,
    });
    return { txHash, ...receipt };
  }

  private async getProviderAccounts(
    pluginId: string,
    refresh: boolean
  ): Promise<ProviderAccountsData> {
    if (!refresh) {
      const cached = this.cache.get(pluginId);
      if (cached && this.deps.now() - cached.ts < CACHE_TTL_MS) {
        return cached;
      }
    }

    const existing = this.inflight.get(pluginId);
    if (existing) return existing;

    const attempt = this.fetchAndValidate(pluginId);
    this.inflight.set(pluginId, attempt);
    try {
      const data = await attempt;
      this.cache.set(pluginId, { ts: this.deps.now(), ...data });
      return data;
    } finally {
      this.inflight.delete(pluginId);
    }
  }

  private async fetchAndValidate(pluginId: string): Promise<ProviderAccountsData> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Signer provider ${pluginId} timed out after ${this.deps.timeoutMs}ms`
          )
        ),
      this.deps.timeoutMs
    );

    try {
      const response = await this.deps.invoke(
        pluginId,
        'getAccounts',
        {},
        { signal: controller.signal }
      );
      if (!response.success) {
        this.deps.logger.warn(
          `Signer provider ${pluginId} getAccounts failed (${
            response.error.code
          }): ${sanitize(response.error.message)}`
        );
        return { accounts: [], state: 'error' };
      }
      return this.validateResult(pluginId, response.data);
    } catch (error) {
      this.deps.logger.warn(
        `Signer provider ${pluginId} getAccounts threw: ${sanitize(
          error instanceof Error ? error.message : String(error)
        )}`
      );
      return { accounts: [], state: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  private validateResult(
    pluginId: string,
    data: unknown
  ): ProviderAccountsData {
    if (typeof data !== 'object' || data === null) {
      this.deps.logger.warn(
        `Signer provider ${pluginId} returned a malformed getAccounts result (not an object); dropping`
      );
      return { accounts: [], state: 'error' };
    }

    const rawAccounts = (data as { accounts?: unknown }).accounts;
    if (rawAccounts === null) {
      return { accounts: [], state: 'needs-config' };
    }
    if (!Array.isArray(rawAccounts)) {
      this.deps.logger.warn(
        `Signer provider ${pluginId} returned a malformed getAccounts result (accounts is not an array or null); dropping`
      );
      return { accounts: [], state: 'error' };
    }

    const seen = new Set<string>();
    const accounts: SignerAccount[] = [];
    for (const raw of rawAccounts) {
      const parsed = SignerAccountSchema.safeParse(raw);
      if (!parsed.success) continue;
      const account = parsed.data;
      if (seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push(account);
      if (accounts.length >= MAX_ACCOUNTS) break;
    }
    return { accounts, state: 'ok' };
  }

  private expectHex(
    pluginId: string,
    response: PluginResponse<unknown>,
    field: string
  ): Hex {
    if (!response.success) {
      // Thrown message becomes the job's persisted+broadcast error text, so
      // it must NEVER carry plugin-authored content: parse failures quote
      // the framed payload, and a MALFORMED frame (the parse-failure case)
      // defeats stripSentinelBlocks by construction — with an injected key
      // potentially inside the quoted tail. Code only; the sanitized detail
      // goes to the core log, where the global parsePluginOutput quoting
      // concern (TODO.md) already applies.
      this.deps.logger.warn(
        `Signer ${pluginId} failed producing ${field} (${response.error.code}): ${sanitize(
          response.error.message
        )}`
      );
      throw new IgniteError(
        `Signer ${pluginId} failed (${response.error.code}). See core logs for detail.`,
        ErrorCodes.SIGNER_SEND_ERROR
      );
    }
    const value = (response.data as Record<string, unknown> | null)?.[field];
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new IgniteError(
        `Signer ${pluginId} returned a malformed ${field}`,
        ErrorCodes.SIGNER_SEND_ERROR
      );
    }
    return value as Hex;
  }
}

function sanitize(message: string): string {
  return stripSentinelBlocks(message).slice(0, MAX_LOGGED_ERROR_CHARS);
}

async function defaultGetProviders(): Promise<ProviderInfo[]> {
  const configs = await PluginRegistryLoader.getInstance().getPluginsByType(
    PluginType.SIGNER_PROVIDER
  );
  return configs.map((config) => ({
    id: config.metadata.id,
    name: config.metadata.name,
    runtime: config.metadata.runtime,
  }));
}

function defaultInvoke(
  pluginId: string,
  operation: string,
  params: Record<string, unknown>,
  opts?: { signal?: AbortSignal }
): Promise<PluginResponse<unknown>> {
  return PluginInvoker.getInstance().invoke(pluginId, operation, params, opts);
}
