// Deployment-run plan, persistence, and HTTP contracts. Run records never
// contain RPC URLs: only endpoint identity and a URL fingerprint are durable.
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";
import {
  ExplorerTargetSnapshotSchema,
  VerificationStatusSchema,
  type ExplorerTargetSnapshot,
  type VerificationStatus,
} from "./verifications.js";

const DECIMAL = /^\d+$/;
const CHAIN_ID_KEY = /^[1-9]\d*$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export type Hex = `0x${string}`;
export type Hex32 = `0x${string}`;
export type ArgValues = Record<string, unknown>;
export type LinkReferencesWire = Record<string, Record<string, Array<{ start: number; length: number }>>>;

// Arachnid deterministic-deployment-proxy (EIP-2470 style). The runtime and
// presigned transaction are immutable protocol constants consumed by D5 setup.
export const CREATE2_PROXY_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as const;
export const CREATE2_PROXY_RUNTIME_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3' as const;
export const CREATE2_PROXY_RUNTIME_HASH =
  '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989' as const;
export const CREATE2_PROXY_DEPLOYER_ADDRESS =
  '0x3fab184622dc19b6109349b94811493bf2a45362' as const;
export const CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX =
  '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222' as const;

export interface SignerRef {
  pluginId: string;
  accountId: string;
  address: string;
}

export interface SignerCascade {
  global?: SignerRef;
  perChain?: Record<string, SignerRef>;
}

export interface GasOverrides {
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface ContractSource {
  id: string;
  repoPathOrUrl: string;
  frameworkId: string;
  artifactPath: string;
  contractName: string;
  sourcePath: string;
  pin?: ContractSourcePin;
}

export interface ContractSourcePin {
  url: string;
  commit: string;
  ref?: string;
  refKind?: 'tag' | 'branch';
}

export interface DeployStep {
  id: string;
  kind: "deploy";
  contractId: string;
  args?: ArgValues;
  argsPerChain?: Record<string, Partial<ArgValues>>;
  value?: string;
  valuePerChain?: Record<string, string>;
  gasOverrides?: GasOverrides;
  gasOverridesPerChain?: Record<string, Partial<GasOverrides>>;
  signerOverride?: SignerCascade;
  strategy?: DeployStrategy;
  libraries?: Record<string, LibraryBinding>;
  librariesPerChain?: Record<string, Record<string, LibraryBinding>>;
}

export interface ValueRef { $ref: { kind: 'step'; stepId: string } }
export type LibraryBinding = { kind: 'address'; address: Hex } | { kind: 'step'; stepId: string };
export type AckMap = Record<string, { predictedAddress: Hex; initcodeHash: Hex32 }>;
export type DeployStrategy =
  | { kind: 'create' }
  | { kind: 'create2'; salt: Hex32; saltPerChain?: Record<string, Hex32>; acknowledgeDeployed?: AckMap }
  | { kind: 'plugin'; pluginId: string; params?: Record<string, unknown>; salt?: Hex32; saltPerChain?: Record<string, Hex32>; prepared?: Record<string, { initcodeHash: Hex32; predictedAddress: Hex }>; acknowledgeDeployed?: AckMap };
export type CallTarget = { kind: 'step'; stepId: string } | { kind: 'address'; address: Hex };
export interface CallStep {
  id: string; kind: 'call'; target: CallTarget; targetPerChain?: Record<string, CallTarget>;
  signature?: string; payable?: boolean; args?: ArgValues; argsPerChain?: Record<string, Partial<ArgValues>>;
  value?: string; valuePerChain?: Record<string, string>; gasOverrides?: GasOverrides;
  gasOverridesPerChain?: Record<string, Partial<GasOverrides>>; signerOverride?: SignerCascade;
}
export type Step = DeployStep | CallStep;

export interface DeploymentPlan {
  schemaVersion: 1;
  contracts: ContractSource[];
  steps: Step[];
  chains: number[];
  signers: SignerCascade;
}

export const DecimalStringSchema = z.string().regex(DECIMAL);
export const ChainIdKeySchema = z.string().regex(CHAIN_ID_KEY);
export const HexSchema = z.string().regex(HEX) as z.ZodType<Hex>;
export const Hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<Hex32>;
// Wire-level guard only; link-reference containment needs FrozenInput's
// cross-field superRefine below.
export const UnlinkedBytecodeSchema = z.string().startsWith('0x').max(2 * 1024 * 1024);
const AddressSchema = z.string().regex(HEX_ADDRESS) as z.ZodType<Hex>;
export const ValueRefSchema = z.object({ $ref: z.object({ kind: z.literal('step'), stepId: z.string().min(1) }) }) satisfies z.ZodType<ValueRef>;
export function isValueRef(value: unknown): value is ValueRef {
  return ValueRefSchema.safeParse(value).success;
}

export const ArgValuesSchema = z.record(z.string(), z.unknown());

export const SignerRefSchema = z.object({
  pluginId: z.string().min(1),
  accountId: z.string().min(1),
  address: z.string().regex(HEX_ADDRESS),
}) satisfies z.ZodType<SignerRef>;

export const SignerCascadeSchema = z.object({
  global: SignerRefSchema.optional(),
  perChain: z.record(ChainIdKeySchema, SignerRefSchema).optional(),
}) satisfies z.ZodType<SignerCascade>;

export const GasOverridesSchema = z.object({
  gasLimit: DecimalStringSchema.optional(),
  maxFeePerGas: DecimalStringSchema.optional(),
  maxPriorityFeePerGas: DecimalStringSchema.optional(),
}) satisfies z.ZodType<GasOverrides>;

export const ContractSourcePinSchema = z.object({
  url: z.string().min(1),
  commit: z.string().regex(/^[0-9a-fA-F]{40}$/),
  ref: z.string().min(1).optional(),
  refKind: z.enum(['tag', 'branch']).optional(),
}).superRefine((pin, ctx) => {
  if (pin.ref !== undefined && pin.refKind === undefined) ctx.addIssue({ code: 'custom', message: 'refKind is required when ref is present', path: ['refKind'] });
}) satisfies z.ZodType<ContractSourcePin>;

export const ContractSourceSchema = z.object({
  id: z.string().min(1),
  repoPathOrUrl: z.string().min(1),
  frameworkId: z.string().min(1),
  artifactPath: z.string().min(1),
  contractName: z.string().min(1),
  sourcePath: z.string().min(1),
  pin: ContractSourcePinSchema.optional(),
}).superRefine((source, ctx) => {
  if (source.pin && source.repoPathOrUrl !== source.pin.url) ctx.addIssue({ code: 'custom', message: 'repoPathOrUrl must equal pin.url', path: ['pin', 'url'] });
}) satisfies z.ZodType<ContractSource>;

export const LinkReferencesWireSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.array(z.object({ start: z.number().int().nonnegative(), length: z.number().int().positive() })),
  ),
) satisfies z.ZodType<LinkReferencesWire>;
export const LibraryBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('address'), address: AddressSchema }),
  z.object({ kind: z.literal('step'), stepId: z.string().min(1) }),
]) satisfies z.ZodType<LibraryBinding>;
const AckMapSchema = z.record(ChainIdKeySchema, z.object({ predictedAddress: AddressSchema, initcodeHash: Hex32Schema }));
export const DeployStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }),
  z.object({ kind: z.literal('create2'), salt: Hex32Schema, saltPerChain: z.record(ChainIdKeySchema, Hex32Schema).optional(), acknowledgeDeployed: AckMapSchema.optional() }),
  z.object({ kind: z.literal('plugin'), pluginId: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(), salt: Hex32Schema.optional(), saltPerChain: z.record(ChainIdKeySchema, Hex32Schema).optional(), prepared: z.record(ChainIdKeySchema, z.object({ initcodeHash: Hex32Schema, predictedAddress: AddressSchema })).optional(), acknowledgeDeployed: AckMapSchema.optional() }),
]) satisfies z.ZodType<DeployStrategy>;
export const CallTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), stepId: z.string().min(1) }),
  z.object({ kind: z.literal('address'), address: AddressSchema }),
]) satisfies z.ZodType<CallTarget>;

