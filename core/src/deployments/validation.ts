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
  resolveAccount: SignerProviderService['resolveAccount'];
  providerState?: (
    pluginId: string
  ) => Promise<{ name: string; state: string } | undefined>;
  createClient: (url: string) => Client;
  bufferPct: number;
}

export async function validatePlan(
  plan: DeploymentPlan,
  rpcSelection: RpcSelection,
  overrides?: Partial<ValidationDeps>
): Promise<{
  report: ValidationReport;
  frozen: FrozenInputs;
  rpcBindings: Record<string, RpcBinding>;
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

  const bindings: Record<string, RpcBinding> = {};
  const chains: Record<string, ChainChecklist> = {};
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
    const signerResults = await validateSigners(plan, chainId, deps);
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
    chains[key] = {
      rpc,
      signers: signerResults.item,
      args,
      estimation: estimation.item,
      balance,
      inputs,
    };
  }
  return { report: { chains }, frozen, rpcBindings: bindings };
}

function defaultDeps(): ValidationDeps {
  const freeze = new ArtifactFreezeService();
  const rpcStore = new RpcStore();
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
      const { RpcProviderService } = await import(
        '../chains/RpcProviderService.js'
      );
      const provided = (
        await RpcProviderService.getInstance().getChainData(chainId)
      ).endpoints.find((item) => item.id === endpointId);
      return provided
        ? { ...provided, label: provided.label, stored: false }
        : undefined;
    },
    verifyRpcEndpoint,
    updateVerification: rpcStore.updateVerification.bind(rpcStore),
    resolveAccount: SignerProviderService.getInstance().resolveAccount.bind(
      SignerProviderService.getInstance()
    ),
    providerState: async (pluginId) => {
      const data = await SignerProviderService.getInstance().listAccounts(
        false
      );
      const provider = data.providers.find(
        (entry) => entry.pluginId === pluginId
      );
      return provider
        ? { name: provider.name, state: provider.state }
        : undefined;
    },
    createClient: (url) =>
      createPublicClient({ transport: http(url) }) as unknown as Client,
    bufferPct: 20,
  };
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
    label: safeMessage(new Error(endpoint.label ?? 'RPC endpoint'), 'RPC endpoint'),
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

async function validateSigners(
  plan: DeploymentPlan,
  chainId: number,
  deps: ValidationDeps
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
    if (!signer) { failures.push(`No signer is configured for ${stepName}`); continue; }
    const resolved = await deps.resolveAccount(
      signer.pluginId,
      signer.accountId,
      { refresh: true }
    );
    if (!resolved) {
      // Say WHY the provider has no account — "not available" alone made a
      // dead browser-tab bridge indistinguishable from a missing key.
      const provider = await deps.providerState?.(signer.pluginId);
      const detail = provider
        ? `${provider.name} reports '${provider.state}'`
        : `provider ${signer.pluginId} returned no matching account`;
      failures.push(
        `Signer account for ${stepName} is not available (${detail})`
      );
      continue;
    }
    if (
      resolved.account.address.toLowerCase() !== signer.address.toLowerCase()
    ) {
      failures.push(`Signer address for ${stepName} no longer matches the plan`);
      continue;
    }
    signers.set(step.id, signer.address as Hex);
  }
  return failures.length
    ? { item: failure('SIGNER_ACCOUNT_NOT_FOUND', failures.join('; '), { failures }), signers }
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
      const known = new Set(constructorInputs(input.abi).map((entry, index) => entry.name || `arg${index}`));
      const unknown = Object.keys(merged).filter((key) => !known.has(key));
      if (unknown.length) return failure('UNKNOWN_ARGUMENT', `Unknown constructor arguments for step ${step.id}`, { fields: unknown });
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
      const maxFeePerGas = overrides.maxFeePerGas === undefined ? fees.maxFeePerGas : BigInt(overrides.maxFeePerGas);
      required.set(
        signer,
        (required.get(signer) ?? 0n) +
          gasLimit * maxFeePerGas +
          effectiveValue(step, chainId)
      );
    }
    const balances: Record<string, { requiredWei: string; balanceWei: string }> = {};
    let insufficient = false;
    for (const [address, amount] of required) {
      const withBuffer = amount + (amount * BigInt(deps.bufferPct)) / 100n;
      const balance = await client.getBalance({ address });
      balances[address] = { requiredWei: withBuffer.toString(), balanceWei: balance.toString() };
      if (balance < withBuffer) insufficient = true;
    }
    const first = Object.values(balances)[0];
    const details = required.size === 1 ? { ...first, balances } : { balances };
    if (insufficient) return failure('INSUFFICIENT_BALANCE', 'Signer balance is insufficient for the selected deployments', details);
    if (required.size) return success('Signer balance covers all planned deployments', details);
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
