import crypto from 'node:crypto';
import {
  createPublicClient,
  http,
  keccak256,
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
  Hex32,
  WorkflowDocument,
  WorkflowRunBinding,
} from '@ignite/api';
import { CREATE2_PROXY_ADDRESS, CREATE2_PROXY_RUNTIME_HASH } from '@ignite/api';
import { ArtifactFreezeService } from './ArtifactFreezeService.js';
import {
  effectiveValue,
  mergeArgs,
  mergeGas,
  missingArgKeys,
  resolveStepValues,
  resolveSigner,
  toConstructorArgs,
  validateDependencies,
  callAbiItem,
  mergeCallTarget,} from './resolver.js';
import { ackIsFresh, buildChainPredictions, buildInitcode, buildRuntimeCode, hasPredicted, type ChainPredictions } from './schedule.js';
import {
  simulateChain,
  type SimulationOutcome,
  type SimClient,
} from './simulation.js';
import { makeForkRunner, type ForkRunner } from './forkContainer.js';
import { DeploymentTypeService } from './DeploymentTypeService.js';
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
import { PluginType, type PluginMetadata } from '@ignite/plugin-types/types';

type Endpoint = { id: string; label?: string; url: string; stored?: boolean };

function stepLabel(plan: DeploymentPlan, stepId: string): string {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) return stepId;
  if (step.kind === 'deploy') {
    return (
      plan.contracts.find((contract) => contract.id === step.contractId)
        ?.contractName ?? stepId
    );
  }
  return step.signature ? `Call ${step.signature}` : stepId;
}

function labelStepIds(plan: DeploymentPlan, message: string): string {
  return [...plan.steps]
    .sort((left, right) => right.id.length - left.id.length)
    .reduce(
      (result, step) => result.replaceAll(step.id, stepLabel(plan, step.id)),
      message
    );
}

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
  getCode?(args: { address: Hex }): Promise<Hex>;
  getTransactionCount?(args: {
    address: Hex;
    blockTag?: 'latest';
  }): Promise<number | bigint>;
  getBlockNumber?(): Promise<number | bigint>;
  simulateBlocks?(args: unknown): Promise<unknown>;
};

const validationFlights = new Map<
  string,
  Promise<Awaited<ReturnType<typeof validatePlanOnce>>>
>();

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
  deploymentTypes: Pick<DeploymentTypeService, 'list' | 'prepare' | 'validate'>;
  makeForkRunner: (opts: {
    rpcUrl: string;
    chainId: number;
  }) => Promise<ForkRunner | undefined>;
  workflow?: { document: WorkflowDocument; binding: WorkflowRunBinding };
  resolveHookStatus: (pluginId: string) => Promise<'ready' | 'missing' | 'untrusted'>;
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
  predicted?: Record<
    string,
    Record<string, { predictedAddress: Hex; initcodeHash: Hex32; salt: Hex32 }>
  >;
}> {
  // Only byte-identical validation requests may share work: sharing a
  // profile alone can otherwise return a Review result for a different draft.
  const profileId = overrides?.profileId ?? 'default';
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        profileId,
        plan,
        rpcSelection,
        explorerSelection: overrides?.explorerSelection ?? {},
        workflow: overrides?.workflow,
      })
    )
    .digest('hex');
  const active = validationFlights.get(fingerprint);
  if (active) return active;
  const task = validatePlanOnce(plan, rpcSelection, overrides);
  validationFlights.set(fingerprint, task);
  try {
    return await task;
  } finally {
    validationFlights.delete(fingerprint);
  }
}