export const DeployStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("deploy"),
  contractId: z.string().min(1),
  args: ArgValuesSchema.optional(),
  // Per-chain args are intentionally sparse. The canonical resolver merges
  // them field-by-field over the global value.
  argsPerChain: z.record(ChainIdKeySchema, ArgValuesSchema).optional(),
  value: DecimalStringSchema.optional(),
  valuePerChain: z.record(ChainIdKeySchema, DecimalStringSchema).optional(),
  gasOverrides: GasOverridesSchema.optional(),
  gasOverridesPerChain: z
    .record(ChainIdKeySchema, GasOverridesSchema.partial())
    .optional(),
  signerOverride: SignerCascadeSchema.optional(),
  strategy: DeployStrategySchema.optional(),
  libraries: z.record(z.string(), LibraryBindingSchema).optional(),
  librariesPerChain: z.record(ChainIdKeySchema, z.record(z.string(), LibraryBindingSchema)).optional(),
}) satisfies z.ZodType<DeployStep>;

export const CallStepSchema = z.object({
  id: z.string().min(1), kind: z.literal('call'), target: CallTargetSchema,
  targetPerChain: z.record(ChainIdKeySchema, CallTargetSchema).optional(), signature: z.string().min(1).optional(), payable: z.boolean().optional(),
  args: ArgValuesSchema.optional(), argsPerChain: z.record(ChainIdKeySchema, ArgValuesSchema).optional(), value: DecimalStringSchema.optional(), valuePerChain: z.record(ChainIdKeySchema, DecimalStringSchema).optional(),
  gasOverrides: GasOverridesSchema.optional(), gasOverridesPerChain: z.record(ChainIdKeySchema, GasOverridesSchema.partial()).optional(), signerOverride: SignerCascadeSchema.optional(),
}).superRefine((step, ctx) => {
  if ((step.value !== undefined || step.valuePerChain !== undefined) && step.signature !== undefined && step.payable !== true)
    ctx.addIssue({ code: 'custom', message: 'call value requires payable: true when signature is present', path: ['payable'] });
}) satisfies z.ZodType<CallStep>;

export const StepSchema = z.discriminatedUnion("kind", [DeployStepSchema, CallStepSchema]);

export const DeploymentPlanSchema = createRequestSchema<DeploymentPlan>(
  "DeploymentPlanSchema",
)(
  z.object({
    schemaVersion: z.literal(1),
    contracts: z.array(ContractSourceSchema),
    steps: z.array(StepSchema),
    chains: z.array(z.number().int().positive()),
    signers: SignerCascadeSchema,
  }).superRefine((plan, ctx) => {
    if (plan.contracts.length === 0) ctx.addIssue({ code: 'custom', message: 'at least one contract is required', path: ['contracts'] });
    if (plan.steps.length === 0) ctx.addIssue({ code: 'custom', message: 'at least one step is required', path: ['steps'] });
    if (plan.chains.length === 0) ctx.addIssue({ code: 'custom', message: 'at least one chain is required', path: ['chains'] });
    const duplicate = (values: string[]) => values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate(plan.contracts.map((contract) => contract.id))) ctx.addIssue({ code: 'custom', message: 'contract ids must be unique', path: ['contracts'] });
    if (duplicate(plan.steps.map((step) => step.id))) ctx.addIssue({ code: 'custom', message: 'step ids must be unique', path: ['steps'] });
    if (new Set(plan.chains).size !== plan.chains.length) ctx.addIssue({ code: 'custom', message: 'chains must be unique', path: ['chains'] });
    const ids = new Set(plan.contracts.map((contract) => contract.id));
    const deployIds = new Set(plan.steps.filter((step): step is DeployStep => step.kind === 'deploy').map((step) => step.id));
    const checkDeployId = (stepId: string, path: (string | number)[]) => { if (!deployIds.has(stepId)) ctx.addIssue({ code: 'custom', message: 'pointer, target, and library stepIds must name deploy steps', path }); };
    const visitRefs = (value: unknown, path: (string | number)[]) => {
      if (isValueRef(value)) { checkDeployId(value.$ref.stepId, path); return; }
      if (Array.isArray(value)) value.forEach((entry, index) => visitRefs(entry, [...path, index]));
      else if (value && typeof value === 'object') Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => visitRefs(entry, [...path, key]));
    };
    plan.steps.forEach((step, index) => {
      if (step.kind === 'deploy') {
        if (!ids.has(step.contractId)) ctx.addIssue({ code: 'custom', message: 'step contractId must reference a contract', path: ['steps', index, 'contractId'] });
        visitRefs(step.args, ['steps', index, 'args']); visitRefs(step.argsPerChain, ['steps', index, 'argsPerChain']);
        Object.entries(step.libraries ?? {}).forEach(([key, binding]) => { if (binding.kind === 'step') checkDeployId(binding.stepId, ['steps', index, 'libraries', key]); });
        Object.entries(step.librariesPerChain ?? {}).forEach(([chainId, bindings]) => Object.entries(bindings).forEach(([key, binding]) => { if (binding.kind === 'step') checkDeployId(binding.stepId, ['steps', index, 'librariesPerChain', chainId, key]); }));
      } else {
        if (step.target.kind === 'step') checkDeployId(step.target.stepId, ['steps', index, 'target']);
        Object.entries(step.targetPerChain ?? {}).forEach(([chainId, target]) => { if (target.kind === 'step') checkDeployId(target.stepId, ['steps', index, 'targetPerChain', chainId]); });
        visitRefs(step.args, ['steps', index, 'args']); visitRefs(step.argsPerChain, ['steps', index, 'argsPerChain']);
      }
    });
  }),
);

