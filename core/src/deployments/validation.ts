import crypto from 'node:crypto';
import {
  createPublicClient,
  encodeDeployData,
  http,
  type Abi,
  type Hex,
} from 'viem';
import type {
  ChainChecklist,
  ContractSource,
  DeploymentPlan,
  FrozenInputs,
  RpcBinding,
  RpcSelection,
  ValidationItem,
  ValidationReport,
  ExplorerTargetSnapshot,
} from '@ignite/api';
import { ArtifactFreezeService } from './ArtifactFreezeService.js';
import {
  effectiveValue,
  mergeArgs,
  mergeGas,
  missingArgKeys,
  resolveSigner,
  toConstructorArgs,
} from './resolver.js';
import { verifyRpcEndpoint } from '../chains/rpcVerify.js';
import { SignerProviderService } from '../signers/SignerProviderService.js';
import { RpcStore } from '../chains/RpcStore.js';
import { RpcProviderService } from '../chains/RpcProviderService.js';
import { ExplorerStore } from '../chains/ExplorerStore.js';
import { VerifierProviderService } from '../chains/VerifierProviderService.js';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import { resolveMergedExplorers } from '../api/explorers.js';
import type { ExplorerEntry } from '@ignite/api';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import {
  TrustManager,
  type PermissionGrant,
} from '../plugins/trust/TrustManager.js';
import type { PluginMetadata } from '@ignite/plugin-types/types';

