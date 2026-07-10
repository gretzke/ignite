import type {
  ArgValues,
  ContractSource,
  DeployStep,
  GasOverrides,
  RunRecord,
  RunSummary,
  SignerCascade,
} from '@ignite/api';

export type DraftContract = ContractSource;

// The wizard keeps the deployment shape close to the shared API contract.
// Later wizard steps can enrich these sparse fields without translating the
// draft on every edit.
export type DraftStep = DeployStep;

export interface DraftRpcSelection {
  endpointId: string;
  label: string;
}

export interface DeployDraftState {
  contracts: DraftContract[];
  chains: number[];
  rpcSelection: Record<string, DraftRpcSelection>;
  signers: SignerCascade;
  steps: DraftStep[];
  name?: string;
  idempotencyKey?: string;
}

export type GasOverrideKey = keyof GasOverrides;

export interface SetArgPayload {
  stepId: string;
  key: string;
  value: unknown;
}

export interface SetChainArgOverridePayload extends SetArgPayload {
  chainId: number;
}

export interface RunCursor {
  epoch: string;
  lastSeq: number;
}

export interface DeploymentsState {
  runsById: Record<string, RunRecord>;
  summaries: RunSummary[];
  activeSubscriptions: Record<string, true>;
  backgroundSubscriptions: Record<string, true>;
  epochByRun: Record<string, RunCursor>;
}

export type { ArgValues, GasOverrides };