export type LaneStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "aborted";
export type StepStatus =
  | "pending"
  | "estimating"
  | "awaiting-signature"
  | "broadcasting"
  | "confirming"
  | "confirmed"
  | "failed"
  | "skipped";
export type PauseReason =
  | "revert"
  | "estimation"
  | "balance"
  | "broadcast"
  | "rpc"
  | "signer-rejected"
  | "needs-browser"
  | "receipt-timeout"
  | "interrupted"
  | "needs-review"
  | "write-failure"
  | "signer-mismatch"
  | "rpc-binding-changed"
  | 'pointer-unresolved'
  | 'create2-collision'
  | 'created-code-missing';
export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export type ResolveAction =
  | "retry"
  | "edit"
  | "skip"
  | "abort-lane"
  | "recheck"
  | "confirm-hash"
  | "mark-not-sent"
  | "replace"
  | "keep-waiting"
  | 'accept-deployed';

export interface FrozenInput {
  abi: unknown;
  // With link references this is unlinkedCreationCode; otherwise strict Hex.
  creationBytecode: string;
  creationCodeLinkReferences?: LinkReferencesWire;
  // With link references this is unlinkedRuntimeCode; otherwise strict Hex.
  runtimeBytecode?: string;
  runtimeBytecodeLinkReferences?: LinkReferencesWire;
  compiler: { pluginId: string; version: string; settingsHash: string };
  artifactHash: string;
  repoDirty: boolean;
  bundleHash?: string;
}

export type FrozenInputs = Record<string, FrozenInput>;

export interface RpcBinding {
  endpointId: string;
  label: string;
  urlFingerprint: string;
}

export interface ValidationItem {
  ok: boolean;
  blocking: boolean;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ChainChecklist {
  rpc: ValidationItem;
  signers: ValidationItem;
  args: ValidationItem;
  estimation: ValidationItem;
  balance: ValidationItem;
  inputs: ValidationItem;
  verification?: ValidationItem;
  create2?: ValidationItem;
  simulation?: ValidationItem;
}

export interface ValidationReport {
  chains: Record<string, ChainChecklist>;
  run?: {
    workflow?: ValidationItem;
    outputs?: ValidationItem;
  };
}

export type ExternalResolutionVia =
  | { kind: 'artifact'; runId: string }
  | { kind: 'plugin'; pluginId: string };

export interface ExternalResolution {
  stepId: string;
  path: string;
  chainId: number;
  address: Hex;
  source: 'suggestion' | 'manual';
  via?: ExternalResolutionVia;
}

export type ArtifactDriftAcknowledgements = Record<string, { expected: string; actual: string }>;

export interface WorkflowRunRequest {
  repoPathOrUrl: string;
  name: string;
  hooks: string[];
  resolutions?: ExternalResolution[];
  acknowledgeArtifactDrift?: ArtifactDriftAcknowledgements;
}

export interface WorkflowRunBinding extends WorkflowRunRequest {
  docHash: string;
}

export interface HookRunRecord {
  status: 'pending' | 'running' | 'completed' | 'failed';
  jobId?: string;
  notes?: string[];
  error?: string;
}

export interface RepoArtifactOutcome {
  path: string;
  status: 'written' | 'failed';
  error?: string;
  updatedAt: string;
}

// What settled an attempt. recheck/keep-waiting never settle one, so they are
// deliberately absent; abort-run is recordable but is not a lane resolve verb.
export type AttemptResolution =
  | "retry"
  | "edit"
  | "skip"
  | "abort-lane"
  | "abort-run"
  | "confirm-hash"
  | "mark-not-sent"
  | "replace"
  | 'accept-deployed';

export interface Attempt {
  id: string;
  startedAt: string;
  endedAt?: string;
  txHash?: Hex;
  nonce?: number;
  rawTx?: Hex;
  gasUsed?: string;
  effectiveGasPrice?: string;
  blockNumber?: number;
  txStatus?: "success" | "reverted";
  error?: string;
  resolution?: AttemptResolution;
  edits?: {
    gas?: GasOverrides;
    rpcEndpointId?: string;
    argsByStep?: Record<string, ArgValues>;
    targetByStep?: Record<string, CallTarget>;
    librariesByStep?: Record<string, Record<string, LibraryBinding>>;
  };
  expected?: { to: Hex | null; value: string; dataHash: Hex32; libraries?: Record<string, Hex>; pointers?: Record<string, Hex> };
}

export interface LaneStep {
  stepId: string;
  status: StepStatus;
  address?: Hex;
  predictedAddress?: Hex;
  unresolvedTx?: { txHash?: Hex; note?: string };
  attempts: Attempt[];
}

export interface Lane {
  chainId: number;
  status: LaneStatus;
  abortRequested?: boolean;
  currentStepIndex: number;
  pause?: {
    reason: PauseReason;
    stepIndex: number;
    error: string;
    attemptId: string;
    // Typed context for recovery UIs (e.g. the broken pointer's field path).
    details?: Record<string, unknown>;
  };
  steps: LaneStep[];
}

export interface RunRecord {
  schemaVersion: 1;
  id: string;
  profileId: string;
  name: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  plan: DeploymentPlan;
  inputs: FrozenInputs;
  rpcSelection: Record<string, RpcBinding>;
  explorerTargets?: Record<string, ExplorerTargetSnapshot[]>;
  validation: ValidationReport;
  lanes: Record<string, Lane>;
  abortRequested?: boolean;
  status: RunStatus;
  simulationTiers?: Record<string, 'simulateV1' | 'fork' | 'estimate'>;
  workflow?: WorkflowRunBinding;
  hookRuns?: Record<string, HookRunRecord>;
  repoArtifact?: RepoArtifactOutcome;
}

export const LaneStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "aborted",
]) satisfies z.ZodType<LaneStatus>;
export const StepStatusSchema = z.enum([
  "pending",
  "estimating",
  "awaiting-signature",
  "broadcasting",
  "confirming",
  "confirmed",
  "failed",
  "skipped",
]) satisfies z.ZodType<StepStatus>;
export const PauseReasonSchema = z.enum([
  "revert",
  "estimation",
  "balance",
  "broadcast",
  "rpc",
  "signer-rejected",
  "needs-browser",
  "receipt-timeout",
  "interrupted",
  "needs-review",
  "write-failure",
  "signer-mismatch",
  "rpc-binding-changed",
  'pointer-unresolved',
  'create2-collision',
  'created-code-missing',
]) satisfies z.ZodType<PauseReason>;
export const RunStatusSchema = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
]) satisfies z.ZodType<RunStatus>;