async function validatePlanOnce(
  plan: DeploymentPlan,
  rpcSelection: RpcSelection,
  overrides?: Partial<ValidationDeps>
): Promise<{
  report: ValidationReport;
  frozen: FrozenInputs;
  rpcBindings: Record<string, RpcBinding>;
  explorerTargets?: Record<string, ExplorerTargetSnapshot[]>;
  predicted?: Record<
    string,
    Record<string, { predictedAddress: Hex; initcodeHash: Hex32; salt: Hex32 }>
  >;
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
  const predicted: Record<
    string,
    Record<string, { predictedAddress: Hex; initcodeHash: Hex32; salt: Hex32 }>
  > = {};
  const run = deps.workflow ? await validateWorkflowRun(deps.workflow.binding, deps.resolveHookStatus) : undefined;
  for (const chainId of plan.chains) {
    const key = String(chainId);
    const endpointId = rpcSelection[key];
    const endpoint = endpointId
      ? await deps.resolveRpcEndpoint(chainId, endpointId)
      : undefined;
    const rpc = await validateRpc(chainId, endpoint, deps, bindings);
    const inputs = validateFrozenInputs(plan, frozen, freezeError, deps.workflow);
    const signerResults = validateSigners(
      plan,
      chainId,
      accountsSnapshot,
      accountsError
    );
    let snapshot: ChainPredictions | undefined;
    if (!freezeError) {
      try {
        snapshot = await buildChainPredictions(plan, frozen, chainId, {
          client: endpoint?.url ? deps.createClient(endpoint.url) : undefined,
          signers: signerResults.signers,
          deploymentTypes: deps.deploymentTypes,
        });
      } catch { /* static prediction errors remain the args/create2 blocker */ }
    }
    const args = validateArgs(plan, chainId, frozen, freezeError, snapshot);
    const create2 = await validateCreate2(
      plan,
      chainId,
      frozen,
      endpoint?.url,
      deps,
      freezeError,
      snapshot
    );
    if (create2.predicted) predicted[key] = create2.predicted;
    const simulation = await validateSimulation(
      plan,
      chainId,
      frozen,
      endpoint?.url,
      signerResults.signers,
      deps,
      freezeError,
      snapshot
    );
    const balance = await validateBalance(
      plan,
      chainId,
      endpoint?.url,
      signerResults.signers,
      simulation.outcome,
      deps,
      freezeError,
      snapshot
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
      estimation: simulation.estimation,
      simulation: simulation.item,
      balance,
      inputs,
      verification,
      create2: create2.item,
    };
  }
  return {
    report: { chains, ...(run ? { run } : {}) },
    frozen,
    rpcBindings: bindings,
    explorerTargets,
    predicted,
  };
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
    deploymentTypes: DeploymentTypeService.getInstance(),
    makeForkRunner,
    resolveHookStatus: async (pluginId) => {
      let config;
      try { config = await registry.getPluginConfig(pluginId); }
      catch { return 'missing'; }
      if (!config.metadata.types.includes(PluginType.DEPLOYMENT_HOOK)) return 'missing';
      return (await trust.getGrant(pluginId)).trust === 'untrusted' ? 'untrusted' : 'ready';
    },
  };
}

function validateFrozenInputs(
  plan: DeploymentPlan,
  frozen: FrozenInputs,
  freezeError: unknown,
  workflow: ValidationDeps['workflow'],
): ValidationItem {
  if (freezeError) return failure(codeOf(freezeError, 'ARTIFACT_DATA_ERROR'), safeMessage(freezeError, 'Contract inputs could not be frozen'));
  const drifts: Array<{ sourceId: string; expected: string; actual: string }> = [];
  if (workflow) {
    const sources = new Map(workflow.document.sources.map((source) => [source.id, source]));
    for (const contract of plan.contracts) {
      if (!contract.pin) continue;
      const expected = sources.get(contract.id)?.artifactHash;
      const actual = frozen[contract.id]?.artifactHash;
      if (!expected || !actual || expected === actual) continue;
      const acknowledgement = workflow.binding.acknowledgeArtifactDrift?.[contract.id];
      if (acknowledgement?.expected === expected && acknowledgement.actual === actual) continue;
      drifts.push({ sourceId: contract.id, expected, actual });
    }
  }
  if (drifts.length > 0) return failure('WORKFLOW_ARTIFACT_DRIFT', 'Frozen artifact hashes differ from the workflow document', { drifts });
  const pinned = plan.contracts.filter((contract) => contract.pin).flatMap((contract) => {
    const pin = portablePinLabel(contract.pin!.url, contract.pin!.ref ?? contract.pin!.commit.slice(0, 12));
    return pin ? [{ sourceId: contract.id, pin, commit: contract.pin!.commit.slice(0, 12) }] : [];
  });
  const dirty = Object.values(frozen).some((input) => input.repoDirty);
  return success(dirty ? 'Inputs frozen; repository changes were detected' : 'Inputs frozen', pinned.length ? { pinned } : undefined);
}

function portablePinLabel(rawUrl: string, ref: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (!url.host) return undefined;
    const pathname = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return `${url.host}${pathname ? `/${pathname}` : ''}@${ref}`;
  } catch { return undefined; }
}