type Endpoint = { id: string; label?: string; url: string; stored?: boolean };
type Client = {
  estimateGas(args: {
    account: Hex;
    to?: Hex;
    value: bigint;
    data: Hex;
  }): Promise<bigint>;
  getBalance(args: { address: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }>;
};

export interface ValidationDeps {
  profileId?: string;
  freezeInputs: (
    profileId: string,
    contracts: ContractSource[]
  ) => Promise<FrozenInputs>;
  resolveRpcEndpoint: (
    chainId: number,
    endpointId: string
  ) => Promise<Endpoint | undefined>;
  verifyRpcEndpoint: typeof verifyRpcEndpoint;
  updateVerification: (
    chainId: number,
    endpointId: string,
    result: Awaited<ReturnType<typeof verifyRpcEndpoint>>
  ) => Promise<void>;
  // ONE snapshot per validate call. Browser-wallet accounts are tab-local
  // and every read can be answered by a different tab, so re-reading per
  // step and chain both widens the race window and makes failures describe
  // a different read than the one that missed.
  listAccounts: () => Promise<
    Array<{
      pluginId: string;
      name: string;
      state: string;
      accounts: Array<{ id: string; address: string }>;
    }>
  >;
  createClient: (url: string) => Client;
  bufferPct: number;
  explorerSelection?: Record<string, string[]>;
  captureBundles: (
    frozen: FrozenInputs,
    contracts: ContractSource[],
    profileId: string
  ) => Promise<Record<string, { bundleHash: string } | { error: string }>>;
  resolveExplorers: (chainId: number) => Promise<ExplorerEntry[]>;
  resolveVerifierTrust: (
    pluginId: string
  ) => Promise<{ metadata: PluginMetadata; grant: PermissionGrant }>;
}

export async function validatePlan(
  plan: DeploymentPlan,
  rpcSelection: RpcSelection,
  overrides?: Partial<ValidationDeps>
): Promise<{
  report: ValidationReport;
  frozen: FrozenInputs;
  rpcBindings: Record<string, RpcBinding>;
  explorerTargets?: Record<string, ExplorerTargetSnapshot[]>;
}> {
  const defaults = defaultDeps();
  const deps: ValidationDeps = { ...defaults, ...overrides };
  let frozen: FrozenInputs = {};
  let freezeError: unknown;
  try {
    frozen = await deps.freezeInputs(
      deps.profileId ?? 'default',
      plan.contracts
    );
  } catch (error) {
    freezeError = error;
  }

  // Bundle capture intentionally happens after the all-or-nothing artifact
  // freeze. A verification-only failure must not poison the freezeError path.
  let bundleResults: Record<
    string,
    { bundleHash: string } | { error: string }
  > = {};
  if (!freezeError) {
    bundleResults = await deps.captureBundles(
      frozen,
      plan.contracts,
      deps.profileId ?? 'default'
    );
  }

  let accountsSnapshot: Awaited<ReturnType<ValidationDeps['listAccounts']>> =
    [];
  let accountsError: unknown;
  try {
    accountsSnapshot = await deps.listAccounts();
  } catch (error) {
    accountsError = error;
  }

  const bindings: Record<string, RpcBinding> = {};
  const chains: Record<string, ChainChecklist> = {};
  const explorerTargets: Record<string, ExplorerTargetSnapshot[]> = {};
  for (const chainId of plan.chains) {
    const key = String(chainId);
    const endpointId = rpcSelection[key];
    const endpoint = endpointId
      ? await deps.resolveRpcEndpoint(chainId, endpointId)
      : undefined;
    const rpc = await validateRpc(chainId, endpoint, deps, bindings);
    const inputs = freezeError
      ? failure(
          codeOf(freezeError, 'ARTIFACT_DATA_ERROR'),
          safeMessage(freezeError, 'Contract inputs could not be frozen')
        )
      : success(
          Object.values(frozen).some((input) => input.repoDirty)
            ? 'Inputs frozen; repository changes were detected'
            : 'Inputs frozen'
        );
    const signerResults = validateSigners(
      plan,
      chainId,
      accountsSnapshot,
      accountsError
    );
    const args = validateArgs(plan, chainId, frozen, freezeError);
    const estimation = await validateEstimations(
      plan,
      chainId,
      frozen,
      endpoint?.url,
      signerResults.signers,
      deps,
      freezeError
    );
    const balance = await validateBalance(
      plan,
      chainId,
      endpoint?.url,
      signerResults.signers,
      estimation.estimates,
      deps,
      freezeError
    );
    const verification = await validateVerification(
      plan,
      chainId,
      frozen,
      freezeError,
      bundleResults,
      deps.explorerSelection?.[key] ?? [],
      deps.resolveExplorers,
      deps.resolveVerifierTrust,
      explorerTargets
    );
    chains[key] = {
      rpc,
      signers: signerResults.item,
      args,
      estimation: estimation.item,
      balance,
      inputs,
      verification,
    };
  }
  return { report: { chains }, frozen, rpcBindings: bindings, explorerTargets };
}

function defaultDeps(): ValidationDeps {
  const freeze = new ArtifactFreezeService();
  const rpcStore = new RpcStore();
  const freezeDeps = freeze as ArtifactFreezeService;
  const explorerDeps = {
    registry: new ChainRegistry(),
    store: new ExplorerStore(),
    providers: VerifierProviderService.getInstance(),
  };
  const registry = PluginRegistryLoader.getInstance();
  const trust = TrustManager.getInstance();
  return {
    profileId: 'default',
    freezeInputs: freeze.freezeInputs.bind(freeze),
    resolveRpcEndpoint: async (chainId, endpointId) => {
      const stored = (await rpcStore.list(chainId)).find(
        (item) => item.id === endpointId
      );
      if (stored) return { ...stored, label: stored.label, stored: true };
      // Provider-plugin endpoints (Infura/Alchemy/chainz) are ephemeral and
      // never live in RpcStore — the wizard legitimately offers them, so
      // authoritative validation must resolve them the same way the engine
      // does (their verification results are transient, not persisted).
      const provided = (
        await RpcProviderService.getInstance().getChainData(chainId)
      ).endpoints.find((item) => item.id === endpointId);
      return provided
        ? { ...provided, label: provided.label, stored: false }
        : undefined;
    },
    verifyRpcEndpoint,
    updateVerification: rpcStore.updateVerification.bind(rpcStore),
    listAccounts: async () =>
      (await SignerProviderService.getInstance().listAccounts(true)).providers,
    createClient: (url) =>
      createPublicClient({ transport: http(url) }) as unknown as Client,
    bufferPct: 20,
    captureBundles: freezeDeps.captureBundles.bind(freezeDeps),
    resolveExplorers: (chainId) =>
      resolveMergedExplorers(explorerDeps, chainId),
    resolveVerifierTrust: async (pluginId) => ({
      metadata: (await registry.getPluginConfig(pluginId)).metadata,
      grant: await trust.getGrant(pluginId),
    }),
  };
}

async function validateVerification(
  plan: DeploymentPlan,
  chainId: number,
  frozen: FrozenInputs,
  freezeError: unknown,
  bundles: Record<string, { bundleHash: string } | { error: string }>,
  selectedIds: string[],
  resolveExplorers: (chainId: number) => Promise<ExplorerEntry[]>,
  resolveVerifierTrust: ValidationDeps['resolveVerifierTrust'],
  targets: Record<string, ExplorerTargetSnapshot[]>
): Promise<ValidationItem> {
  if (freezeError)
    return warning(
      'ARTIFACT_DATA_ERROR',
      'Verification bundle capture is unavailable until inputs are frozen'
    );
  const key = String(chainId);
  const missing = plan.contracts.filter(
    (contract) => !('bundleHash' in (bundles[contract.id] ?? {}))
  );
  if (selectedIds.length === 0) {
    return missing.length
      ? warning(
          'VERIFICATION_BUNDLE_UNAVAILABLE',
          'Verification bundles are unavailable; no explorers are selected'
        )
      : success('No explorers selected for verification');
  }
  const entries = await resolveExplorers(chainId);
  const selected = selectedIds.map((id) =>
    entries.find((entry) => entry.id === id)
  );
  if (selected.some((entry) => !entry))
    return failure(
      'EXPLORER_NOT_FOUND',
      'A selected explorer is no longer available'
    );
  if (selected.some((entry) => !entry!.verifierPluginId))
    return failure(
      'EXPLORER_MAPPING_UNCONFIRMED',
      'A selected explorer needs a confirmed verifier mapping'
    );
  if (selected.some((entry) => entry!.needsConfig))
    return failure(
      'VERIFIER_CONFIG_REQUIRED',
      'A selected verifier needs configuration'
    );
  for (const pluginId of new Set(
    selected.map((entry) => entry!.verifierPluginId!)
  )) {
    const { metadata, grant } = await resolveVerifierTrust(pluginId);
    if (!grant.net) {
      return failure(
        'VERIFIER_TRUST_REQUIRED',
        `Verifier ${pluginId} is missing the net trust grant`,
        { pluginId, missingGrant: 'net' }
      );
    }
    if (grant.trust !== 'native') {
      const missingSecrets = (metadata.configFields ?? [])
        .filter((field) => field.secret)
        .map((field) => field.key)
        .filter((key) => !grant.secrets.includes(key));
      if (missingSecrets.length > 0) {
        return failure(
          'VERIFIER_TRUST_REQUIRED',
          `Verifier ${pluginId} is missing trust grants for secret config fields: ${missingSecrets.join(', ')}`,
          { pluginId, missingGrant: missingSecrets }
        );
      }
    }
  }
  if (missing.length)
    return failure(
      'VERIFICATION_BUNDLE_UNAVAILABLE',
      'A verification bundle could not be captured'
    );
  targets[key] = selected.map((entry) => ({
    entryId: entry!.id,
    url: entry!.url,
    ...(entry!.apiUrl ? { apiUrl: entry!.apiUrl } : {}),
    verifierPluginId: entry!.verifierPluginId!,
    label: entry!.label ?? entry!.url,
    ...(entry!.pageUrlTemplate
      ? { pageUrlTemplate: entry!.pageUrlTemplate }
      : {}),
  }));
  // captureBundles sets the hash on the frozen input only after a successful
  // durable write; assert it here so launch cannot snapshot half-capture data.
  if (plan.contracts.some((contract) => !frozen[contract.id]?.bundleHash))
    return failure(
      'VERIFICATION_BUNDLE_UNAVAILABLE',
      'A verification bundle could not be stored'
    );
  return success('Verification bundles and explorer targets are ready');
}

async function validateRpc(
  chainId: number,
  endpoint: Endpoint | undefined,
  deps: ValidationDeps,
  bindings: Record<string, RpcBinding>
): Promise<ValidationItem> {
  if (!endpoint)
    return failure(
      'RPC_ENDPOINT_NOT_FOUND',
      `No selected RPC endpoint is available for chain ${chainId}`
    );
  const verification = await deps.verifyRpcEndpoint(endpoint.url, chainId);
  if (endpoint.stored !== false)
    await deps.updateVerification(chainId, endpoint.id, verification);
  if (!verification.ok || verification.chainIdMatch === false) {
    return failure(
      'RPC_VERIFICATION_FAILED',
      `The selected RPC endpoint is unavailable or reports a different chain`,
      {
        reportedChainId: verification.reportedChainId,
      }
    );
  }
  try {
    const fees = await deps.createClient(endpoint.url).estimateFeesPerGas();
    if (
      fees.maxFeePerGas === undefined ||
      fees.maxPriorityFeePerGas === undefined
    ) {
      return failure(
        'LEGACY_FEES_UNSUPPORTED',
        'This chain does not provide EIP-1559 fee data'
      );
    }
  } catch {
    return failure(
      'LEGACY_FEES_UNSUPPORTED',
      'This chain does not support EIP-1559 fees'
    );
  }
  bindings[String(chainId)] = {
    endpointId: endpoint.id,
    label: safeMessage(
      new Error(endpoint.label ?? 'RPC endpoint'),
      'RPC endpoint'
    ),
    urlFingerprint: crypto
      .createHash('sha256')
      .update(endpoint.url)
      .digest('hex'),
  };
  return success(
    verification.blockAgeSeconds !== undefined &&
      verification.blockAgeSeconds > 300
      ? 'RPC verified; latest block is stale and was annotated'
      : 'RPC verified',
    verification.blockAgeSeconds === undefined
      ? undefined
      : { blockAgeSeconds: verification.blockAgeSeconds }
  );
}

function validateSigners(
  plan: DeploymentPlan,
  chainId: number,
  snapshot: Awaited<ReturnType<ValidationDeps['listAccounts']>>,
  snapshotError: unknown
) {
  const signers = new Map<string, Hex>();
  const failures: string[] = [];
  for (const step of plan.steps) {
    // Checklist copy uses the contract name — step ids embed artifact paths
    // and read as noise in the UI.
    const stepName =
      plan.contracts.find((contract) => contract.id === step.contractId)
        ?.contractName ?? step.id;
    const signer = resolveSigner(plan, step, chainId);
    if (!signer) {
      failures.push(`No signer is configured for ${stepName}`);
      continue;
    }
    if (snapshotError) {
      failures.push(
        `Signer accounts could not be listed for ${stepName} (${safeMessage(snapshotError, 'listing failed')})`
      );
      continue;
    }
    const provider = snapshot.find(
      (entry) => entry.pluginId === signer.pluginId
    );
    const account = provider?.accounts.find(
      (entry) => entry.id === signer.accountId
    );
    if (!account) {
      // Say WHY the provider has no account — "not available" alone made a
      // dead browser-tab bridge indistinguishable from a missing key. The
      // ids in THIS snapshot (the exact read that missed) discriminate the
      // failure modes: an EMPTY list means the wallet answered with nothing
      // (locked/deauthorized), a DIFFERENT id shape means a stale tab or
      // bundle answered, a list without this wallet means its extension
      // never announced to the answering tab.
      const listed = provider
        ? provider.accounts.length > 0
          ? `; listed ids: ${provider.accounts
              .slice(0, 8)
              .map((entry) => entry.id)
              .join(', ')}`
          : '; listed no accounts (wallet locked or site deauthorized?)'
        : '';
      const detail = provider
        ? `${provider.name} reports '${provider.state}'${listed}`
        : `provider ${signer.pluginId} is not installed or listed no accounts`;
      failures.push(
        `Signer account for ${stepName} is not available (${detail})`
      );
      continue;
    }
    if (account.address.toLowerCase() !== signer.address.toLowerCase()) {
      failures.push(
        `Signer address for ${stepName} no longer matches the plan`
      );
      continue;
    }
    signers.set(step.id, signer.address as Hex);
  }
  return failures.length
    ? {
        item: failure('SIGNER_ACCOUNT_NOT_FOUND', failures.join('; '), {
          failures,
        }),
        signers,
      }
    : { item: success('All signer accounts are available'), signers };
}

function validateArgs(
  plan: DeploymentPlan,
  chainId: number,
  frozen: FrozenInputs,
  freezeError: unknown
): ValidationItem {
  if (freezeError)
    return failure(
      'ARTIFACT_DATA_ERROR',
      'Arguments cannot be checked until inputs are frozen'
    );
  try {
    for (const step of plan.steps) {
      const input = frozen[step.contractId];
      if (!input)
        return failure(
          'CONTRACT_INPUT_NOT_FOUND',
          `Frozen input for ${step.contractId} is missing`
        );
      const ctor = constructorInputs(input.abi);
      const merged = mergeArgs(step, chainId);
      const known = new Set(
        constructorInputs(input.abi).map(
          (entry, index) => entry.name || `arg${index}`
        )
      );
      const unknown = Object.keys(merged).filter((key) => !known.has(key));
      if (unknown.length)
        return failure(
          'UNKNOWN_ARGUMENT',
          `Unknown constructor arguments for step ${step.id}`,
          { fields: unknown }
        );
      const missing = missingArgKeys(ctor, merged);
      if (missing.length)
        return failure(
          'MISSING_ARGUMENT',
          `Constructor arguments are missing for step ${step.id}`,
          { fields: missing }
        );
      encodeDeployData({
        abi: input.abi as Abi,
        bytecode: input.creationBytecode,
        args: toConstructorArgs(ctor, merged),
      });
    }
    return success('Constructor arguments are valid');
  } catch (error) {
    return failure(
      codeOf(error, 'ARG_TYPE_MISMATCH'),
      safeMessage(error, 'Constructor arguments are invalid')
    );
  }
}

async function validateEstimations(
  plan: DeploymentPlan,
  chainId: number,
  frozen: FrozenInputs,
  rpcUrl: string | undefined,
  signers: Map<string, Hex>,
  deps: ValidationDeps,
  freezeError: unknown
) {
  const estimates = new Map<string, bigint>();
  if (freezeError || !rpcUrl)
    return {
      item: failure(
        'ESTIMATION_FAILED',
        'Transactions cannot be estimated until inputs and RPC are valid'
      ),
      estimates,
    };
  try {
    const client = deps.createClient(rpcUrl);
    for (const step of plan.steps) {
      const input = frozen[step.contractId];
      const signer = signers.get(step.id);
      if (!input || !signer)
        throw Object.assign(
          new Error(`Step ${step.id} is not ready for estimation`),
          { code: 'ESTIMATION_FAILED' }
        );
      const args = toConstructorArgs(
        constructorInputs(input.abi),
        mergeArgs(step, chainId)
      );
      const data = encodeDeployData({
        abi: input.abi as Abi,
        bytecode: input.creationBytecode,
        args,
      });
      // Always estimate, even if an execution gasLimit override was supplied.
      estimates.set(
        step.id,
        await client.estimateGas({
          account: signer,
          value: effectiveValue(step, chainId),
          data,
        })
      );
    }
    return {
      item: success('All deployment transactions estimate successfully'),
      estimates,
    };
  } catch (error) {
    return {
      item: failure(
        'ESTIMATION_FAILED',
        safeMessage(error, 'Deployment estimation failed')
      ),
      estimates,
    };
  }
}

async function validateBalance(
  plan: DeploymentPlan,
  chainId: number,
  rpcUrl: string | undefined,
  signers: Map<string, Hex>,
  estimates: Map<string, bigint>,
  deps: ValidationDeps,
  freezeError: unknown
): Promise<ValidationItem> {
  if (freezeError || !rpcUrl)
    return failure(
      'BALANCE_UNAVAILABLE',
      'Balance cannot be checked until inputs and RPC are valid'
    );
  try {
    const client = deps.createClient(rpcUrl);
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas === undefined)
      return failure(
        'LEGACY_FEES_UNSUPPORTED',
        'This chain does not provide EIP-1559 fee data'
      );
    const required = new Map<Hex, bigint>();
    for (const step of plan.steps) {
      const signer = signers.get(step.id);
      const estimate = estimates.get(step.id);
      if (!signer || estimate === undefined)
        throw new Error('A deployment transaction could not be estimated');
      const overrides = mergeGas(step, chainId);
      const gas = overrides.gasLimit;
      const gasLimit = gas === undefined ? estimate : BigInt(gas);
      const maxFeePerGas =
        overrides.maxFeePerGas === undefined
          ? fees.maxFeePerGas
          : BigInt(overrides.maxFeePerGas);
      required.set(
        signer,
        (required.get(signer) ?? 0n) +
          gasLimit * maxFeePerGas +
          effectiveValue(step, chainId)
      );
    }
    const balances: Record<
      string,
      { requiredWei: string; balanceWei: string }
    > = {};
    let insufficient = false;
    for (const [address, amount] of required) {
      const withBuffer = amount + (amount * BigInt(deps.bufferPct)) / 100n;
      const balance = await client.getBalance({ address });
      balances[address] = {
        requiredWei: withBuffer.toString(),
        balanceWei: balance.toString(),
      };
      if (balance < withBuffer) insufficient = true;
    }
    const first = Object.values(balances)[0];
    const details = required.size === 1 ? { ...first, balances } : { balances };
    if (insufficient)
      return failure(
        'INSUFFICIENT_BALANCE',
        'Signer balance is insufficient for the selected deployments',
        details
      );
    if (required.size)
      return success('Signer balance covers all planned deployments', details);
    return success('No transaction value is required');
  } catch (error) {
    return failure(
      'BALANCE_UNAVAILABLE',
      safeMessage(error, 'Balance check failed')
    );
  }
}