function validateBytecodeLinkReferences(input: { code: string; refs?: LinkReferencesWire }, ctx: z.RefinementCtx, field: 'creationBytecode' | 'runtimeBytecode', refsField: 'creationCodeLinkReferences' | 'runtimeBytecodeLinkReferences'): void {
  const refs = input.refs;
  if (!refs || Object.keys(refs).length === 0) {
    if (!HEX.test(input.code)) ctx.addIssue({ code: 'custom', message: `${field} must be strict hex without link references`, path: [field] });
    return;
  }
  const ranges: Array<{ start: number; length: number }> = [];
  for (const file of Object.values(refs)) for (const entries of Object.values(file)) ranges.push(...entries);
  if (!input.code.startsWith('0x') || (input.code.length - 2) % 2 !== 0) { ctx.addIssue({ code: 'custom', message: `unlinked ${field} must be 0x-prefixed byte data`, path: [field] }); return; }
  const bytes = (input.code.length - 2) / 2;
  const covered = new Set<number>();
  for (const range of ranges) {
    if (range.length !== 20 || range.start + range.length > bytes) { ctx.addIssue({ code: 'custom', message: 'link reference must be an in-bounds 20-byte range', path: [refsField] }); return; }
    for (let i = range.start; i < range.start + range.length; i += 1) { if (covered.has(i)) { ctx.addIssue({ code: 'custom', message: 'link references must not overlap', path: [refsField] }); return; } covered.add(i); }
  }
  for (let byte = 0; byte < bytes; byte += 1) if (!/^[0-9a-fA-F]{2}$/.test(input.code.slice(2 + byte * 2, 4 + byte * 2)) && !covered.has(byte)) { ctx.addIssue({ code: 'custom', message: `non-hex ${field} is only allowed inside link-reference ranges`, path: [field] }); return; }
}

// Link-reference containment is cross-field: bytecode itself cannot know
// which placeholder byte ranges are legal. Freeze repeats this check.
export const FrozenInputSchema = z.object({
  abi: z.unknown(),
  creationBytecode: z.string(),
  creationCodeLinkReferences: LinkReferencesWireSchema.optional(),
  // Auxiliary input; capped at 1 MiB of bytes (freeze omits larger) so
  // persisted run records stay bounded.
  runtimeBytecode: z.string().max(2 + 2 * 1024 * 1024).optional(),
  runtimeBytecodeLinkReferences: LinkReferencesWireSchema.optional(),
  compiler: z.object({
    pluginId: z.string().min(1),
    version: z.string().min(1),
    settingsHash: z.string().regex(SHA256_HEX),
  }),
  artifactHash: z.string().regex(SHA256_HEX),
  repoDirty: z.boolean(),
  bundleHash: z.string().regex(SHA256_HEX).optional(),
}).superRefine((input, ctx) => {
  validateBytecodeLinkReferences({ code: input.creationBytecode, refs: input.creationCodeLinkReferences }, ctx, 'creationBytecode', 'creationCodeLinkReferences');
  if (input.runtimeBytecode === undefined && input.runtimeBytecodeLinkReferences !== undefined) ctx.addIssue({ code: 'custom', message: 'runtimeBytecodeLinkReferences requires runtimeBytecode', path: ['runtimeBytecodeLinkReferences'] });
  else if (input.runtimeBytecode !== undefined) validateBytecodeLinkReferences({ code: input.runtimeBytecode, refs: input.runtimeBytecodeLinkReferences }, ctx, 'runtimeBytecode', 'runtimeBytecodeLinkReferences');
}) satisfies z.ZodType<FrozenInput>;

export const RpcBindingSchema = z.object({
  endpointId: z.string().min(1),
  label: z.string(),
  urlFingerprint: z.string().regex(SHA256_HEX),
}) satisfies z.ZodType<RpcBinding>;

export const ValidationItemSchema = z.object({
  ok: z.boolean(),
  blocking: z.boolean(),
  code: z.string().optional(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ValidationItem>;

export const ChainChecklistSchema = z.object({
  rpc: ValidationItemSchema,
  signers: ValidationItemSchema,
  args: ValidationItemSchema,
  estimation: ValidationItemSchema,
  balance: ValidationItemSchema,
  inputs: ValidationItemSchema,
  verification: ValidationItemSchema.optional(),
  create2: ValidationItemSchema.optional(),
  simulation: ValidationItemSchema.optional(),
}) satisfies z.ZodType<ChainChecklist>;

export const ValidationReportSchema = z.object({
  chains: z.record(ChainIdKeySchema, ChainChecklistSchema),
  run: z.object({
    workflow: ValidationItemSchema.optional(),
    outputs: ValidationItemSchema.optional(),
  }).optional(),
}) satisfies z.ZodType<ValidationReport>;

const JSON_POINTER_TOKEN = '(?:[^~/]|~0|~1)+';
const EXTERNAL_RESOLUTION_PATH = new RegExp(`^(?:/target|/args/${JSON_POINTER_TOKEN}(?:/${JSON_POINTER_TOKEN})*|/libraries/${JSON_POINTER_TOKEN})$`);
export const ExternalResolutionViaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), runId: z.string().min(1) }),
  z.object({ kind: z.literal('plugin'), pluginId: z.string().min(1) }),
]) satisfies z.ZodType<ExternalResolutionVia>;
export const ExternalResolutionSchema = z.object({
  stepId: z.string().min(1),
  path: z.string().regex(EXTERNAL_RESOLUTION_PATH, 'path must be a supported RFC 6901 pointer rooted at the step'),
  chainId: z.number().int().positive(),
  address: AddressSchema,
  source: z.enum(['suggestion', 'manual']),
  via: ExternalResolutionViaSchema.optional(),
}) satisfies z.ZodType<ExternalResolution>;
export const ArtifactDriftAcknowledgementsSchema = z.record(z.string().min(1), z.object({
  expected: z.string().regex(SHA256_HEX),
  actual: z.string().regex(SHA256_HEX),
})) satisfies z.ZodType<ArtifactDriftAcknowledgements>;
export const WorkflowRunRequestSchema = z.object({
  repoPathOrUrl: z.string().min(1),
  name: z.string().min(1),
  hooks: z.array(z.string().min(1)).max(16),
  resolutions: z.array(ExternalResolutionSchema).max(4096).optional(),
  acknowledgeArtifactDrift: ArtifactDriftAcknowledgementsSchema.optional(),
}) satisfies z.ZodType<WorkflowRunRequest>;
export const WorkflowRunBindingSchema = WorkflowRunRequestSchema.extend({
  docHash: z.string().regex(SHA256_HEX),
}) satisfies z.ZodType<WorkflowRunBinding>;
export const HookRunRecordSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  jobId: z.string().min(1).optional(),
  notes: z.array(z.string().max(256)).max(8).optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<HookRunRecord>;