async function validateWorkflowRun(
  binding: WorkflowRunBinding,
  resolveHookStatus: ValidationDeps['resolveHookStatus'],
): Promise<NonNullable<ValidationReport['run']>> {
  const run: NonNullable<ValidationReport['run']> = {
    workflow: success('Workflow binding validated', { name: binding.name, docHash: binding.docHash }),
  };
  if (binding.hooks.length === 0) return run;
  const unavailable: string[] = [];
  for (const pluginId of binding.hooks) {
    let status: 'ready' | 'missing' | 'untrusted';
    try { status = await resolveHookStatus(pluginId); }
    catch { status = 'missing'; }
    if (status !== 'ready') unavailable.push(pluginId);
  }
  run.outputs = unavailable.length
    ? warning('WORKFLOW_HOOKS_UNAVAILABLE', 'Some selected deployment hooks are missing or untrusted', { pluginIds: unavailable })
    : success('Selected deployment hooks are installed and trusted');
  return run;
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
    // Checklist copy uses the contract/function name — step ids embed
    // URI-escaped artifact paths and read as noise in the UI.
    const stepName = stepLabel(plan, step.id);
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
  freezeError: unknown,
  snapshot?: ChainPredictions
): ValidationItem {
  if (freezeError)
    return failure(
      'ARTIFACT_DATA_ERROR',
      'Arguments cannot be checked until inputs are frozen'
    );
  try {
    validateDependencies(plan);
    // Deterministic step pointers are concrete at review time. Resolve them
    // before ABI coercion; passing the wire {$ref: ...} object to viem would
    // incorrectly reject an otherwise valid address constructor argument.
    // Plain-create targets have no review-time address, so retain the
    // documented zero-address dry-run placeholder for type checking only.
    const predictions = snapshot?.entries ?? {};
    const resolveRef = (id: string): Hex =>
      hasPredicted(predictions[id]) ? predictions[id].predictedAddress : '0x0000000000000000000000000000000000000000';
    for (const step of plan.steps) {
      if (step.kind === 'call') {
        // Calls get the same unknown/missing/type discipline as constructors
        // (final-review F10): args without a signature would be silently
        // discarded at execution, and unknown keys silently dropped.
        const fn = callAbiItem(step, chainId, callTargetAbi(plan, step, chainId, frozen));
        const merged = mergeArgs(step, chainId);
        if (!fn) {
          if (Object.keys(merged).length)
            return failure(
              'UNKNOWN_ARGUMENT',
              `Call step ${stepLabel(plan, step.id)} has arguments but no function signature`,
              { fields: Object.keys(merged) }
            );
          continue;
        }
        const knownCall = new Set(fn.inputs.map((entry, index) => entry.name || `arg${index}`));
        const unknownCall = Object.keys(merged).filter((key) => !knownCall.has(key));
        if (unknownCall.length)
          return failure(
            'UNKNOWN_ARGUMENT',
            `Unknown call arguments for ${stepLabel(plan, step.id)}`,
            { fields: unknownCall }
          );
        const missingCall = missingArgKeys([...fn.inputs], merged);
        if (missingCall.length)
          return failure(
            'MISSING_ARGUMENT',
            `Call arguments are missing for ${stepLabel(plan, step.id)}`,
            { fields: missingCall }
          );
        toConstructorArgs(fn.inputs, resolveStepValues(step, chainId, resolveRef, fn.inputs).args);
        continue;
      }
      const input = frozen[step.contractId];
      if (!input)
        return failure(
          'CONTRACT_INPUT_NOT_FOUND',
          `Frozen input for ${stepLabel(plan, step.id)} is missing`
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
          `Unknown constructor arguments for ${stepLabel(plan, step.id)}`,
          { fields: unknown }
        );
      const missing = missingArgKeys(ctor, merged);
      if (missing.length)
        return failure(
          'MISSING_ARGUMENT',
          `Constructor arguments are missing for ${stepLabel(plan, step.id)}`,
          { fields: missing }
        );
      // `toConstructorArgs` is the same ABI coercion used by execution.
      // Avoid encodeDeployData here: linked artifacts intentionally contain
      // non-hex placeholders until their library bindings are resolved.
      toConstructorArgs(
        ctor,
        resolveStepValues(step, chainId, resolveRef, ctor).args
      );
    }
    return success('Constructor arguments are valid');
  } catch (error) {
    return failure(
      codeOf(error, 'ARG_TYPE_MISMATCH'),
      labelStepIds(
        plan,
        safeMessage(error, 'Constructor arguments are invalid')
      )
    );
  }
}

