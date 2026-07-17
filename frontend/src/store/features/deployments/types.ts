import type {
  AckMap,
  ArgValues,
  CallTarget,
  ContractSource,
  DeployStep,
  GasOverrides,
  Hex,
  Hex32,
  LibraryBinding,
  RunRecord,
  RunSummary,
  SignerCascade,
  ExternalResolution,
  WorkflowDocument,
  WorkflowOutputs,
  WorkflowRequiredPlugin,
  WorkflowSource,
  ArtifactDriftAcknowledgements,
} from '@ignite/api';

export type DraftContract = ContractSource;

// The wizard keeps the deployment shape close to the shared API contract.
// Later wizard steps can enrich these sparse fields without translating the
// draft on every edit.
// Deploy fields stay on the draft step because the argument and advanced
// editors update them independently. Strategy-specific state lives alongside
// the step in deployExtras so switching a strategy can discard it atomically.
export type DraftDeployStep = Omit<
  DeployStep,
  'strategy' | 'libraries' | 'librariesPerChain'
> & {
  // Wizard-only distinction between an untouched empty initializer and the
  // user's explicit "No initialization" choice. It never reaches the plan.
  initializerSelection?: string;
};

export interface DraftCallStep {
  id: string;
  kind: 'call';
  contractId?: never;
  // A blank target is valid while the wizard is being composed. The API plan
  // assembler omits no such value: Review remains the authoritative guard.
  target: CallTarget | null;
  targetPerChain?: Record<string, CallTarget>;
  signature?: string;
  payable?: boolean;
  args?: ArgValues;
  argsPerChain?: Record<string, Partial<ArgValues>>;
  value?: string;
  valuePerChain?: Record<string, string>;
  gasOverrides?: GasOverrides;
  gasOverridesPerChain?: Record<string, Partial<GasOverrides>>;
  signerOverride?: SignerCascade;
}

export type DraftStep = DraftDeployStep | DraftCallStep;

export interface DraftDeployExtras {
  strategy:
    | { kind: 'create' }
    | { kind: 'create2'; salt?: Hex32; saltPerChain?: Record<string, Hex32> }
    | { kind: 'plugin'; pluginId: string; params?: Record<string, unknown> };
  libraries?: Record<string, LibraryBinding>;
  librariesPerChain?: Record<string, Record<string, LibraryBinding>>;
  prepared?: Record<
    string,
    {
      salt: Hex32;
      predictedAddress: Hex;
      initcodeHash: Hex32;
      notes: string[];
    }
  >;
  acknowledged?: AckMap;
  needsPrepare?: boolean;
}

export interface DraftRpcSelection {
  endpointId: string;
  label: string;
}

export interface DeployDraftState {
  contracts: DraftContract[];
  chains: number[];
  rpcSelection: Record<string, DraftRpcSelection>;
  explorerSelection: Record<string, string[]>;
  signers: SignerCascade;
  steps: DraftStep[];
  deployExtras: Record<string, DraftDeployExtras>;
  // Ids of contracts added since the wizard was last visited; drives the
  // sidebar badge. A plain count would drift when an unseen contract is
  // removed again before the wizard is opened.
  unseenIds: string[];
  name?: string;
  idempotencyKey?: string;
  workflowRef?: { repoPathOrUrl: string; name: string; baseDocHash: string };
  workflowDocument?: WorkflowDocument;
  // Editable source pins are detached from workflowDocument, which remains
  // the immutable loaded/saved baseline for dirty checks.
  workflowSources?: WorkflowSource[];
  workflowIncludedStepIds?: Record<string, boolean>;
  externalResolutions?: ExternalResolution[];
  workflowOutputs?: WorkflowOutputs;
  workflowRequiredPlugins?: WorkflowRequiredPlugin[];
  workflowRunHooks?: string[];
  acknowledgeArtifactDrift?: ArtifactDriftAcknowledgements;
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