export const RepoArtifactOutcomeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['written', 'failed']),
  error: z.string().optional(),
  updatedAt: z.string(),
}) satisfies z.ZodType<RepoArtifactOutcome>;

export const AttemptSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  txHash: HexSchema.optional(),
  nonce: z.number().int().nonnegative().optional(),
  rawTx: HexSchema.optional(),
  gasUsed: DecimalStringSchema.optional(),
  effectiveGasPrice: DecimalStringSchema.optional(),
  blockNumber: z.number().int().nonnegative().optional(),
  txStatus: z.enum(["success", "reverted"]).optional(),
  error: z.string().optional(),
  resolution: z
    .enum([
      "retry",
      "edit",
      "skip",
      "abort-lane",
      "abort-run",
      "confirm-hash",
      "mark-not-sent",
      "replace",
      'accept-deployed',
    ])
    .optional(),
  edits: z
    .object({
      gas: GasOverridesSchema.optional(),
      rpcEndpointId: z.string().min(1).optional(),
      argsByStep: z.record(z.string(), ArgValuesSchema).optional(),
      targetByStep: z.record(z.string(), CallTargetSchema).optional(),
      librariesByStep: z.record(z.string(), z.record(z.string(), LibraryBindingSchema)).optional(),
    })
    .optional(),
  expected: z.object({ to: z.union([AddressSchema, z.null()]), value: DecimalStringSchema, dataHash: Hex32Schema, libraries: z.record(z.string(), AddressSchema).optional(), pointers: z.record(z.string(), AddressSchema).optional() }).optional(),
}) satisfies z.ZodType<Attempt>;

export const LaneStepSchema = z.object({
  stepId: z.string().min(1),
  status: StepStatusSchema,
  address: z.string().regex(HEX_ADDRESS).optional() as z.ZodType<
    Hex | undefined
  >,
  predictedAddress: z.string().regex(HEX_ADDRESS).optional() as z.ZodType<Hex | undefined>,
  unresolvedTx: z
    .object({ txHash: HexSchema.optional(), note: z.string().optional() })
    .optional(),
  attempts: z.array(AttemptSchema),
}) satisfies z.ZodType<LaneStep>;

export const LaneSchema = z.object({
  chainId: z.number().int().positive(),
  status: LaneStatusSchema,
  abortRequested: z.boolean().optional(),
  currentStepIndex: z.number().int().nonnegative(),
  pause: z
    .object({
      reason: PauseReasonSchema,
      stepIndex: z.number().int().nonnegative(),
      error: z.string(),
      attemptId: z.string().min(1),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  steps: z.array(LaneStepSchema),
}) satisfies z.ZodType<Lane>;

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  profileId: z.string().min(1),
  name: z.string().min(1),
  idempotencyKey: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  plan: DeploymentPlanSchema,
  inputs: z.record(z.string(), FrozenInputSchema),
  rpcSelection: z.record(ChainIdKeySchema, RpcBindingSchema),
  explorerTargets: z
    .record(ChainIdKeySchema, z.array(ExplorerTargetSnapshotSchema))
    .optional(),
  validation: ValidationReportSchema,
  lanes: z.record(ChainIdKeySchema, LaneSchema),
  abortRequested: z.boolean().optional(),
  status: RunStatusSchema,
  simulationTiers: z.record(ChainIdKeySchema, z.enum(['simulateV1', 'fork', 'estimate'])).optional(),
  workflow: WorkflowRunBindingSchema.optional(),
  hookRuns: z.record(z.string().min(1), HookRunRecordSchema).optional(),
  repoArtifact: RepoArtifactOutcomeSchema.optional(),
}) satisfies z.ZodType<RunRecord>;

export interface RunEvent {
  epoch: string;
  seq: number;
  ts: number;
  kind: "lane" | "run";
  chainId?: number;
  lane?: Lane;
  runPatch?: { status: RunStatus; abortRequested?: boolean };
}

export const RunEventSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  kind: z.enum(["lane", "run"]),
  chainId: z.number().int().positive().optional(),
  lane: LaneSchema.optional(),
  runPatch: z
    .object({ status: RunStatusSchema, abortRequested: z.boolean().optional() })
    .optional(),
}) satisfies z.ZodType<RunEvent>;

export interface PauseContext {
  reason: PauseReason;
  capability: "sign-only" | "sign-and-send";
  submitted: boolean;
  hasIntent: boolean;
}

const PRE_SUBMISSION_ACTIONS: ResolveAction[] = [
  "retry",
  "edit",
  "skip",
  "abort-lane",
];
const REVERT_ACTIONS: ResolveAction[] = ["retry", "edit", "skip", "abort-lane"];
const SIGN_ONLY_TIMEOUT_ACTIONS: ResolveAction[] = [
  "recheck",
  "replace",
  "keep-waiting",
  "abort-lane",
];
const SIGN_AND_SEND_TIMEOUT_ACTIONS: ResolveAction[] = [
  "recheck",
  "confirm-hash",
  "mark-not-sent",
  "keep-waiting",
  "abort-lane",
];
const SIGN_AND_SEND_UNKNOWN_HASH_ACTIONS: ResolveAction[] = [
  "confirm-hash",
  "mark-not-sent",
  "abort-lane",
];
const NEEDS_REVIEW_ACTIONS: ResolveAction[] = [
  "recheck",
  "confirm-hash",
  "mark-not-sent",
  "skip",
  "abort-lane",
];
const NEEDS_REVIEW_UNKNOWN_HASH_ACTIONS: ResolveAction[] = [
  "confirm-hash",
  "mark-not-sent",
  "skip",
  "abort-lane",
];

export function allowedActions(ctx: PauseContext): ResolveAction[] {
  if (ctx.reason === 'pointer-unresolved') return PRE_SUBMISSION_ACTIONS;
  if (ctx.reason === 'create2-collision') return ['accept-deployed', 'retry', 'skip', 'abort-lane'];
  if (ctx.reason === 'created-code-missing') return ['recheck', 'abort-lane'];
  if (ctx.reason === "revert") return REVERT_ACTIONS;
  if (ctx.reason === "receipt-timeout") {
    if (!ctx.submitted) return ctx.hasIntent ? SIGN_AND_SEND_UNKNOWN_HASH_ACTIONS : SIGN_AND_SEND_UNKNOWN_HASH_ACTIONS.filter((action) => action !== 'confirm-hash');
    return ctx.capability === "sign-only"
      ? SIGN_ONLY_TIMEOUT_ACTIONS
      : SIGN_AND_SEND_TIMEOUT_ACTIONS;
  }
  if (ctx.reason === "needs-review") return ctx.submitted ? NEEDS_REVIEW_ACTIONS : (ctx.hasIntent ? NEEDS_REVIEW_UNKNOWN_HASH_ACTIONS : NEEDS_REVIEW_UNKNOWN_HASH_ACTIONS.filter((action) => action !== 'confirm-hash'));
  // All remaining pause reasons are classified by the engine as failures
  // before submission. `submitted` is carried so callers cannot discard the
  // fact, but no additional submitted state is legal for these reasons.
  return ctx.submitted ? SIGN_AND_SEND_TIMEOUT_ACTIONS : PRE_SUBMISSION_ACTIONS;
}

