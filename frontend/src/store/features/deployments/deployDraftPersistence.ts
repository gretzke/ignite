import { z } from 'zod';
import {
  CallTargetSchema,
  ContractSourceSchema,
  Hex32Schema,
  LibraryBindingSchema,
  SignerCascadeSchema,
  ExternalResolutionSchema,
  makeWorkflowDocumentSchema,
} from '@ignite/api';
import type { DeployDraftState } from './types';

export const DEPLOY_DRAFT_STORAGE_KEY = 'ignite.deployDraft.v2';
const LEGACY_DEPLOY_DRAFT_STORAGE_KEY = 'ignite.deployDraft.v1';

// TypeScript types cannot validate parsed JSON: restored drafts are checked
// against this schema plus the cross-field invariants below, and anything
// suspect falls back to an empty draft. Bump the storage key version on
// breaking shape changes instead of writing migrations.
const GasOverridesDraftSchema = z.object({
  gasLimit: z.string().optional(),
  maxFeePerGas: z.string().optional(),
  maxPriorityFeePerGas: z.string().optional(),
});

const DraftDeployStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('deploy'),
  contractId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  argsPerChain: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  value: z.string().optional(),
  valuePerChain: z.record(z.string(), z.string()).optional(),
  gasOverrides: GasOverridesDraftSchema.optional(),
  gasOverridesPerChain: z
    .record(z.string(), GasOverridesDraftSchema.partial())
    .optional(),
  signerOverride: SignerCascadeSchema.optional(),
});

const DraftCallStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('call'),
  target: CallTargetSchema.nullable(),
  targetPerChain: z.record(z.string(), CallTargetSchema).optional(),
  signature: z.string().optional(),
  payable: z.boolean().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  argsPerChain: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  value: z.string().optional(),
  valuePerChain: z.record(z.string(), z.string()).optional(),
  gasOverrides: GasOverridesDraftSchema.optional(),
  gasOverridesPerChain: z
    .record(z.string(), GasOverridesDraftSchema.partial())
    .optional(),
  signerOverride: SignerCascadeSchema.optional(),
});

const DraftDeployExtrasSchema = z.object({
  strategy: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create') }),
    z.object({
      kind: z.literal('create2'),
      salt: Hex32Schema.optional(),
      saltPerChain: z.record(z.string(), Hex32Schema).optional(),
    }),
    z.object({
      kind: z.literal('plugin'),
      pluginId: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ]),
  libraries: z.record(z.string(), LibraryBindingSchema).optional(),
  librariesPerChain: z
    .record(z.string(), z.record(z.string(), LibraryBindingSchema))
    .optional(),
  prepared: z
    .record(
      z.string(),
      z.object({
        salt: Hex32Schema,
        predictedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        initcodeHash: Hex32Schema,
        notes: z.array(z.string()),
      })
    )
    .optional(),
  acknowledged: z
    .record(
      z.string(),
      z.object({
        predictedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        initcodeHash: Hex32Schema,
      })
    )
    .optional(),
  needsPrepare: z.boolean().optional(),
});

const PersistedDraftSchema = z.object({
  contracts: z.array(ContractSourceSchema),
  chains: z.array(z.number()),
  rpcSelection: z.record(
    z.string(),
    z.object({ endpointId: z.string(), label: z.string() })
  ),
  explorerSelection: z.record(z.string(), z.array(z.string())),
  signers: SignerCascadeSchema,
  steps: z.array(
    z.discriminatedUnion('kind', [DraftDeployStepSchema, DraftCallStepSchema])
  ),
  deployExtras: z.record(z.string(), DraftDeployExtrasSchema),
  unseenIds: z.array(z.string()),
  name: z.string().optional(),
  idempotencyKey: z.string().optional(),
  workflowRef: z
    .object({
      repoPathOrUrl: z.string(),
      name: z.string(),
      baseDocHash: z.string(),
    })
    .optional(),
  workflowDocument: makeWorkflowDocumentSchema({
    allowFileUrls: true,
  }).optional(),
  workflowIncludedStepIds: z.record(z.string(), z.boolean()).optional(),
  externalResolutions: z.array(ExternalResolutionSchema).optional(),
  workflowOutputs: z.object({ hooks: z.array(z.string()) }).optional(),
  workflowRequiredPlugins: z
    .array(
      z.object({
        id: z.string(),
        version: z.string(),
        source: z.unknown().optional(),
      })
    )
    .optional(),
  workflowRunHooks: z.array(z.string()).optional(),
  acknowledgeArtifactDrift: z
    .record(z.string(), z.object({ expected: z.string(), actual: z.string() }))
    .optional(),
});

function invariantsHold(draft: DeployDraftState): boolean {
  // No contracts means no session: restoring chains/signers/name without
  // contracts would let dormant configuration leak into the next deployment.
  if (draft.contracts.length === 0) return false;
  const contractIds = new Set(draft.contracts.map((contract) => contract.id));
  if (contractIds.size !== draft.contracts.length) return false;
  const deploySteps = draft.steps.filter((step) => step.kind === 'deploy');
  if (!draft.workflowRef && deploySteps.length !== draft.contracts.length)
    return false;
  const stepContractIds = new Set(deploySteps.map((step) => step.contractId));
  if (!draft.workflowRef && stepContractIds.size !== deploySteps.length)
    return false;
  const stepIds = new Set(draft.steps.map((step) => step.id));
  if (stepIds.size !== draft.steps.length) return false;
  for (const step of deploySteps)
    if (!contractIds.has(step.contractId)) return false;
  if (!draft.unseenIds.every((id) => contractIds.has(id))) return false;
  return Object.keys(draft.deployExtras).every((id) =>
    deploySteps.some((step) => step.id === id)
  );
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'> &
  Partial<Pick<Storage, 'removeItem'>>;

function defaultStorage(): DraftStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadDraft(
  storage: DraftStorage | undefined = defaultStorage()
): DeployDraftState | undefined {
  try {
    // v1 cannot express calls or strategy state. Treat it as a deliberately
    // stale session, and remove it so a later reload cannot resurrect it.
    if (storage?.getItem(LEGACY_DEPLOY_DRAFT_STORAGE_KEY))
      storage.removeItem?.(LEGACY_DEPLOY_DRAFT_STORAGE_KEY);
    const raw = storage?.getItem(DEPLOY_DRAFT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = PersistedDraftSchema.parse(
      JSON.parse(raw)
    ) as DeployDraftState;
    if (!invariantsHold(parsed)) return undefined;
    // Prepared plugin initcode is intentionally not trusted across reloads.
    for (const extras of Object.values(parsed.deployExtras)) {
      if (extras.strategy.kind === 'plugin' && extras.prepared)
        extras.needsPrepare = true;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveDraft(
  draft: DeployDraftState,
  storage: DraftStorage | undefined = defaultStorage()
): void {
  try {
    storage?.setItem(DEPLOY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage full or unavailable: the draft simply does not persist.
  }
}
