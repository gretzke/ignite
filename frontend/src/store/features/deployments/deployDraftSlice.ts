import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  Hex,
  Hex32,
  LibraryBinding,
  SignerCascade,
  SignerRef,
  ExternalResolution,
  WorkflowDocument,
} from '@ignite/api';
import type {
  DraftCallStep,
  DraftDeployExtras,
  DeployDraftState,
  DraftContract,
  DraftStep,
  GasOverrideKey,
  SetArgPayload,
  SetChainArgOverridePayload,
} from './types';
import { cloneJson } from '../../../utils/cloneJson';

const initialState: DeployDraftState = {
  contracts: [],
  chains: [],
  rpcSelection: {},
  explorerSelection: {},
  signers: {},
  steps: [],
  deployExtras: {},
  unseenIds: [],
};

function stepFor(contract: DraftContract) {
  return {
    id: `deploy-${contract.id}`,
    kind: 'deploy' as const,
    contractId: contract.id,
  };
}

function removeEmptyRecord(
  record: Record<string, unknown> | undefined,
  key: string
): void {
  if (record?.[key] && Object.keys(record[key] as object).length === 0) {
    delete record[key];
  }
}

function deployStep(state: DeployDraftState, stepId: string) {
  const step = state.steps.find(
    (item): item is Extract<DraftStep, { kind: 'deploy' }> =>
      item.id === stepId && item.kind === 'deploy'
  );
  return step;
}

function extrasFor(
  state: DeployDraftState,
  stepId: string
): DraftDeployExtras | undefined {
  if (!deployStep(state, stepId)) return undefined;
  return (state.deployExtras[stepId] ??= { strategy: { kind: 'create' } });
}

function isValueRef(
  value: unknown
): value is { $ref: { kind: 'step'; stepId: string } } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    '$ref' in value &&
    (value as { $ref?: { kind?: string; stepId?: unknown } }).$ref?.kind ===
      'step' &&
    typeof (value as { $ref: { stepId?: unknown } }).$ref.stepId === 'string'
  );
}

function containsReference(value: unknown, stepId: string): boolean {
  if (isValueRef(value)) return value.$ref.stepId === stepId;
  if (Array.isArray(value))
    return value.some((item) => containsReference(item, stepId));
  if (value && typeof value === 'object')
    return Object.values(value).some((item) => containsReference(item, stepId));
  return false;
}

function stepDependsOn(
  step: DraftStep,
  extras: DraftDeployExtras | undefined,
  stepId: string
): boolean {
  if (
    containsReference(step.args, stepId) ||
    containsReference(step.argsPerChain, stepId)
  )
    return true;
  if (step.kind === 'call') {
    return (
      (step.target?.kind === 'step' && step.target.stepId === stepId) ||
      Object.values(step.targetPerChain ?? {}).some(
        (target) => target.kind === 'step' && target.stepId === stepId
      )
    );
  }
  return (
    Object.values(extras?.libraries ?? {}).some(
      (binding) => binding.kind === 'step' && binding.stepId === stepId
    ) ||
    Object.values(extras?.librariesPerChain ?? {}).some((bindings) =>
      Object.values(bindings).some(
        (binding) => binding.kind === 'step' && binding.stepId === stepId
      )
    )
  );
}

// A prediction is a property of the complete dependency closure, not merely
// the edited card. Keep the rule in this reducer so every editor path gets the
// same invalidation and acknowledgement behaviour.
function invalidatePredictions(state: DeployDraftState, stepId: string): void {
  const invalidated = new Set<string>();
  const pending = [stepId];
  while (pending.length) {
    const current = pending.pop()!;
    if (invalidated.has(current)) continue;
    invalidated.add(current);
    for (const step of state.steps) {
      if (
        step.kind === 'deploy' &&
        stepDependsOn(step, state.deployExtras[step.id], current)
      ) {
        pending.push(step.id);
      }
    }
  }
  for (const id of invalidated) {
    const extras = state.deployExtras[id];
    if (!extras) continue;
    delete extras.prepared;
    delete extras.acknowledged;
    if (extras.strategy.kind === 'plugin') extras.needsPrepare = true;
    else delete extras.needsPrepare;
  }
}