export interface ResolveLaneRequestBase {
  attemptId: string;
  commandId: string;
}

export type ResolveLaneRequest =
  | (ResolveLaneRequestBase & { action: "retry" })
  | (ResolveLaneRequestBase & {
      action: "edit";
      edits: {
        gas?: GasOverrides;
        rpcEndpointId?: string;
    argsByStep?: Record<string, ArgValues>;
    targetByStep?: Record<string, CallTarget>;
    librariesByStep?: Record<string, Record<string, LibraryBinding>>;
      };
    })
  | (ResolveLaneRequestBase & { action: "skip"; note?: string })
  | (ResolveLaneRequestBase & { action: "abort-lane" })
  | (ResolveLaneRequestBase & { action: 'accept-deployed' })
  | (ResolveLaneRequestBase & { action: "recheck" })
  | (ResolveLaneRequestBase & { action: "confirm-hash"; txHash: Hex })
  | (ResolveLaneRequestBase & { action: "mark-not-sent" })
  | (ResolveLaneRequestBase & {
      action: "replace";
      gas: {
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
        gasLimit?: string;
      };
    })
  | (ResolveLaneRequestBase & { action: "keep-waiting" });

const ResolveLaneRequestBaseSchema = {
  attemptId: z.string().min(1),
  commandId: z.string().min(1),
};

export const ResolveLaneRequestSchema = createRequestSchema<ResolveLaneRequest>(
  "ResolveLaneRequestSchema",
)(
  z.discriminatedUnion("action", [
    z.object({ ...ResolveLaneRequestBaseSchema, action: z.literal("retry") }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("edit"),
      edits: z.object({
        gas: GasOverridesSchema.optional(),
        rpcEndpointId: z.string().min(1).optional(),
        argsByStep: z.record(z.string(), ArgValuesSchema).optional(),
        targetByStep: z.record(z.string(), CallTargetSchema).optional(),
        librariesByStep: z.record(z.string(), z.record(z.string(), LibraryBindingSchema)).optional(),
      }),
    }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("skip"),
      note: z.string().optional(),
    }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("abort-lane"),
    }),
    z.object({ ...ResolveLaneRequestBaseSchema, action: z.literal('accept-deployed') }),
    z.object({ ...ResolveLaneRequestBaseSchema, action: z.literal("recheck") }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("confirm-hash"),
      txHash: HexSchema,
    }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("mark-not-sent"),
    }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("replace"),
      gas: z.object({
        maxFeePerGas: DecimalStringSchema,
        maxPriorityFeePerGas: DecimalStringSchema,
        gasLimit: DecimalStringSchema.optional(),
      }),
    }),
    z.object({
      ...ResolveLaneRequestBaseSchema,
      action: z.literal("keep-waiting"),
    }),
  ]),
);

export interface RpcSelection {
  [chainId: string]: string;
}

export interface ValidateDeploymentRequest {
  plan: DeploymentPlan;
  rpcSelection: RpcSelection;
  explorerSelection?: Record<string, string[]>;
  workflow?: WorkflowRunRequest;
}

export interface ValidateDeploymentData {
  chains: Record<string, ChainChecklist>;
  run?: ValidationReport['run'];
  frozenCandidates?: FrozenInputs;
}

// Server-authoritative preview: the client supplies draft plan context, never
// resolved addresses. Batch B2 supplies the handler and spreads this route.
export interface PrepareStepRequest { contracts: ContractSource[]; steps: Step[]; stepId: string; chainIds: number[]; }
export interface PrepareStepData { chains: Record<string, { salt: Hex32; predictedAddress: Hex; initcodeHash: Hex32; notes: string[] }> }
export const PrepareStepRequestSchema = createRequestSchema<PrepareStepRequest>('PrepareStepRequestSchema')(
  z.object({ contracts: z.array(ContractSourceSchema).min(1), steps: z.array(StepSchema).min(1), stepId: z.string().min(1), chainIds: z.array(z.number().int().positive()).min(1) }).superRefine((request, ctx) => {
    const plan = DeploymentPlanSchema.safeParse({ schemaVersion: 1, contracts: request.contracts, steps: request.steps, chains: request.chainIds, signers: {} });
    if (!plan.success) for (const issue of plan.error.issues) ctx.addIssue({ ...issue, path: issue.path });
    if (!request.steps.some((step) => step.id === request.stepId && step.kind === 'deploy')) ctx.addIssue({ code: 'custom', message: 'stepId must name a deploy step', path: ['stepId'] });
  }),
);
export const PrepareStepResponseSchema = createApiResponseSchema<PrepareStepData>('PrepareStepResponseSchema')(
  z.object({ chains: z.record(ChainIdKeySchema, z.object({ salt: Hex32Schema, predictedAddress: AddressSchema, initcodeHash: Hex32Schema, notes: z.array(z.string()) })) }),
);

export interface PointerSuggestionRequest {
  workflow?: { repoPathOrUrl: string; name: string };
  sourceId?: string;
  expectedArtifactHash?: string;
  contractName: string;
  chainIds: number[];
}
export type PointerSuggestionSource =
  | { kind: 'artifact'; runId: string; at: string }
  | { kind: 'plugin'; pluginId: string; label?: string };
