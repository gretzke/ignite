// Persisted workflow documents are collaborator-authored input.  Keep this
// schema deliberately independent from the (permissive) D5 plan schemas: a
// workflow must reject, rather than strip, unknown structured fields.
import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema } from '../utils/schema.js';
import { JobStartedResponseSchema } from './jobs.js';
import { DeploymentPlanSchema, type DeploymentPlan } from './deployments.js';
import { PluginVersionInfoSchema, type PluginVersionInfoData } from './plugins/versions.js';

const CHAIN_ID_KEY = /^[1-9]\d*$/;
const DECIMAL = /^\d+$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const COMMIT = /^[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const WorkflowNamePattern = /^[a-z0-9][a-z0-9-_]{0,63}$/;
// Deployment runs are minted with crypto.randomUUID(). Keep promotion and
// storage paths on that exact, single-segment UUIDv4 shape.
export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_STEP_PAYLOAD_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 12;

export interface WorkflowPin {
  url: string;
  commit: string;
  ref?: string;
  refKind?: 'tag' | 'branch';
}

export interface WorkflowContractTypeSourceRef {
  pluginId: string;
  artifactKey: string;
  versionLabel: string;
  contentHash: string;
}

export interface RepoWorkflowSource {
  id: string;
  origin?: 'repo';
  repo: WorkflowPin;
  frameworkId: string;
  sourcePath: string;
  contractName: string;
  artifactPath: string;
  artifactHash?: string;
}

export type ContractTypeWorkflowSource = { id: string; origin: 'contract-type'; contractName: string } & WorkflowContractTypeSourceRef;
export type WorkflowSource = RepoWorkflowSource | ContractTypeWorkflowSource;

export type WorkflowPluginSource =
  | { kind: 'local'; contextDir: string; dockerfile?: string }
  | { kind: 'git'; url: string; ref?: string; track?: { mode: 'release'; version: string } | { mode: 'branch'; branch: string } | { mode: 'commit' }; commit?: string };

export interface WorkflowRequiredPlugin {
  id: string;
  version: string;
  source?: WorkflowPluginSource;
}

export interface WorkflowOutputs { hooks: string[] }
export interface WorkflowValueRef { $ref: { kind: 'step'; stepId: string } }
export type WorkflowLibraryBinding = { kind: 'address'; address: string } | { kind: 'step'; stepId: string };
export type WorkflowCallTarget = { kind: 'address'; address: string } | { kind: 'step'; stepId: string };
export type WorkflowDeployStrategy =
  | { kind: 'create' }
  | { kind: 'create2'; salt: string; saltPerChain?: Record<string, string>; acknowledgeDeployed?: Record<string, { predictedAddress: string; initcodeHash: string }> }
  | { kind: 'plugin'; pluginId: string; params?: Record<string, unknown>; salt?: string; saltPerChain?: Record<string, string>; prepared?: Record<string, { initcodeHash: string; predictedAddress: string }>; acknowledgeDeployed?: Record<string, { predictedAddress: string; initcodeHash: string }> };
export type WorkflowStep =
  | { id: string; kind: 'deploy'; contractId: string; args?: Record<string, unknown>; argsPerChain?: Record<string, Record<string, unknown>>; value?: string; valuePerChain?: Record<string, string>; gasOverrides?: WorkflowGasOverrides; gasOverridesPerChain?: Record<string, Partial<WorkflowGasOverrides>>; strategy?: WorkflowDeployStrategy; libraries?: Record<string, WorkflowLibraryBinding>; librariesPerChain?: Record<string, Record<string, WorkflowLibraryBinding>>; wraps?: { stepId: string; contractTypePluginId: string }; acknowledgeUninitialized?: true; acknowledgeUnverifiedBytecode?: true }
  | { id: string; kind: 'call'; target: WorkflowCallTarget; targetPerChain?: Record<string, WorkflowCallTarget>; signature?: string; payable?: boolean; args?: Record<string, unknown>; argsPerChain?: Record<string, Record<string, unknown>>; value?: string; valuePerChain?: Record<string, string>; gasOverrides?: WorkflowGasOverrides; gasOverridesPerChain?: Record<string, Partial<WorkflowGasOverrides>> };
export interface WorkflowGasOverrides { gasLimit?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string }

export interface WorkflowDocument {
  schemaVersion: 1;
  description?: string;
  sources: WorkflowSource[];
  steps: WorkflowStep[];
  // deprecated: ignored, retained so existing documents validate
  defaultChains?: number[];
  requiredPlugins: WorkflowRequiredPlugin[];
  outputs: WorkflowOutputs;
}

export interface WorkflowSummary {
  name: string;
  valid: boolean;
  error?: string;
  description?: string;
  sourceCount?: number;
  stepCount?: number;
  hooks?: string[];
}

export type WorkflowSourceReadiness = { id: string; status: 'ready' | 'cloning' | 'compiling' } | { id: string; status: 'failed'; reason: string };
export type WorkflowPluginReadiness =
  | { id: string; status: 'installed'; installedVersion: string }
  | { id: string; status: 'version-mismatch'; installedVersion: string }
  | { id: string; status: 'missing' }
  | { id: string; status: 'untrusted'; installedVersion: string };
export interface WorkflowResolveResult { sources: WorkflowSourceReadiness[]; plugins: WorkflowPluginReadiness[] }

export interface WorkflowPromotionSourcePreview { sourceId: string; origin: string; commit: string; tagChoices: string[]; dirty: boolean; error?: string }
export type WorkflowPromoteRequest =
  | { mode: 'preview'; target: { repoPathOrUrl: string; name: string }; plan?: DeploymentPlan; runId?: string }
  | { mode: 'apply'; previewId: string; target: { repoPathOrUrl: string; name: string }; plan?: DeploymentPlan; runId?: string; tagChoiceBySourceId?: Record<string, string>; overwrite?: boolean; hooks: string[]; adoptRunIds?: string[] };
export type WorkflowPromoteData =
  | { mode: 'preview'; previewId: string; sources: WorkflowPromotionSourcePreview[]; nameCollision: boolean }
  | { mode: 'apply'; workflow: WorkflowSummary; docHash: string };
export interface WorkflowCheckUpdatesRequest { repoPathOrUrl: string; name: string }
export type WorkflowSourceUpdate = {
  sourceId: string;
  status: 'up-to-date' | 'upgrade-available' | 'tag-retargeted' | 'tag-deleted' | 'branch-moved' | 'approval-required' | 'contract-type-drift' | 'error';
  currentCommit?: string;
  currentContentHash?: string;
  latestContentHash?: string;
  origin?: string;
  latestCommit?: string;
  upgrades?: Array<{ ref: string; commit: string; version: string }>;
  error?: string;
};
export interface WorkflowPluginUpdate {
  id: string;
  requiredVersion: string;
  status: 'installed' | 'version-mismatch' | 'missing';
  installedVersion?: string;
  updateAvailable: boolean;
  update?: PluginVersionInfoData;
}
export interface WorkflowCheckUpdatesData { sources: WorkflowSourceUpdate[]; plugins: WorkflowPluginUpdate[] }

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  if (Array.isArray(value)) return value.reduce((max, entry) => Math.max(max, jsonDepth(entry, depth + 1)), depth + 1);
  return Object.values(value as Record<string, unknown>).reduce<number>((max, entry) => Math.max(max, jsonDepth(entry, depth + 1)), depth + 1);
}