async function validateCreate2(
  plan: DeploymentPlan,
  chainId: number,
  frozen: FrozenInputs,
  rpcUrl: string | undefined,
  deps: ValidationDeps,
  freezeError: unknown,
  snapshot?: ChainPredictions
): Promise<{
  item: ValidationItem;
  predicted?: Record<
    string,
    { predictedAddress: Hex; initcodeHash: Hex32; salt: Hex32 }
  >;
}> {
  const deterministic = plan.steps.filter(
    (step): step is import('@ignite/api').DeployStep =>
      step.kind === 'deploy' &&
      (step.strategy?.kind === 'create2' || step.strategy?.kind === 'plugin')
  );
  if (!deterministic.length) return { item: success('No create2 steps') };
  if (freezeError || !rpcUrl)
    return {
      item: failure(
        'CREATE2_PROXY_MISSING',
        'Create2 validation requires frozen inputs and a valid RPC'
      ),
    };
  try {
    const client = deps.createClient(rpcUrl);
    if (!client.getCode)
      return {
        item: failure(
          'CREATE2_PROXY_MISSING',
          'RPC client cannot read the deterministic deployment proxy'
        ),
      };
    const runtime = await client.getCode({ address: CREATE2_PROXY_ADDRESS });
    if (!runtime || runtime === '0x')
      return {
        item: failure(
          'CREATE2_PROXY_MISSING',
          'The canonical CREATE2 proxy is not deployed'
        ),
      };
    if (
      keccak256(runtime).toLowerCase() !==
      CREATE2_PROXY_RUNTIME_HASH.toLowerCase()
    )
      return {
        item: failure(
          'CREATE2_PROXY_MISMATCH',
          'The canonical CREATE2 proxy has unexpected runtime code'
        ),
      };
    if (!snapshot) throw new Error('Create2 predictions are unavailable');
    const predictions = snapshot.predictions;
    const installed = deterministic.some(
      (step) => step.strategy?.kind === 'plugin' && !snapshot.dynamic.has(step.id)
    )
      ? await deps.deploymentTypes.list()
      : [];
    for (const step of deterministic) {
      if (snapshot.dynamic.has(step.id)) continue;
      const current = predictions[step.id]!;
      const strategy = step.strategy! as Exclude<
        NonNullable<typeof step.strategy>,
        { kind: 'create' }
      >;
      if (strategy.kind === 'plugin') {
        const info = installed.find(
          (entry) => entry.pluginId === strategy.pluginId
        );
        if (!info)
          return {
            item: failure(
              'DEPLOYMENT_TYPE_PLUGIN_MISSING',
              `Deployment-type plugin ${strategy.pluginId} is not installed`
            ),
          };
        const prepared = strategy.prepared?.[String(chainId)];
        if (
          !prepared ||
          prepared.initcodeHash.toLowerCase() !==
            current.initcodeHash.toLowerCase() ||
          prepared.predictedAddress.toLowerCase() !==
            current.predictedAddress.toLowerCase()
        )
          return {
            item: failure(
              'DEPLOYMENT_TYPE_COMMITMENT_STALE',
              `Deployment-type commitment for ${stepLabel(plan, step.id)} is stale`
            ),
          };
        if (info.validateSupported) {
          const initcode = buildInitcode(
            step,
            frozen[step.contractId]!,
            chainId,
            (id) =>
              predictions[id]?.predictedAddress ??
              (() => {
                throw new Error(`Missing predicted pointer ${id}`);
              })()
          );
          const runtimeBytecode = buildRuntimeCode(
            step,
            frozen[step.contractId]!,
            chainId,
            (id) => predictions[id]?.predictedAddress ?? (() => { throw new Error(`Missing predicted pointer ${id}`); })()
          );
          const verdict = await deps.deploymentTypes.validate(
            strategy.pluginId,
            {
              chainId,
              initcode,
              ...(runtimeBytecode === undefined ? {} : { runtimeBytecode }),
              salt: current.salt,
              predictedAddress: current.predictedAddress,
              params: strategy.params,
            }
          );
          if (!verdict.ok)
            return {
              item: failure(
                'DEPLOYMENT_TYPE_VALIDATION_FAILED',
                verdict.reason ??
                  `Deployment type rejected ${stepLabel(plan, step.id)}`
              ),
            };
        }
      }
      const code = await client.getCode({ address: current.predictedAddress });
      if (code && code !== '0x' && !ackIsFresh(strategy, chainId, current))
        return {
          item: failure(
            'CREATE2_ALREADY_DEPLOYED',
            `Code already exists at ${current.predictedAddress}`,
            {
              stepId: step.id,
              predictedAddress: current.predictedAddress,
              initcodeHash: current.initcodeHash,
            }
          ),
        };
    }
    const provisionalSteps = deterministic.filter((step) => snapshot.dynamic.has(step.id)).map((step) => {
      const entry = snapshot.entries[step.id];
      return hasPredicted(entry)
        ? { stepId: step.id, predictedAddress: entry.predictedAddress, ...(entry.notes?.length ? { note: entry.notes.join('; ') } : {}) }
        : { stepId: step.id, degraded: entry && 'reason' in entry ? entry.reason : 'prediction unavailable' };
    });
    const reviewPredicted = Object.fromEntries(Object.entries(snapshot.entries).flatMap(([id, entry]) => hasPredicted(entry) ? [[id, { ...entry, ...(entry.provisional ? { provisional: true } : {}) }]] : []));
    return {
      item: success('CREATE2 proxy and predicted addresses are ready', {
        predicted: reviewPredicted,
        ...(provisionalSteps.length ? { provisionalSteps } : {}),
      }),
      // Lane seeding is intentionally static-only; provisional addresses are
      // review data and must never become execution commitments.
      predicted: predictions,
    };
  } catch (error) {
    return {
      item: failure(
        // Untyped throws here are prediction failures (missing salt,
        // unresolved pointer inside initcode) — never claim the proxy is
        // missing when it was not even checked.
        codeOf(error, 'CREATE2_PREDICTION_FAILED'),
        labelStepIds(plan, safeMessage(error, 'Create2 validation failed'))
      ),
    };
  }
}