function pruneChainPredictions(state: DeployDraftState, chainId: number): void {
  const key = String(chainId);
  for (const extras of Object.values(state.deployExtras)) {
    delete extras.prepared?.[key];
    delete extras.acknowledged?.[key];
    if (extras.prepared && Object.keys(extras.prepared).length === 0) {
      delete extras.prepared;
      if (extras.strategy.kind === 'plugin') extras.needsPrepare = true;
    }
    if (extras.acknowledged && Object.keys(extras.acknowledged).length === 0)
      delete extras.acknowledged;
  }
}

function clearDanglingValueRefs(
  value: unknown,
  removedStepId: string
): unknown {
  if (isValueRef(value))
    return value.$ref.stepId === removedStepId ? undefined : value;
  if (Array.isArray(value))
    return value.map((item) => clearDanglingValueRefs(item, removedStepId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(
        ([key, item]) => {
          const next = clearDanglingValueRefs(item, removedStepId);
          return next === undefined ? [] : [[key, next]];
        }
      )
    );
  }
  return value;
}

function clearDanglingReferences(
  state: DeployDraftState,
  removedStepId: string
): void {
  for (const step of state.steps) {
    step.args = clearDanglingValueRefs(
      step.args,
      removedStepId
    ) as typeof step.args;
    step.argsPerChain = clearDanglingValueRefs(
      step.argsPerChain,
      removedStepId
    ) as typeof step.argsPerChain;
    if (step.kind === 'call') {
      if (step.target?.kind === 'step' && step.target.stepId === removedStepId)
        step.target = null;
      for (const [chainId, target] of Object.entries(
        step.targetPerChain ?? {}
      )) {
        if (target.kind === 'step' && target.stepId === removedStepId)
          delete step.targetPerChain?.[chainId];
      }
      if (Object.keys(step.targetPerChain ?? {}).length === 0)
        delete step.targetPerChain;
    }
  }
  for (const extras of Object.values(state.deployExtras)) {
    for (const [name, binding] of Object.entries(extras.libraries ?? {})) {
      if (binding.kind === 'step' && binding.stepId === removedStepId)
        delete extras.libraries?.[name];
    }
    for (const bindings of Object.values(extras.librariesPerChain ?? {})) {
      for (const [name, binding] of Object.entries(bindings)) {
        if (binding.kind === 'step' && binding.stepId === removedStepId)
          delete bindings[name];
      }
    }
  }
}