// Shared package: browser consumers have no Buffer, so byte sizes come from
// TextEncoder (identical UTF-8 accounting).
function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function payloadIssue(value: unknown, ctx: z.RefinementCtx, path: (string | number)[]): void {
  if (value === undefined) return;
  let bytes: number;
  try { bytes = jsonByteLength(value); } catch { ctx.addIssue({ code: 'custom', message: 'payload must be JSON-serializable', path }); return; }
  if (bytes > MAX_STEP_PAYLOAD_BYTES) ctx.addIssue({ code: 'custom', message: `payload exceeds ${MAX_STEP_PAYLOAD_BYTES} bytes`, path });
  if (jsonDepth(value) > MAX_JSON_DEPTH) ctx.addIssue({ code: 'custom', message: `payload exceeds JSON depth ${MAX_JSON_DEPTH}`, path });
}

function relativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function allowedPinUrl(value: string, allowFileUrls: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === 'https:' || (allowFileUrls && url.protocol === 'file:');
  } catch { return false; }
}

const ChainKeySchema = z.string().regex(CHAIN_ID_KEY);
const DecimalSchema = z.string().regex(DECIMAL);
const AddressSchema = z.string().regex(ADDRESS);
const Hex32Schema = z.string().regex(HEX32);
const ValueRefSchema = z.object({ $ref: z.object({ kind: z.literal('step'), stepId: z.string().min(1) }).strict() }).strict() satisfies z.ZodType<WorkflowValueRef>;
const GasOverridesSchema = z.object({ gasLimit: DecimalSchema.optional(), maxFeePerGas: DecimalSchema.optional(), maxPriorityFeePerGas: DecimalSchema.optional() }).strict() satisfies z.ZodType<WorkflowGasOverrides>;
const LibraryBindingSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('address'), address: AddressSchema }).strict(), z.object({ kind: z.literal('step'), stepId: z.string().min(1) }).strict()]) satisfies z.ZodType<WorkflowLibraryBinding>;
const CallTargetSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('address'), address: AddressSchema }).strict(), z.object({ kind: z.literal('step'), stepId: z.string().min(1) }).strict()]) satisfies z.ZodType<WorkflowCallTarget>;
const AcknowledgementsSchema = z.record(ChainKeySchema, z.object({ predictedAddress: AddressSchema, initcodeHash: Hex32Schema }).strict());
const WorkflowDeployStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }).strict(),
  z.object({ kind: z.literal('create2'), salt: Hex32Schema, saltPerChain: z.record(ChainKeySchema, Hex32Schema).optional(), acknowledgeDeployed: AcknowledgementsSchema.optional() }).strict(),
  z.object({ kind: z.literal('plugin'), pluginId: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(), salt: Hex32Schema.optional(), saltPerChain: z.record(ChainKeySchema, Hex32Schema).optional(), prepared: z.record(ChainKeySchema, z.object({ initcodeHash: Hex32Schema, predictedAddress: AddressSchema }).strict()).optional(), acknowledgeDeployed: AcknowledgementsSchema.optional() }).strict(),
]) satisfies z.ZodType<WorkflowDeployStrategy>;

const WorkflowStepSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('deploy'), contractId: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), argsPerChain: z.record(ChainKeySchema, z.record(z.string(), z.unknown())).optional(), value: DecimalSchema.optional(), valuePerChain: z.record(ChainKeySchema, DecimalSchema).optional(), gasOverrides: GasOverridesSchema.optional(), gasOverridesPerChain: z.record(ChainKeySchema, GasOverridesSchema.partial()).optional(), strategy: WorkflowDeployStrategySchema.optional(), libraries: z.record(z.string(), LibraryBindingSchema).optional(), librariesPerChain: z.record(ChainKeySchema, z.record(z.string(), LibraryBindingSchema)).optional(), wraps: z.object({ stepId: z.string().min(1), contractTypePluginId: z.string().min(1) }).strict().optional(), acknowledgeUninitialized: z.literal(true).optional(), acknowledgeUnverifiedBytecode: z.literal(true).optional() }).strict(),
  z.object({ id: z.string().min(1), kind: z.literal('call'), target: CallTargetSchema, targetPerChain: z.record(ChainKeySchema, CallTargetSchema).optional(), signature: z.string().min(1).optional(), payable: z.boolean().optional(), args: z.record(z.string(), z.unknown()).optional(), argsPerChain: z.record(ChainKeySchema, z.record(z.string(), z.unknown())).optional(), value: DecimalSchema.optional(), valuePerChain: z.record(ChainKeySchema, DecimalSchema).optional(), gasOverrides: GasOverridesSchema.optional(), gasOverridesPerChain: z.record(ChainKeySchema, GasOverridesSchema.partial()).optional() }).strict(),
]).superRefine((step, ctx) => {
  if (step.kind === 'call' && (step.value !== undefined || step.valuePerChain !== undefined) && step.signature !== undefined && step.payable !== true) ctx.addIssue({ code: 'custom', message: 'call value requires payable: true when signature is present', path: ['payable'] });
  payloadIssue(step.args, ctx, ['args']);
  payloadIssue(step.argsPerChain, ctx, ['argsPerChain']);
  if (step.kind === 'deploy' && step.strategy?.kind === 'plugin') payloadIssue(step.strategy.params, ctx, ['strategy', 'params']);
  const checkRefs = (value: unknown, path: (string | number)[]): void => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && '$ref' in (value as Record<string, unknown>)) {
      const parsed = ValueRefSchema.safeParse(value);
      if (!parsed.success) ctx.addIssue({ code: 'custom', message: 'invalid strict $ref value', path });
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) checkRefs(entry, [...path, key]);
  };
  checkRefs(step.args, ['args']); checkRefs(step.argsPerChain, ['argsPerChain']);
}) as z.ZodType<WorkflowStep>;