async function validateSimulation(
  plan: DeploymentPlan,
  chainId: number,
  frozen: FrozenInputs,
  rpcUrl: string | undefined,
  signers: Map<string, Hex>,
  deps: ValidationDeps,
  freezeError: unknown,
  snapshot?: ChainPredictions
) {
  const degraded = snapshot && [...snapshot.dynamic].map((id) => snapshot.entries[id]).find((entry) => entry && 'absent' in entry) as Extract<ChainPredictions['entries'][string], { absent: true }> | undefined;
  if (degraded) {
    const message = `Estimation unavailable: provisional mining failed: ${degraded.reason}`;
    return { item: warning('SIMULATION_UNAVAILABLE', message), estimation: warning('ESTIMATION_FAILED', message), outcome: undefined };
  }
  if (freezeError || !rpcUrl)
    return {
      item: failure(
        'SIMULATION_UNAVAILABLE',
        'Transactions cannot be simulated until inputs and RPC are valid'
      ),
      estimation: failure(
        'ESTIMATION_FAILED',
        'Transactions cannot be estimated until inputs and RPC are valid'
      ),
      outcome: undefined,
    };
  try {
    const client = deps.createClient(rpcUrl);
    if (signers.size !== plan.steps.length)
      throw Object.assign(new Error('A step has no resolved signer'), {
        code: 'ESTIMATION_FAILED',
      });
    const simClient: SimClient = {
      estimateGas: client.estimateGas,
      // Older focused fakes only model D3 estimation. Keep them useful while
      // production viem clients provide both chain reads.
      getTransactionCount: client.getTransactionCount ?? (async () => 0),
      getBlockNumber: client.getBlockNumber ?? (async () => 0),
      getCode: client.getCode ?? (async () => undefined),
      ...(client.simulateBlocks
        ? { simulateBlocks: client.simulateBlocks }
        : {}),
    };
    // Lazy: the fork container only exists if tier 2 actually runs (F1).
    // A real viem public client always has these reads; their absence marks
    // a legacy test/dry client that can only do estimateGas — do not start
    // anvil against an endpoint it cannot otherwise query.
    const canFork = Boolean(client.getTransactionCount && client.getBlockNumber);
    const outcome = await simulateChain({
      chainId,
      plan,
      frozen,
      signers,
      client: simClient,
      predictions: snapshot,
      getFork: () =>
        canFork
          ? deps.makeForkRunner({ rpcUrl, chainId })
          : Promise.resolve(undefined),
    });
    const reverted = Object.entries(outcome.perStep).find(
      ([, value]) => value.status === 'reverted'
    );
    const details = {
      tier: outcome.tier,
      ...(outcome.baseBlock === undefined
        ? {}
        : { baseBlock: outcome.baseBlock }),
      perStep: outcome.perStep,
      warnings: outcome.warnings,
      fallthrough: outcome.fallthrough,
    };
    return {
      item: reverted
        ? failure(
            'SIMULATION_REVERTED',
            labelStepIds(
              plan,
              `Simulation reverted at ${reverted[0]}${reverted[1].reason ? `: ${reverted[1].reason}` : ''}`
            ),
            details
          )
        : success(`Simulation completed using ${outcome.tier}`, details),
      estimation:
        outcome.tier === 'estimate'
          ? reverted
            ? failure(
                'ESTIMATION_FAILED',
                labelStepIds(
                  plan,
                  `Estimation failed at ${reverted[0]}${reverted[1].reason ? `: ${reverted[1].reason}` : ''}`
                ),
                details
              )
            : success('All transaction estimates completed', details)
          : success(
              `Mirrors simulation results (tier ${outcome.tier})`,
              details
            ),
      outcome,
    };
  } catch (error) {
    return {
      item: failure(
        codeOf(error, 'SIMULATION_UNAVAILABLE'),
        labelStepIds(plan, safeMessage(error, 'Simulation failed'))
      ),
      estimation: failure(
        'ESTIMATION_FAILED',
        labelStepIds(plan, safeMessage(error, 'Deployment estimation failed'))
      ),
      outcome: undefined,
    };
  }
}

