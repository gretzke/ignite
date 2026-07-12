import { z } from 'zod';
import {
  ContractSourceSchema,
  DeployStepSchema,
  SignerCascadeSchema,
} from '@ignite/api';
import type { DeployDraftState } from './types';

export const DEPLOY_DRAFT_STORAGE_KEY = 'ignite.deployDraft.v1';

// TypeScript types cannot validate parsed JSON: restored drafts are checked
// against this schema plus the cross-field invariants below, and anything
// suspect falls back to an empty draft. Bump the storage key version on
// breaking shape changes instead of writing migrations.
const PersistedDraftSchema = z.object({
  contracts: z.array(ContractSourceSchema),
  chains: z.array(z.number()),
  rpcSelection: z.record(
    z.string(),
    z.object({ endpointId: z.string(), label: z.string() })
  ),
  explorerSelection: z.record(z.string(), z.array(z.string())),
  signers: SignerCascadeSchema,
  steps: z.array(DeployStepSchema),
  unseenIds: z.array(z.string()),
  name: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

function invariantsHold(draft: DeployDraftState): boolean {
  // No contracts means no session: restoring chains/signers/name without
  // contracts would let dormant configuration leak into the next deployment.
  if (draft.contracts.length === 0) return false;
  const contractIds = new Set(draft.contracts.map((contract) => contract.id));
  if (contractIds.size !== draft.contracts.length) return false;
  if (draft.steps.length !== draft.contracts.length) return false;
  const stepContractIds = new Set(draft.steps.map((step) => step.contractId));
  if (stepContractIds.size !== draft.steps.length) return false;
  for (const step of draft.steps) {
    if (step.kind !== 'deploy') return false;
    if (!contractIds.has(step.contractId)) return false;
  }
  return draft.unseenIds.every((id) => contractIds.has(id));
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

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
    const raw = storage?.getItem(DEPLOY_DRAFT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = PersistedDraftSchema.parse(
      JSON.parse(raw)
    ) as DeployDraftState;
    return invariantsHold(parsed) ? parsed : undefined;
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