export function makeWorkflowDocumentSchema(options: { allowFileUrls?: boolean } = {}): z.ZodType<WorkflowDocument> {
  const PinSchema = z.object({ url: z.string().min(1).refine((value) => allowedPinUrl(value, options.allowFileUrls === true), 'pin URL must be credential-free https:// (or file:// in dev mode)'), commit: z.string().regex(COMMIT), ref: z.string().min(1).optional(), refKind: z.enum(['tag', 'branch']).optional() }).strict().superRefine((pin, ctx) => { if (pin.ref !== undefined && pin.refKind === undefined) ctx.addIssue({ code: 'custom', message: 'refKind is required when ref is present', path: ['refKind'] }); });
  const RepoSourceSchema = z.object({ id: z.string().min(1), origin: z.literal('repo').optional(), repo: PinSchema, frameworkId: z.string().min(1), sourcePath: z.string().refine(relativePath, 'sourcePath must be a relative path without dot segments'), contractName: z.string().min(1), artifactPath: z.string().refine(relativePath, 'artifactPath must be a relative path without dot segments'), artifactHash: z.string().regex(SHA256_HEX).optional() }).strict() satisfies z.ZodType<RepoWorkflowSource>;
  const ContractTypeSourceSchema = z.object({ id: z.string().min(1), origin: z.literal('contract-type'), contractName: z.string().min(1), pluginId: z.string().min(1), artifactKey: z.string().min(1), versionLabel: z.string().min(1), contentHash: z.string().regex(SHA256_HEX) }).strict() satisfies z.ZodType<ContractTypeWorkflowSource>;
  const SourceSchema = z.union([RepoSourceSchema, ContractTypeSourceSchema]) satisfies z.ZodType<WorkflowSource>;
  const TrackSchema = z.discriminatedUnion('mode', [z.object({ mode: z.literal('release'), version: z.string().min(1) }).strict(), z.object({ mode: z.literal('branch'), branch: z.string().min(1) }).strict(), z.object({ mode: z.literal('commit') }).strict()]);
  const PluginSourceSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('local'), contextDir: z.string().min(1), dockerfile: z.string().min(1).optional() }).strict(), z.object({ kind: z.literal('git'), url: z.string().min(1), ref: z.string().min(1).optional(), track: TrackSchema.optional(), commit: z.string().min(1).optional() }).strict()]);
  const RequiredPluginSchema = z.object({ id: z.string().min(1), version: z.string().min(1), source: PluginSourceSchema.optional() }).strict();
  const OutputsSchema = z.object({ hooks: z.array(z.string().min(1)).max(16) }).strict();
  return z.object({ schemaVersion: z.literal(1), description: z.string().max(1024).optional(), sources: z.array(SourceSchema).max(64), steps: z.array(WorkflowStepSchema).max(256), // deprecated: ignored, retained so existing documents validate
    defaultChains: z.array(z.number().int().positive()).max(128).optional(), requiredPlugins: z.array(RequiredPluginSchema).max(32), outputs: OutputsSchema }).strict().superRefine((doc, ctx) => {
    const duplicate = (values: string[]) => values.find((value, index) => values.indexOf(value) !== index);
    const source = duplicate(doc.sources.map((entry) => entry.id)); if (source) ctx.addIssue({ code: 'custom', message: `duplicate source id: ${source}`, path: ['sources'] });
    const step = duplicate(doc.steps.map((entry) => entry.id)); if (step) ctx.addIssue({ code: 'custom', message: `duplicate step id: ${step}`, path: ['steps'] });
    const plugin = duplicate(doc.requiredPlugins.map((entry) => entry.id)); if (plugin) ctx.addIssue({ code: 'custom', message: `duplicate plugin id: ${plugin}`, path: ['requiredPlugins'] });
    const hook = duplicate(doc.outputs.hooks); if (hook) ctx.addIssue({ code: 'custom', message: `duplicate hook id: ${hook}`, path: ['outputs', 'hooks'] });
    if (doc.defaultChains && new Set(doc.defaultChains).size !== doc.defaultChains.length) ctx.addIssue({ code: 'custom', message: 'default chains must be unique', path: ['defaultChains'] });
    const contractIds = new Set(doc.sources.map((entry) => entry.id));
    const deployIds = new Set(doc.steps.filter((entry) => entry.kind === 'deploy').map((entry) => entry.id));
    const assertDeploy = (stepId: string, path: (string | number)[]) => { if (!deployIds.has(stepId)) ctx.addIssue({ code: 'custom', message: 'pointer, target, and library stepIds must name deploy steps', path }); };
    const visitRefs = (value: unknown, path: (string | number)[]) => { if (!value || typeof value !== 'object') return; if (!Array.isArray(value) && '$ref' in (value as Record<string, unknown>)) { const ref = value as WorkflowValueRef; if (ref.$ref?.kind === 'step') assertDeploy(ref.$ref.stepId, path); return; } Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => visitRefs(entry, [...path, key])); };
    doc.steps.forEach((entry, index) => { if (entry.kind === 'deploy') { if (!contractIds.has(entry.contractId)) ctx.addIssue({ code: 'custom', message: 'step contractId must reference a source', path: ['steps', index, 'contractId'] }); if (entry.wraps) assertDeploy(entry.wraps.stepId, ['steps', index, 'wraps', 'stepId']); visitRefs(entry.args, ['steps', index, 'args']); visitRefs(entry.argsPerChain, ['steps', index, 'argsPerChain']); Object.entries(entry.libraries ?? {}).forEach(([key, binding]) => { if (binding.kind === 'step') assertDeploy(binding.stepId, ['steps', index, 'libraries', key]); }); Object.entries(entry.librariesPerChain ?? {}).forEach(([chain, bindings]) => Object.entries(bindings).forEach(([key, binding]) => { if (binding.kind === 'step') assertDeploy(binding.stepId, ['steps', index, 'librariesPerChain', chain, key]); })); } else { if (entry.target.kind === 'step') assertDeploy(entry.target.stepId, ['steps', index, 'target']); Object.entries(entry.targetPerChain ?? {}).forEach(([chain, target]) => { if (target.kind === 'step') assertDeploy(target.stepId, ['steps', index, 'targetPerChain', chain]); }); visitRefs(entry.args, ['steps', index, 'args']); visitRefs(entry.argsPerChain, ['steps', index, 'argsPerChain']); } });
    if (jsonByteLength(doc) > MAX_DOCUMENT_BYTES) ctx.addIssue({ code: 'custom', message: `workflow document exceeds ${MAX_DOCUMENT_BYTES} bytes` });
  }) as z.ZodType<WorkflowDocument>;
}