function constructorInputs(
  abi: unknown
): { name?: string; type: string; components?: unknown[] }[] {
  const constructor = Array.isArray(abi)
    ? (abi.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as { type?: string }).type === 'constructor'
      ) as
        | { inputs?: { name?: string; type: string; components?: unknown[] }[] }
        | undefined)
    : undefined;
  return constructor?.inputs ?? [];
}

function success(
  message: string,
  details?: Record<string, unknown>
): ValidationItem {
  return {
    ok: true,
    blocking: false,
    message,
    ...(details ? { details } : {}),
  };
}
function failure(
  code: string,
  message: string,
  details?: Record<string, unknown>
): ValidationItem {
  return {
    ok: false,
    blocking: true,
    code,
    message,
    ...(details ? { details } : {}),
  };
}
export function warning(
  code: string,
  message: string,
  details?: Record<string, unknown>
): ValidationItem {
  return {
    ok: false,
    blocking: false,
    code,
    message,
    ...(details ? { details } : {}),
  };
}
function codeOf(error: unknown, fallback: string): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallback;
}
function safeMessage(error: unknown, fallback: string): string {
  // viem errors carry the entire JSON-RPC request (including full creation
  // calldata) in .message; .shortMessage is the human-sized diagnosis. Keep
  // the short form, add truncated details when they say more, and clamp any
  // surviving hex blobs so a checklist item can never be a wall of bytes.
  const viemError = error as {
    shortMessage?: unknown;
    details?: unknown;
    message?: unknown;
  };
  const short =
    typeof viemError?.shortMessage === 'string'
      ? viemError.shortMessage
      : undefined;
  const details =
    typeof viemError?.details === 'string' ? viemError.details : undefined;
  const base =
    short ??
    (error instanceof Error && error.message ? error.message : fallback);
  const composed =
    details && !base.includes(details)
      ? `${base} (${details.slice(0, 160)})`
      : base;
  return composed
    .replace(/https?:\/\/\S+/gi, 'RPC endpoint')
    .replace(
      /0x[0-9a-fA-F]{68,}/g,
      (blob) => `${blob.slice(0, 22)}… (${(blob.length - 2) / 2} bytes)`
    )
    .slice(0, 400);
}
