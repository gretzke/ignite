// Deployment-run plan, persistence, and HTTP contracts. Run records never
// contain RPC URLs: only endpoint identity and a URL fingerprint are durable.
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";

const DECIMAL = /^\d+$/;
const CHAIN_ID_KEY = /^[1-9]\d*$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export type Hex = `0x${string}`;
export type ArgValues = Record<string, unknown>;

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
}

export type Step = DeployStep;

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

export const ContractSourceSchema = z.object({
  id: z.string().min(1),
  repoPathOrUrl: z.string().min(1),
  frameworkId: z.string().min(1),
  artifactPath: z.string().min(1),
  contractName: z.string().min(1),
  sourcePath: z.string().min(1),
}) satisfies z.ZodType<ContractSource>;

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
}) satisfies z.ZodType<DeployStep>;

export const StepSchema = z.discriminatedUnion("kind", [DeployStepSchema]);

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
    plan.steps.forEach((step, index) => { if (!ids.has(step.contractId)) ctx.addIssue({ code: 'custom', message: 'step contractId must reference a contract', path: ['steps', index, 'contractId'] }); });
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
  | "rpc-binding-changed";
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
  | "keep-waiting";

export interface FrozenInput {
  abi: unknown;
  creationBytecode: Hex;
  compiler: { pluginId: string; version: string; settingsHash: string };
  artifactHash: string;
  repoDirty: boolean;
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
}

export interface ValidationReport {
  chains: Record<string, ChainChecklist>;
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
  | "replace";

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
  };
}

export interface LaneStep {
  stepId: string;
  status: StepStatus;
  address?: Hex;
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
  validation: ValidationReport;
  lanes: Record<string, Lane>;
  abortRequested?: boolean;
  status: RunStatus;
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
]) satisfies z.ZodType<PauseReason>;
export const RunStatusSchema = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
]) satisfies z.ZodType<RunStatus>;

export const FrozenInputSchema = z.object({
  abi: z.unknown(),
  creationBytecode: HexSchema,
  compiler: z.object({
    pluginId: z.string().min(1),
    version: z.string().min(1),
    settingsHash: z.string().regex(SHA256_HEX),
  }),
  artifactHash: z.string().regex(SHA256_HEX),
  repoDirty: z.boolean(),
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
}) satisfies z.ZodType<ChainChecklist>;

export const ValidationReportSchema = z.object({
  chains: z.record(ChainIdKeySchema, ChainChecklistSchema),
}) satisfies z.ZodType<ValidationReport>;

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
    ])
    .optional(),
  edits: z
    .object({
      gas: GasOverridesSchema.optional(),
      rpcEndpointId: z.string().min(1).optional(),
      argsByStep: z.record(z.string(), ArgValuesSchema).optional(),
    })
    .optional(),
}) satisfies z.ZodType<Attempt>;

export const LaneStepSchema = z.object({
  stepId: z.string().min(1),
  status: StepStatusSchema,
  address: z.string().regex(HEX_ADDRESS).optional() as z.ZodType<
    Hex | undefined
  >,
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
  validation: ValidationReportSchema,
  lanes: z.record(ChainIdKeySchema, LaneSchema),
  abortRequested: z.boolean().optional(),
  status: RunStatusSchema,
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
const NEEDS_REVIEW_ACTIONS: ResolveAction[] = [
  "recheck",
  "confirm-hash",
  "mark-not-sent",
  "skip",
  "abort-lane",
];

export function allowedActions(ctx: PauseContext): ResolveAction[] {
  if (ctx.reason === "revert") return REVERT_ACTIONS;
  if (ctx.reason === "receipt-timeout") {
    return ctx.capability === "sign-only"
      ? SIGN_ONLY_TIMEOUT_ACTIONS
      : SIGN_AND_SEND_TIMEOUT_ACTIONS;
  }
  if (ctx.reason === "needs-review") return NEEDS_REVIEW_ACTIONS;
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
      };
    })
  | (ResolveLaneRequestBase & { action: "skip"; note?: string })
  | (ResolveLaneRequestBase & { action: "abort-lane" })
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
}

export interface ValidateDeploymentData {
  chains: Record<string, ChainChecklist>;
  frozenCandidates?: FrozenInputs;
}

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
}

export interface DeploymentArtifact {
  schemaVersion: 1;
  runId: string;
  profileId: string;
  name: string;
  status: RunStatus;
  abortRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  contracts: Array<{
    id: string;
    repoName: string;
    sourcePath: string;
    contractName: string;
    artifactHash: string;
    compiler: FrozenInput["compiler"];
  }>;
  validation: ValidationReport;
  lanes: Record<
    string,
    {
      chainId: number;
      status: LaneStatus;
      providerLabel: string;
      pause?: { reason: PauseReason; error: string };
      steps: Array<{
        stepId: string;
        status: StepStatus;
        args: ArgValues;
        value: string;
        gasOverrides?: GasOverrides;
        signerAddress?: string;
        address?: Hex;
        unresolvedTx?: { txHash?: Hex; note?: string };
        attempts: DeploymentArtifactAttempt[];
      }>;
    }
  >;
}

export const RpcSelectionSchema = z.record(ChainIdKeySchema, z.string().min(1));

export const ValidateDeploymentRequestSchema =
  createRequestSchema<ValidateDeploymentRequest>(
    "ValidateDeploymentRequestSchema",
  )(z.object({ plan: DeploymentPlanSchema, rpcSelection: RpcSelectionSchema }));

export const ValidateDeploymentResponseSchema =
  createApiResponseSchema<ValidateDeploymentData>(
    "ValidateDeploymentResponseSchema",
  )(
    z.object({
      chains: z.record(ChainIdKeySchema, ChainChecklistSchema),
      frozenCandidates: z.record(z.string(), FrozenInputSchema).optional(),
    }),
  );

export const CreateRunRequestSchema = createRequestSchema<CreateRunRequest>(
  "CreateRunRequestSchema",
)(
  z.object({
    plan: DeploymentPlanSchema,
    rpcSelection: RpcSelectionSchema,
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
}) satisfies z.ZodType<DeploymentArtifactAttempt>;

export const DeploymentArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  profileId: z.string().min(1),
  name: z.string().min(1),
  status: RunStatusSchema,
  abortRequested: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  contracts: z.array(
    z.object({
      id: z.string().min(1),
      repoName: z.string().min(1),
      sourcePath: z.string().min(1),
      contractName: z.string().min(1),
      artifactHash: z.string().regex(SHA256_HEX),
      compiler: FrozenInputSchema.shape.compiler,
    })
  ),
  validation: ValidationReportSchema,
  lanes: z.record(
    ChainIdKeySchema,
    z.object({
      chainId: z.number().int().positive(),
      status: LaneStatusSchema,
      providerLabel: z.string(),
      pause: z.object({ reason: PauseReasonSchema, error: z.string() }).optional(),
      steps: z.array(
        z.object({
          stepId: z.string().min(1),
          status: StepStatusSchema,
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
          attempts: z.array(DeploymentArtifactAttemptSchema),
        })
      ),
    })
  ),
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
} as const;