export const WorkflowDocumentSchema = makeWorkflowDocumentSchema();

export function validateWorkflowClosure(document: WorkflowDocument): string[] {
  const plugins = new Set(document.requiredPlugins.map((plugin) => plugin.id));
  const required = new Set<string>([...document.sources.map((source) => source.origin === 'contract-type' ? source.pluginId : source.frameworkId), ...document.outputs.hooks]);
  const missing = new Set<string>();
  // versionLabel identifies the frozen artifact bundle, not the installed
  // plugin version. The requiredPlugins entry is pinned from the registry by
  // promotion and closure only establishes that the plugin is present.
  for (const step of document.steps) if (step.kind === 'deploy' && step.strategy?.kind === 'plugin') required.add(step.strategy.pluginId);
  for (const id of required) if (!plugins.has(id)) missing.add(id);
  return [...missing].sort();
}

export const WorkflowSummarySchema = z.object({ name: z.string().regex(WorkflowNamePattern), valid: z.boolean(), error: z.string().optional(), description: z.string().max(1024).optional(), sourceCount: z.number().int().nonnegative().optional(), stepCount: z.number().int().nonnegative().optional(), hooks: z.array(z.string().min(1)).max(16).optional() }).strict() satisfies z.ZodType<WorkflowSummary>;
const WorkflowListResponseSchema = createApiResponseSchema<{ workflows: WorkflowSummary[]; truncated: boolean }>('WorkflowListResponseSchema')(z.object({ workflows: z.array(WorkflowSummarySchema), truncated: z.boolean() }).strict());
// Response schemas describe values already accepted by the environment-aware
// handler; they must not reject a development file:// document at serialize.
const WorkflowGetResponseSchema = createApiResponseSchema<{ document: WorkflowDocument; raw: string; docHash: string }>('WorkflowGetResponseSchema')(z.object({ document: makeWorkflowDocumentSchema({ allowFileUrls: true }), raw: z.string(), docHash: z.string().regex(SHA256_HEX) }).strict());
const WorkflowPutResponseSchema = createApiResponseSchema<{ docHash: string }>('WorkflowPutResponseSchema')(z.object({ docHash: z.string().regex(SHA256_HEX) }).strict());
const WorkflowPathQuerySchema = z.object({ pathOrUrl: z.string().min(1) }).strict();
const WorkflowNameParamsSchema = z.object({ name: z.string().regex(WorkflowNamePattern) }).strict();
// Handler selects the schema factory at runtime so development mode can opt
// into file:// pins without weakening committed production documents.
const WorkflowPutBodySchema = z.object({ document: z.unknown(), baseDocHash: z.string().regex(SHA256_HEX).optional() }).strict();
const WorkflowResolveBodySchema = z.object({ repoPathOrUrl: z.string().min(1), name: z.string().regex(WorkflowNamePattern) }).strict();
const WorkflowApproveOriginsBodySchema = z.object({ origins: z.array(z.string().min(1)).min(1).max(64) }).strict();
const WorkflowApproveOriginsResponseSchema = createApiResponseSchema<{ origins: string[] }>('WorkflowApproveOriginsResponseSchema')(z.object({ origins: z.array(z.string()) }).strict());
const PromotionTargetSchema = z.object({ repoPathOrUrl: z.string().min(1), name: z.string().regex(WorkflowNamePattern) }).strict();
const RunIdSchema = z.string().regex(RUN_ID_PATTERN);
const PromotionSelectionShape = { target: PromotionTargetSchema, plan: DeploymentPlanSchema.optional(), runId: RunIdSchema.optional() };
const exactlyOnePromotionInput = (value: { plan?: unknown; runId?: string }, ctx: z.RefinementCtx) => {
  if ((value.plan === undefined) === (value.runId === undefined)) ctx.addIssue({ code: 'custom', message: 'exactly one of plan or runId is required' });
};
const PromotionPreviewRequestSchema = z.object({ mode: z.literal('preview'), ...PromotionSelectionShape }).strict().superRefine(exactlyOnePromotionInput);
const PromotionApplyRequestSchema = z.object({
  mode: z.literal('apply'), previewId: z.string().min(1), ...PromotionSelectionShape,
  tagChoiceBySourceId: z.record(z.string().min(1), z.string().min(1)).optional(), overwrite: z.boolean().optional(),
  hooks: z.array(z.string().min(1)).max(16), adoptRunIds: z.array(RunIdSchema).max(64).optional(),
}).strict().superRefine(exactlyOnePromotionInput).superRefine((request, ctx) => {
  if (new Set(request.hooks).size !== request.hooks.length) ctx.addIssue({ code: 'custom', message: 'hooks must be unique', path: ['hooks'] });
});
export const WorkflowPromoteRequestSchema = z.discriminatedUnion('mode', [PromotionPreviewRequestSchema, PromotionApplyRequestSchema]) as z.ZodType<WorkflowPromoteRequest>;
const PromotionSourcePreviewSchema = z.object({ sourceId: z.string().min(1), origin: z.string(), commit: z.string(), tagChoices: z.array(z.string()), dirty: z.boolean(), error: z.string().optional() }).strict();
export const WorkflowPromoteResponseSchema = createApiResponseSchema<WorkflowPromoteData>('WorkflowPromoteResponseSchema')(
  z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('preview'), previewId: z.string().min(1), sources: z.array(PromotionSourcePreviewSchema), nameCollision: z.boolean() }).strict(),
    z.object({ mode: z.literal('apply'), workflow: WorkflowSummarySchema, docHash: z.string().regex(SHA256_HEX) }).strict(),
  ]),
);
export const WorkflowCheckUpdatesRequestSchema = z.object({ repoPathOrUrl: z.string().min(1), name: z.string().regex(WorkflowNamePattern) }).strict();
const WorkflowSourceUpdateSchema = z.object({
  sourceId: z.string().min(1), status: z.enum(['up-to-date', 'upgrade-available', 'tag-retargeted', 'tag-deleted', 'branch-moved', 'approval-required', 'contract-type-drift', 'error']),
  currentCommit: z.string().regex(COMMIT).optional(), latestCommit: z.string().regex(COMMIT).optional(), currentContentHash: z.string().regex(SHA256_HEX).optional(), latestContentHash: z.string().regex(SHA256_HEX).optional(),
  origin: z.string().min(1).optional(), upgrades: z.array(z.object({ ref: z.string().min(1), commit: z.string().regex(COMMIT), version: z.string().min(1) }).strict()).optional(), error: z.string().optional(),
}).strict() satisfies z.ZodType<WorkflowSourceUpdate>;
const WorkflowPluginUpdateSchema = z.object({
  id: z.string().min(1), requiredVersion: z.string().min(1), status: z.enum(['installed', 'version-mismatch', 'missing']),
  installedVersion: z.string().optional(), updateAvailable: z.boolean(), update: PluginVersionInfoSchema.optional(),
}).strict() satisfies z.ZodType<WorkflowPluginUpdate>;
export const WorkflowCheckUpdatesResponseSchema = createApiResponseSchema<WorkflowCheckUpdatesData>('WorkflowCheckUpdatesResponseSchema')(
  z.object({ sources: z.array(WorkflowSourceUpdateSchema), plugins: z.array(WorkflowPluginUpdateSchema) }).strict(),
);