async function validateBalance(
  plan: DeploymentPlan,
  chainId: number,
  rpcUrl: string | undefined,
  signers: Map<string, Hex>,
  outcome: SimulationOutcome | undefined,
  deps: ValidationDeps,
  freezeError: unknown,
  snapshot?: ChainPredictions
): Promise<ValidationItem> {
  const degraded = snapshot && [...snapshot.dynamic].map((id) => snapshot.entries[id]).find((entry) => entry && 'absent' in entry) as Extract<ChainPredictions['entries'][string], { absent: true }> | undefined;
  if (degraded) return warning('BALANCE_UNAVAILABLE', `Balance unavailable: provisional mining failed: ${degraded.reason}`);
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
    const unestimated: string[] = [];
    for (const step of plan.steps) {
      const signer = signers.get(step.id);
      const result = outcome?.perStep[step.id];
      if (result?.status === 'skipped-existing') continue;
      if (!signer)
        throw new Error('A transaction signer could not be resolved');
      const overrides = mergeGas(step, chainId);
      const gas = overrides.gasLimit;
      if (result?.status === 'unestimable' && gas === undefined) {
        unestimated.push(step.id);
        continue;
      }
      const gasLimit =
        gas === undefined ? BigInt(result?.gasUsed ?? '0') : BigInt(gas);
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
    if (unestimated.length)
      return warning(
        'BALANCE_UNESTIMATED',
        'Some dependent transactions could not be estimated',
        { ...details, unestimated }
      );
    if (required.size)
      return success('Signer balance covers all planned transactions', details);
    return success('No transaction value is required');
  } catch (error) {
    return failure(
      'BALANCE_UNAVAILABLE',
      safeMessage(error, 'Balance check failed')
    );
  }
}

function callTargetAbi(
  plan: DeploymentPlan,
  step: Extract<DeploymentPlan['steps'][number], { kind: 'call' }>,
  chainId: number,
  frozen: FrozenInputs
): unknown {
  const target = mergeCallTarget(step, chainId);
  if (target.kind !== 'step') return undefined;
  const targetStep = plan.steps.find(
    (candidate): candidate is Extract<typeof candidate, { kind: 'deploy' }> =>
      candidate.id === target.stepId && candidate.kind === 'deploy'
  );
  return targetStep ? frozen[targetStep.contractId]?.abi : undefined;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