const deployDraftSlice = createSlice({
  name: 'deployDraft',
  initialState,
  reducers: {
    hydrateWorkflowDraft(
      _state,
      action: PayloadAction<{
        repoPathOrUrl: string;
        name: string;
        docHash: string;
        document: WorkflowDocument;
      }>
    ) {
      const { repoPathOrUrl, name, docHash, document } = action.payload;
      const deployExtras: DeployDraftState['deployExtras'] = {};
      const steps: DraftStep[] = document.steps.map((step) => {
        if (step.kind === 'call')
          return {
            ...step,
            target: { ...step.target },
            targetPerChain: step.targetPerChain
              ? { ...step.targetPerChain }
              : undefined,
          } as unknown as DraftStep;
        const { strategy, libraries, librariesPerChain, ...draftStep } = step;
        deployExtras[step.id] = {
          strategy: strategy
            ? ({ ...strategy } as DraftDeployExtras['strategy'])
            : { kind: 'create' },
          ...(libraries ? { libraries: { ...libraries } } : {}),
          ...(librariesPerChain
            ? { librariesPerChain: cloneJson(librariesPerChain) }
            : {}),
          ...(strategy &&
          'acknowledgeDeployed' in strategy &&
          strategy.acknowledgeDeployed
            ? { acknowledged: { ...strategy.acknowledgeDeployed } }
            : {}),
          ...(strategy?.kind === 'plugin' && strategy.prepared
            ? {
                prepared: Object.fromEntries(
                  Object.entries(strategy.prepared).map(
                    ([chainId, prepared]) => [
                      chainId,
                      {
                        ...prepared,
                        salt:
                          strategy.saltPerChain?.[chainId] ??
                          strategy.salt ??
                          (`0x${'0'.repeat(64)}` as Hex32),
                        notes: [],
                      },
                    ]
                  )
                ),
              }
            : {}),
        } as unknown as DraftDeployExtras;
        return draftStep as DraftStep;
      });
      return {
        ...initialState,
        contracts: document.sources.map((source) => ({
          id: source.id,
          repoPathOrUrl: source.repo.url,
          frameworkId: source.frameworkId,
          artifactPath: source.artifactPath,
          contractName: source.contractName,
          sourcePath: source.sourcePath,
          pin: { ...source.repo },
        })),
        chains: [...(document.defaultChains ?? [])],
        steps,
        deployExtras,
        workflowRef: { repoPathOrUrl, name, baseDocHash: docHash },
        workflowDocument: cloneJson(document),
        workflowIncludedStepIds: Object.fromEntries(
          document.steps.map((step) => [step.id, true])
        ),
        externalResolutions: [],
        workflowOutputs: cloneJson(document.outputs),
        workflowRequiredPlugins: cloneJson(document.requiredPlugins),
      };
    },
    toggleWorkflowStep(state, action: PayloadAction<string>) {
      if (
        !state.workflowIncludedStepIds ||
        !(action.payload in state.workflowIncludedStepIds)
      )
        return;
      state.workflowIncludedStepIds[action.payload] =
        !state.workflowIncludedStepIds[action.payload];
      state.externalResolutions = state.externalResolutions?.filter(
        (resolution) => resolution.stepId !== action.payload
      );
    },
    confirmExternalResolution(
      state,
      action: PayloadAction<ExternalResolution>
    ) {
      state.externalResolutions ??= [];
      const index = state.externalResolutions.findIndex(
        (item) =>
          item.stepId === action.payload.stepId &&
          item.path === action.payload.path &&
          item.chainId === action.payload.chainId
      );
      if (index === -1) state.externalResolutions.push(action.payload);
      else state.externalResolutions[index] = action.payload;
    },
    workflowDraftSaved(
      state,
      action: PayloadAction<{ document: WorkflowDocument; docHash: string }>
    ) {
      if (!state.workflowRef) return;
      state.workflowRef.baseDocHash = action.payload.docHash;
      state.workflowDocument = cloneJson(action.payload.document);
    },
    acceptWorkflowPinUpdate(
      state,
      action: PayloadAction<{
        sourceId: string;
        commit: string;
        ref?: string;
        refKind?: 'tag' | 'branch';
      }>
    ) {
      const source = state.workflowDocument?.sources.find(
        (item) => item.id === action.payload.sourceId
      );
      const contract = state.contracts.find(
        (item) => item.id === action.payload.sourceId
      );
      if (!source || !contract) return;
      source.repo = {
        url: source.repo.url,
        commit: action.payload.commit,
        ...(action.payload.ref
          ? { ref: action.payload.ref, refKind: action.payload.refKind }
          : {}),
      };
      contract.pin = { ...source.repo };
    },
    setWorkflowRunHooks(state, action: PayloadAction<string[]>) {
      state.workflowRunHooks = [...new Set(action.payload)];
    },
    acknowledgeArtifactDrift(
      state,
      action: PayloadAction<{
        sourceId: string;
        expected: string;
        actual: string;
      }>
    ) {
      state.acknowledgeArtifactDrift ??= {};
      state.acknowledgeArtifactDrift[action.payload.sourceId] = {
        expected: action.payload.expected,
        actual: action.payload.actual,
      };
    },
    seedDraft(_state, action: PayloadAction<DraftContract[]>) {
      return {
        ...initialState,
        contracts: [...action.payload],
        steps: action.payload.map(stepFor),
      };
    },
    addContracts(state, action: PayloadAction<DraftContract[]>) {
      // The first add into an empty draft navigates the user straight into
      // the wizard, so those contracts are seen by definition. Only additions
      // to an already-active draft feed the sidebar badge.
      const wasEmpty = state.contracts.length === 0;
      const existing = new Set(state.contracts.map((contract) => contract.id));
      for (const contract of action.payload) {
        if (existing.has(contract.id)) continue;
        existing.add(contract.id);
        state.contracts.push(contract);
        state.steps.push(stepFor(contract));
        if (!wasEmpty) state.unseenIds.push(contract.id);
      }
    },
    removeContract(state, action: PayloadAction<string>) {
      const id = action.payload;
      if (!state.contracts.some((contract) => contract.id === id)) return;
      if (state.contracts.length === 1) {
        // Removing the last contract ends the session. Chains, signers, name
        // and idempotency key must not silently survive into the next
        // deployment's "first" add.
        return initialState;
      }
      state.contracts = state.contracts.filter(
        (contract) => contract.id !== id
      );
      const removed = state.steps.find(
        (step) => step.kind === 'deploy' && step.contractId === id
      );
      if (removed) {
        invalidatePredictions(state, removed.id);
        state.steps = state.steps.filter((step) => step.id !== removed.id);
        delete state.deployExtras[removed.id];
        clearDanglingReferences(state, removed.id);
      }
      state.unseenIds = state.unseenIds.filter((unseen) => unseen !== id);
    },
    markDraftSeen(state) {
      state.unseenIds = [];
    },
    draftLaunched(state, action: PayloadAction<string>) {
      // The launch response can arrive after the user discarded this draft
      // and began composing a new one; only the draft that was actually
      // launched may be cleared.
      if (state.idempotencyKey !== action.payload) return state;
      return initialState;
    },
    moveStep(
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>
    ) {
      const { fromIndex, toIndex } = action.payload;
      if (
        fromIndex < 0 ||
        fromIndex >= state.steps.length ||
        toIndex < 0 ||
        toIndex >= state.steps.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const [step] = state.steps.splice(fromIndex, 1);
      state.steps.splice(toIndex, 0, step);
      // Step order is part of preparation context (and controls which plain
      // creates are resolvable), so a reorder invalidates prepared results.
      for (const item of state.steps) {
        if (item.kind === 'deploy') invalidatePredictions(state, item.id);
      }
    },
    addCallStep: {
      reducer(
        state,
        action: PayloadAction<{ afterIndex: number; id: string }>
      ) {
        const at = Math.max(
          -1,
          Math.min(action.payload.afterIndex, state.steps.length - 1)
        );
        const step: DraftCallStep = {
          id: action.payload.id,
          kind: 'call',
          target: null,
        };
        state.steps.splice(at + 1, 0, step);
      },
      prepare(afterIndex: number) {
        return {
          payload: { afterIndex, id: `call-${globalThis.crypto.randomUUID()}` },
        };
      },
    },
    removeCallStep(state, action: PayloadAction<string>) {
      const index = state.steps.findIndex(
        (step) => step.id === action.payload && step.kind === 'call'
      );
      if (index === -1) return;
      const [removed] = state.steps.splice(index, 1);
      const affected = state.steps
        .filter(
          (step) =>
            step.kind === 'deploy' &&
            stepDependsOn(step, state.deployExtras[step.id], removed.id)
        )
        .map((step) => step.id);
      clearDanglingReferences(state, removed.id);
      for (const stepId of affected) invalidatePredictions(state, stepId);
    },
    toggleChain(state, action: PayloadAction<number>) {
      const chainId = action.payload;
      const index = state.chains.indexOf(chainId);
      if (index === -1) {
        state.chains.push(chainId);
        return;
      }
      state.chains.splice(index, 1);
      const key = String(chainId);
      delete state.rpcSelection[key];
      delete state.explorerSelection[key];
      delete state.signers.perChain?.[key];
      for (const step of state.steps) {
        delete step.argsPerChain?.[key];
        delete step.valuePerChain?.[key];
        delete step.gasOverridesPerChain?.[key];
      }
      for (const extras of Object.values(state.deployExtras)) {
        if (extras.strategy.kind === 'create2')
          delete extras.strategy.saltPerChain?.[key];
        delete extras.librariesPerChain?.[key];
      }
      pruneChainPredictions(state, chainId);
    },
    selectRpc(
      state,
      action: PayloadAction<{
        chainId: number;
        endpointId: string;
        label: string;
      }>
    ) {
      const { chainId, endpointId, label } = action.payload;
      state.rpcSelection[String(chainId)] = { endpointId, label };
    },
    setExplorerSelection(
      state,
      action: PayloadAction<Record<string, string[]>>
    ) {
      state.explorerSelection = action.payload;
    },
    setGlobalSigner(state, action: PayloadAction<SignerRef | undefined>) {
      state.signers.global = action.payload;
    },
    setChainSigner(
      state,
      action: PayloadAction<{ chainId: number; signer?: SignerRef }>
    ) {
      const key = String(action.payload.chainId);
      if (action.payload.signer === undefined) {
        delete state.signers.perChain?.[key];
        if (Object.keys(state.signers.perChain ?? {}).length === 0) {
          delete state.signers.perChain;
        }
        return;
      }
      state.signers.perChain ??= {};
      state.signers.perChain[key] = action.payload.signer;
    },
    setArg(state, action: PayloadAction<SetArgPayload>) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      step.args ??= {};
      step.args[action.payload.key] = action.payload.value;
      if (step.kind === 'deploy') invalidatePredictions(state, step.id);
    },
    setChainArgOverride(
      state,
      action: PayloadAction<SetChainArgOverridePayload>
    ) {
      const { stepId, chainId, key, value } = action.payload;
      const step = state.steps.find(({ id }) => id === stepId);
      if (!step) return;
      const chainKey = String(chainId);
      if (value === undefined) {
        delete step.argsPerChain?.[chainKey]?.[key];
        removeEmptyRecord(step.argsPerChain, chainKey);
        if (Object.keys(step.argsPerChain ?? {}).length === 0) {
          delete step.argsPerChain;
        }
        if (step.kind === 'deploy') invalidatePredictions(state, step.id);
        return;
      }
      step.argsPerChain ??= {};
      step.argsPerChain[chainKey] ??= {};
      step.argsPerChain[chainKey][key] = value;
      if (step.kind === 'deploy') invalidatePredictions(state, step.id);
    },
    setValue(state, action: PayloadAction<{ stepId: string; value?: string }>) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      step.value = action.payload.value;
    },
    setValuePerChain(
      state,
      action: PayloadAction<{ stepId: string; chainId: number; value?: string }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      const key = String(action.payload.chainId);
      if (action.payload.value === undefined) {
        delete step.valuePerChain?.[key];
        if (Object.keys(step.valuePerChain ?? {}).length === 0)
          delete step.valuePerChain;
        return;
      }
      step.valuePerChain ??= {};
      step.valuePerChain[key] = action.payload.value;
    },
    setGasOverride(
      state,
      action: PayloadAction<{
        stepId: string;
        key: GasOverrideKey;
        value?: string;
      }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      if (action.payload.value === undefined) {
        delete step.gasOverrides?.[action.payload.key];
        if (Object.keys(step.gasOverrides ?? {}).length === 0) {
          delete step.gasOverrides;
        }
        return;
      }
      step.gasOverrides ??= {};
      step.gasOverrides[action.payload.key] = action.payload.value;
    },
    setGasOverridePerChain(
      state,
      action: PayloadAction<{
        stepId: string;
        chainId: number;
        key: GasOverrideKey;
        value?: string;
      }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      const chainKey = String(action.payload.chainId);
      if (action.payload.value === undefined) {
        delete step.gasOverridesPerChain?.[chainKey]?.[action.payload.key];
        removeEmptyRecord(step.gasOverridesPerChain, chainKey);
        if (Object.keys(step.gasOverridesPerChain ?? {}).length === 0) {
          delete step.gasOverridesPerChain;
        }
        return;
      }
      step.gasOverridesPerChain ??= {};
      step.gasOverridesPerChain[chainKey] ??= {};
      step.gasOverridesPerChain[chainKey][action.payload.key] =
        action.payload.value;
    },
    setCallStepField(
      state,
      action: PayloadAction<{
        id: string;
        patch: Partial<Omit<DraftCallStep, 'id' | 'kind'>>;
      }>
    ) {
      const step = state.steps.find(
        (item): item is DraftCallStep =>
          item.id === action.payload.id && item.kind === 'call'
      );
      if (!step) return;
      Object.assign(step, action.payload.patch);
    },
    setStrategy(
      state,
      action: PayloadAction<{
        stepId: string;
        strategy: DraftDeployExtras['strategy'];
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      // A strategy kind owns all prepare/ack/salt state. Do not let a
      // Create2 commitment leak into a plugin (or vice versa).
      if (extras.strategy.kind !== action.payload.strategy.kind) {
        delete extras.prepared;
        delete extras.acknowledged;
        delete extras.needsPrepare;
      }
      extras.strategy = action.payload.strategy;
      if (extras.strategy.kind === 'plugin') extras.needsPrepare = true;
      invalidatePredictions(state, action.payload.stepId);
    },
    setSalt(state, action: PayloadAction<{ stepId: string; salt?: Hex32 }>) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras || extras.strategy.kind !== 'create2') return;
      extras.strategy.salt = action.payload.salt;
      invalidatePredictions(state, action.payload.stepId);
    },
    setSaltPerChain(
      state,
      action: PayloadAction<{ stepId: string; chainId: number; salt?: Hex32 }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras || extras.strategy.kind !== 'create2') return;
      const key = String(action.payload.chainId);
      if (action.payload.salt === undefined) {
        delete extras.strategy.saltPerChain?.[key];
        if (Object.keys(extras.strategy.saltPerChain ?? {}).length === 0)
          delete extras.strategy.saltPerChain;
      } else {
        extras.strategy.saltPerChain ??= {};
        extras.strategy.saltPerChain[key] = action.payload.salt;
      }
      invalidatePredictions(state, action.payload.stepId);
    },
    setLibraries(
      state,
      action: PayloadAction<{
        stepId: string;
        libraries?: Record<string, LibraryBinding>;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.libraries = action.payload.libraries;
      invalidatePredictions(state, action.payload.stepId);
    },
    setLibrariesPerChain(
      state,
      action: PayloadAction<{
        stepId: string;
        librariesPerChain?: Record<string, Record<string, LibraryBinding>>;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.librariesPerChain = action.payload.librariesPerChain;
      invalidatePredictions(state, action.payload.stepId);
    },
    setPluginParams(
      state,
      action: PayloadAction<{
        stepId: string;
        params?: Record<string, unknown>;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras || extras.strategy.kind !== 'plugin') return;
      extras.strategy.params = action.payload.params;
      invalidatePredictions(state, action.payload.stepId);
    },
    storePrepared(
      state,
      action: PayloadAction<{
        stepId: string;
        chains: Record<
          string,
          {
            salt: Hex32;
            predictedAddress: Hex;
            initcodeHash: Hex32;
            notes: string[];
          }
        >;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.prepared = action.payload.chains;
      delete extras.needsPrepare;
    },
    acknowledgeDeployed(
      state,
      action: PayloadAction<{
        stepId: string;
        chainId: number;
        predictedAddress: Hex;
        initcodeHash: Hex32;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.acknowledged ??= {};
      extras.acknowledged[String(action.payload.chainId)] = {
        predictedAddress: action.payload.predictedAddress,
        initcodeHash: action.payload.initcodeHash,
      };
    },
    setStepSigner(
      state,
      action: PayloadAction<{ stepId: string; cascade?: SignerCascade }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (step) step.signerOverride = action.payload.cascade;
    },
    setName(state, action: PayloadAction<string | undefined>) {
      state.name = action.payload;
    },
    mintIdempotencyKey: {
      reducer(state, action: PayloadAction<string>) {
        state.idempotencyKey ??= action.payload;
      },
      prepare() {
        return { payload: globalThis.crypto.randomUUID() };
      },
    },
    clearDraft() {
      return initialState;
    },
  },
});

export const {
  hydrateWorkflowDraft,
  toggleWorkflowStep,
  confirmExternalResolution,
  workflowDraftSaved,
  acceptWorkflowPinUpdate,
  setWorkflowRunHooks,
  acknowledgeArtifactDrift,
  seedDraft,
  addContracts,
  removeContract,
  markDraftSeen,
  draftLaunched,
  moveStep,
  addCallStep,
  removeCallStep,
  toggleChain,
  selectRpc,
  setExplorerSelection,
  setGlobalSigner,
  setChainSigner,
  setArg,
  setChainArgOverride,
  setValue,
  setValuePerChain,
  setGasOverride,
  setGasOverridePerChain,
  setCallStepField,
  setStrategy,
  setSalt,
  setSaltPerChain,
  setLibraries,
  setLibrariesPerChain,
  setPluginParams,
  storePrepared,
  acknowledgeDeployed,
  setStepSigner,
  setName,
  mintIdempotencyKey,
  clearDraft,
} = deployDraftSlice.actions;

export const deployDraftReducer = deployDraftSlice.reducer;
export { initialState as deployDraftInitialState };

export function workflowDependentsForExclusion(
  state: DeployDraftState,
  stepId: string
): string[] {
  const affected = new Set<string>();
  const pending = [stepId];
  while (pending.length) {
    const current = pending.pop()!;
    for (const step of state.steps) {
      if (step.id === stepId || affected.has(step.id)) continue;
      if (stepDependsOn(step, state.deployExtras[step.id], current)) {
        affected.add(step.id);
        pending.push(step.id);
      }
    }
  }
  return [...affected];
}

export function ackStale(
  state: DeployDraftState,
  stepId: string,
  chainId: number
): boolean {
  const extras = state.deployExtras[stepId];
  const acknowledgement = extras?.acknowledged?.[String(chainId)];
  const prepared = extras?.prepared?.[String(chainId)];
  return Boolean(
    acknowledgement &&
    (!prepared ||
      acknowledgement.predictedAddress !== prepared.predictedAddress ||
      acknowledgement.initcodeHash !== prepared.initcodeHash)
  );
}