export const workflowRoutes = {
  listWorkflows: { method: 'GET' as const, path: `${V1_BASE_PATH}/repos/workflows`, schema: { tags: ['repos'], querystring: WorkflowPathQuerySchema, response: { 200: WorkflowListResponseSchema } } },
  getWorkflow: { method: 'GET' as const, path: `${V1_BASE_PATH}/repos/workflows/:name`, schema: { tags: ['repos'], params: WorkflowNameParamsSchema, querystring: WorkflowPathQuerySchema, response: { 200: WorkflowGetResponseSchema } } },
  putWorkflow: { method: 'PUT' as const, path: `${V1_BASE_PATH}/repos/workflows/:name`, schema: { tags: ['repos'], params: WorkflowNameParamsSchema, querystring: WorkflowPathQuerySchema, body: WorkflowPutBodySchema, response: { 200: WorkflowPutResponseSchema } } },
  resolveWorkflow: { method: 'POST' as const, path: `${V1_BASE_PATH}/workflows/resolve`, schema: { tags: ['workflows'], body: WorkflowResolveBodySchema, response: { 200: JobStartedResponseSchema } } },
  approveWorkflowOrigins: { method: 'POST' as const, path: `${V1_BASE_PATH}/workflows/approve-origins`, schema: { tags: ['workflows'], body: WorkflowApproveOriginsBodySchema, response: { 200: WorkflowApproveOriginsResponseSchema } } },
  promoteWorkflow: { method: 'POST' as const, path: `${V1_BASE_PATH}/workflows/promote`, schema: { tags: ['workflows'], body: WorkflowPromoteRequestSchema, response: { 200: WorkflowPromoteResponseSchema } } },
  checkWorkflowUpdates: { method: 'POST' as const, path: `${V1_BASE_PATH}/workflows/check-updates`, schema: { tags: ['workflows'], body: WorkflowCheckUpdatesRequestSchema, response: { 200: WorkflowCheckUpdatesResponseSchema } } },
} as const;
