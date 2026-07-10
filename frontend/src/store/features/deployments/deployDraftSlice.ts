import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SignerRef } from '@ignite/api';
import type {
  DeployDraftState,
  DraftContract,
  GasOverrideKey,
  SetArgPayload,
  SetChainArgOverridePayload,
} from './types';

const initialState: DeployDraftState = {
  contracts: [],
  chains: [],
  rpcSelection: {},
  signers: {},
  steps: [],
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

const deployDraftSlice = createSlice({
  name: 'deployDraft',
  initialState,
  reducers: {
    seedDraft(_state, action: PayloadAction<DraftContract[]>) {
      return {
        ...initialState,
        contracts: [...action.payload],
        steps: action.payload.map(stepFor),
      };
    },
    reorderSteps(
      state,
      action: PayloadAction<string[] | { fromIndex: number; toIndex: number }>
    ) {
      if (Array.isArray(action.payload)) {
        const positions = new Map(
          action.payload.map((stepId, index) => [stepId, index])
        );
        state.steps.sort(
          (a, b) =>
            (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        );
        return;
      }
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
      delete state.signers.perChain?.[key];
      for (const step of state.steps) {
        delete step.argsPerChain?.[key];
        delete step.valuePerChain?.[key];
        delete step.gasOverridesPerChain?.[key];
      }
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
        return;
      }
      step.argsPerChain ??= {};
      step.argsPerChain[chainKey] ??= {};
      step.argsPerChain[chainKey][key] = value;
    },
    setValue(state, action: PayloadAction<{ stepId: string; value?: string }>) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      step.value = action.payload.value;
    },
    setValuePerChain(
      state,
      action: PayloadAction<{
        stepId: string;
        chainId: number;
        value?: string;
      }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      const chainKey = String(action.payload.chainId);
      if (action.payload.value === undefined) {
        delete step.valuePerChain?.[chainKey];
        if (Object.keys(step.valuePerChain ?? {}).length === 0) {
          delete step.valuePerChain;
        }
        return;
      }
      step.valuePerChain ??= {};
      step.valuePerChain[chainKey] = action.payload.value;
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
  seedDraft,
  reorderSteps,
  toggleChain,
  selectRpc,
  setGlobalSigner,
  setChainSigner,
  setArg,
  setChainArgOverride,
  setValue,
  setValuePerChain,
  setGasOverride,
  setGasOverridePerChain,
  setName,
  mintIdempotencyKey,
  clearDraft,
} = deployDraftSlice.actions;

export const deployDraftReducer = deployDraftSlice.reducer;
export { initialState as deployDraftInitialState };