export interface PointerSuggestion {
  address: Hex;
  match: 'artifact-hash' | 'name';
  versionLabel?: string;
  sources: PointerSuggestionSource[];
}
export interface PointerSuggestionData {
  suggestionsByChain: Record<string, PointerSuggestion[]>;
  truncated: boolean;
}
export const PointerSuggestionRequestSchema = createRequestSchema<PointerSuggestionRequest>('PointerSuggestionRequestSchema')(
  z.object({
    workflow: z.object({ repoPathOrUrl: z.string().min(1), name: z.string().min(1) }).strict().optional(),
    sourceId: z.string().min(1).optional(),
    expectedArtifactHash: z.string().regex(SHA256_HEX).optional(),
    contractName: z.string().min(1).max(256),
    chainIds: z.array(z.number().int().positive()).min(1).max(128),
  }).strict().superRefine((request, ctx) => {
    if (new Set(request.chainIds).size !== request.chainIds.length)
      ctx.addIssue({ code: 'custom', message: 'chainIds must be unique', path: ['chainIds'] });
    if (request.sourceId && !request.workflow)
      ctx.addIssue({ code: 'custom', message: 'sourceId requires workflow', path: ['sourceId'] });
  }),
);
const PointerSuggestionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), runId: z.string().min(1), at: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('plugin'), pluginId: z.string().min(1), label: z.string().max(256).optional() }).strict(),
]);
export const PointerSuggestionSchema = z.object({
  address: AddressSchema,
  match: z.enum(['artifact-hash', 'name']),
  versionLabel: z.string().max(256).optional(),
  sources: z.array(PointerSuggestionSourceSchema).min(1).max(576),
}).strict() satisfies z.ZodType<PointerSuggestion>;
export const PointerSuggestionResponseSchema = createApiResponseSchema<PointerSuggestionData>('PointerSuggestionResponseSchema')(
  z.object({ suggestionsByChain: z.record(ChainIdKeySchema, z.array(PointerSuggestionSchema).max(8)), truncated: z.boolean() }).strict(),
);

export interface CreateRunRequest extends ValidateDeploymentRequest {
  name?: string;
  idempotencyKey: string;
}

export interface CreateRunData {
  run: RunRecord;
}

export interface ListRunsQuery {
  active?: "true" | "false";
}

export interface RunSummary {
  id: string;
  profileId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  chains: number[];
  workflow?: { name: string };
}

export interface ListRunsData {
  runs: RunSummary[];
  unreadable?: string[];
}

export interface GetRunData {
  run: RunRecord;
}

export interface GetDeploymentArtifactData {
  artifact: DeploymentArtifact;
}

// Portable, committable projection of a run record. It intentionally has no
// raw transaction, RPC URL/fingerprint, or repository identity fields.
export interface DeploymentArtifactAttempt {
  id: string;
  startedAt: string;
  endedAt?: string;
  txHash?: Hex;
  nonce?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
  blockNumber?: number;
  txStatus?: "success" | "reverted";
  error?: string;
  resolution?: AttemptResolution;
  edits?: Attempt["edits"];
  expected?: Attempt['expected'];
}

export interface DeploymentArtifact {
  schemaVersion: 2;
  runId: string;
  profileId: string;
  name: string;
  status: RunStatus;
  abortRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  workflow?: { name: string; docHash: string };
  contracts: Array<{
    id: string;
    repoName: string;
    sourcePath: string;
    contractName: string;
    artifactHash: string;
    compiler: FrozenInput["compiler"];
    versionLabel?: string;
  }>;
  validation: ValidationReport;
  lanes: Record<
    string,
    {
      chainId: number;
      status: LaneStatus;
      providerLabel: string;
      simulationTier?: 'simulateV1' | 'fork' | 'estimate';
      pause?: { reason: PauseReason; error: string };
      steps: Array<{
        stepId: string;
        kind: 'deploy' | 'call';
        contractId: string;
        status: StepStatus;
        note?: string;
        args: ArgValues;
        value: string;
        gasOverrides?: GasOverrides;
        signerAddress?: string;
        address?: Hex;
        unresolvedTx?: { txHash?: Hex; note?: string };
        strategy?: { kind: 'create' | 'create2' | 'plugin'; pluginId?: string; salt?: Hex32; predictedAddress?: Hex };
        libraries?: Array<{ key: string; address: Hex; source: 'literal' | { stepId: string } }>;
        call?: { target: Hex; targetSource: 'literal' | { stepId: string }; signature?: string };
        pointers?: Array<{ path: string; stepId: string; address: Hex; source?: 'step' | 'suggestion' | 'manual'; via?: string }>;
        attempts: DeploymentArtifactAttempt[];
      }>;
    }
  >;
  verifications?: Record<
    string,
    Array<{
      chainId: number;
      address: Hex;
      explorerLabel: string;
      explorerPageUrl?: string;
      status: VerificationStatus;
      updatedAt: string;
    }>
  >;
}

export const RpcSelectionSchema = z.record(ChainIdKeySchema, z.string().min(1));
export const DeploymentExplorerSelectionSchema = z.record(
  ChainIdKeySchema,
  z.array(z.string().min(1)),
);

export const ValidateDeploymentRequestSchema =
  createRequestSchema<ValidateDeploymentRequest>(
    "ValidateDeploymentRequestSchema",
  )(
    z.object({
      plan: DeploymentPlanSchema,
      rpcSelection: RpcSelectionSchema,
      explorerSelection: DeploymentExplorerSelectionSchema.optional(),
      workflow: WorkflowRunRequestSchema.optional(),
    }),
  );

export const ValidateDeploymentResponseSchema =
  createApiResponseSchema<ValidateDeploymentData>(
    "ValidateDeploymentResponseSchema",
  )(
    z.object({
      chains: z.record(ChainIdKeySchema, ChainChecklistSchema),
      run: ValidationReportSchema.shape.run,
      frozenCandidates: z.record(z.string(), FrozenInputSchema).optional(),
    }),
  );

export const CreateRunRequestSchema = createRequestSchema<CreateRunRequest>(
  "CreateRunRequestSchema",
)(
  z.object({
    plan: DeploymentPlanSchema,
    rpcSelection: RpcSelectionSchema,
    explorerSelection: DeploymentExplorerSelectionSchema.optional(),
    workflow: WorkflowRunRequestSchema.optional(),
    name: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
  }),
);

export const CreateRunResponseSchema = createApiResponseSchema<CreateRunData>(
  "CreateRunResponseSchema",
)(z.object({ run: RunRecordSchema }));

export const ListRunsQuerySchema = z.object({
  active: z.enum(["true", "false"]).optional(),
});

export const RunSummarySchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: RunStatusSchema,
  chains: z.array(z.number().int().positive()),
  workflow: z.object({ name: z.string().min(1) }).optional(),
}) satisfies z.ZodType<RunSummary>;

export const ListRunsResponseSchema = createApiResponseSchema<ListRunsData>(
  "ListRunsResponseSchema",
)(
  z.object({
    runs: z.array(RunSummarySchema),
    unreadable: z.array(z.string()).optional(),
  }),
);

export const GetRunResponseSchema = createApiResponseSchema<GetRunData>(
  "GetRunResponseSchema",
)(z.object({ run: RunRecordSchema }));

export const ResolveLaneResponseSchema = createApiResponseSchema<GetRunData>(
  "ResolveLaneResponseSchema",
)(z.object({ run: RunRecordSchema }));

export const ResumeRunResponseSchema = createApiResponseSchema<GetRunData>(
  "ResumeRunResponseSchema",
)(z.object({ run: RunRecordSchema }));

export const AbortRunResponseSchema = createApiResponseSchema<GetRunData>(
  "AbortRunResponseSchema",
)(z.object({ run: RunRecordSchema }));

export const GetDeploymentArtifactResponseSchema =
  createApiResponseSchema<GetDeploymentArtifactData>(
    "GetDeploymentArtifactResponseSchema",
  )(z.object({ artifact: z.lazy(() => DeploymentArtifactSchema) }));

export const DeploymentArtifactAttemptSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  txHash: HexSchema.optional(),
  nonce: z.number().int().nonnegative().optional(),
  gasUsed: DecimalStringSchema.optional(),
  effectiveGasPrice: DecimalStringSchema.optional(),
  blockNumber: z.number().int().nonnegative().optional(),
  txStatus: z.enum(["success", "reverted"]).optional(),
  error: z.string().optional(),
  resolution: AttemptSchema.shape.resolution,
  edits: AttemptSchema.shape.edits,
  expected: AttemptSchema.shape.expected,
}) satisfies z.ZodType<DeploymentArtifactAttempt>;

export const DeploymentArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  profileId: z.string().min(1),
  name: z.string().min(1),
  status: RunStatusSchema,
  abortRequested: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  workflow: z.object({ name: z.string().min(1), docHash: z.string().regex(SHA256_HEX) }).optional(),
  contracts: z.array(
    z.object({
      id: z.string().min(1),
      repoName: z.string().min(1),
      sourcePath: z.string().min(1),
      contractName: z.string().min(1),
      artifactHash: z.string().regex(SHA256_HEX),
      compiler: FrozenInputSchema.shape.compiler,
      versionLabel: z.string().min(1).optional(),
    })
  ),
  validation: ValidationReportSchema,
  lanes: z.record(
    ChainIdKeySchema,
    z.object({
      chainId: z.number().int().positive(),
      status: LaneStatusSchema,
      providerLabel: z.string(),
      simulationTier: z.enum(['simulateV1', 'fork', 'estimate']).optional(),
      pause: z.object({ reason: PauseReasonSchema, error: z.string() }).optional(),
      steps: z.array(
        z.object({
          stepId: z.string().min(1),
          kind: z.enum(['deploy', 'call']),
          contractId: z.string().min(1),
          status: StepStatusSchema,
          note: z.string().min(1).optional(),
          args: ArgValuesSchema,
          value: DecimalStringSchema,
          gasOverrides: GasOverridesSchema.optional(),
          signerAddress: z.string().regex(HEX_ADDRESS).optional(),
          address: z.string().regex(HEX_ADDRESS).optional() as z.ZodType<
            Hex | undefined
          >,
          unresolvedTx: z
            .object({ txHash: HexSchema.optional(), note: z.string().optional() })
            .optional(),
          strategy: z.object({ kind: z.enum(['create', 'create2', 'plugin']), pluginId: z.string().min(1).optional(), salt: Hex32Schema.optional(), predictedAddress: AddressSchema.optional() }).optional(),
          libraries: z.array(z.object({ key: z.string().min(1), address: AddressSchema, source: z.union([z.literal('literal'), z.object({ stepId: z.string().min(1) })]) })).optional(),
          call: z.object({ target: AddressSchema, targetSource: z.union([z.literal('literal'), z.object({ stepId: z.string().min(1) })]), signature: z.string().min(1).optional() }).optional(),
          pointers: z.array(z.object({ path: z.string().min(1), stepId: z.string().min(1), address: AddressSchema, source: z.enum(['step', 'suggestion', 'manual']).optional(), via: z.string().max(256).optional() })).optional(),
          attempts: z.array(DeploymentArtifactAttemptSchema),
        })
      ),
    })
  ),
  verifications: z
    .record(
      z.string(),
      z.array(
        z.object({
          chainId: z.number().int().positive(),
          address: z.string().regex(HEX_ADDRESS) as z.ZodType<Hex>,
          explorerLabel: z.string().min(1),
          explorerPageUrl: z.string().url().optional(),
          status: VerificationStatusSchema,
          updatedAt: z.string(),
        }),
      ),
    )
    .optional(),
}) satisfies z.ZodType<DeploymentArtifact>;

export const RunIdParamsSchema = z.object({ runId: z.string().min(1) });
export const ResolveLaneParamsSchema = z.object({
  runId: z.string().min(1),
  chainId: ChainIdKeySchema,
});

export const deploymentRoutes = {
  validateDeployment: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/deployments/validate`,
    schema: {
      tags: ["deployments"],
      body: ValidateDeploymentRequestSchema,
      response: { 200: ValidateDeploymentResponseSchema },
    },
  },
  createDeploymentRun: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/deployments/runs`,
    schema: {
      tags: ["deployments"],
      body: CreateRunRequestSchema,
      response: { 200: CreateRunResponseSchema },
    },
  },
  listDeploymentRuns: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/deployments/runs`,
    querystring: ListRunsQuerySchema,
    schema: {
      tags: ["deployments"],
      response: { 200: ListRunsResponseSchema },
    },
  },
  getDeploymentRun: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/deployments/runs/:runId`,
    params: RunIdParamsSchema,
    schema: { tags: ["deployments"], response: { 200: GetRunResponseSchema } },
  },
  resolveDeploymentLane: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/deployments/runs/:runId/lanes/:chainId/resolve`,
    params: ResolveLaneParamsSchema,
    schema: {
      tags: ["deployments"],
      body: ResolveLaneRequestSchema,
      response: { 200: ResolveLaneResponseSchema },
    },
  },
  resumeDeploymentRun: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/deployments/runs/:runId/resume`,
    params: RunIdParamsSchema,
    schema: {
      tags: ["deployments"],
      response: { 200: ResumeRunResponseSchema },
    },
  },
  abortDeploymentRun: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/deployments/runs/:runId/abort`,
    params: RunIdParamsSchema,
    schema: {
      tags: ["deployments"],
      response: { 200: AbortRunResponseSchema },
    },
  },
  getDeploymentArtifact: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/deployments/runs/:runId/artifact`,
    params: RunIdParamsSchema,
    schema: {
      tags: ["deployments"],
      response: { 200: GetDeploymentArtifactResponseSchema },
    },
  },
  pointerSuggestions: {
    method: 'POST' as const,
    path: `${V1_BASE_PATH}/deployments/pointer-suggestions`,
    schema: { tags: ['deployments'], body: PointerSuggestionRequestSchema, response: { 200: PointerSuggestionResponseSchema } },
  },
} as const;

// Deliberately not spread into deploymentRoutes: B2 installs the handler.
// Keeping it exported makes the request/response contract available now.
export const prepareDeploymentStepRoute = {
  method: 'POST' as const,
  path: `${V1_BASE_PATH}/deployments/steps/prepare`,
  schema: { tags: ['deployments'], body: PrepareStepRequestSchema, response: { 200: PrepareStepResponseSchema } },
} as const;
