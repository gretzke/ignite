import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  ChainInfo,
  ListChainsData,
  RpcEndpoint,
  RpcVerificationResult,
  UpsertChainRequest,
} from '@ignite/api';
import { apiClient, apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';

export interface IChainsState {
  chains: ChainInfo[];
  total: number;
  fetchedAt: string | null;
  loading: boolean;
  rpcByChain: Record<string, RpcEndpoint[]>;
  // Ephemeral pre-save URL check (add-RPC dialog)
  rpcCheck: {
    url: string | null;
    checking: boolean;
    result: RpcVerificationResult | null;
    error: string | null;
  };
}

const initialState: IChainsState = {
  chains: [],
  total: 0,
  fetchedAt: null,
  loading: false,
  rpcByChain: {},
  rpcCheck: { url: null, checking: false, result: null, error: null },
};

const chainsSlice = createSlice({
  name: 'chains',
  initialState,
  reducers: {
    fetchChainsStarted(state) {
      state.loading = true;
    },
    fetchChainsSucceeded(state, action: PayloadAction<ListChainsData>) {
      state.chains = action.payload.chains;
      state.total = action.payload.total;
      state.fetchedAt = action.payload.fetchedAt;
      state.loading = false;
    },
    fetchChainsFailed(state) {
      state.loading = false;
    },
    fetchRpcsSucceeded(
      state,
      action: PayloadAction<{ chainId: number; endpoints: RpcEndpoint[] }>
    ) {
      state.rpcByChain[String(action.payload.chainId)] =
        action.payload.endpoints;
    },
    rpcVerificationReceived(
      state,
      action: PayloadAction<{
        chainId: number;
        endpointId: string;
        result: RpcVerificationResult;
      }>
    ) {
      const endpoints = state.rpcByChain[String(action.payload.chainId)];
      const endpoint = endpoints?.find(
        (e) => e.id === action.payload.endpointId
      );
      if (endpoint) endpoint.lastVerification = action.payload.result;
    },
    rpcCheckStarted(state, action: PayloadAction<string>) {
      state.rpcCheck = {
        url: action.payload,
        checking: true,
        result: null,
        error: null,
      };
    },
    rpcCheckFinished(
      state,
      action: PayloadAction<{ url: string; result: RpcVerificationResult }>
    ) {
      if (state.rpcCheck.url !== action.payload.url) return; // stale response
      state.rpcCheck.checking = false;
      state.rpcCheck.result = action.payload.result;
    },
    rpcCheckFailed(
      state,
      action: PayloadAction<{ url: string; error: string }>
    ) {
      if (state.rpcCheck.url !== action.payload.url) return;
      state.rpcCheck.checking = false;
      state.rpcCheck.error = action.payload.error;
    },
    rpcCheckReset(state) {
      state.rpcCheck = { url: null, checking: false, result: null, error: null };
    },
  },
});

export const {
  fetchChainsStarted,
  fetchChainsSucceeded,
  fetchChainsFailed,
  fetchRpcsSucceeded,
  rpcVerificationReceived,
  rpcCheckStarted,
  rpcCheckFinished,
  rpcCheckFailed,
  rpcCheckReset,
} = chainsSlice.actions;

export const chainsReducer = chainsSlice.reducer;

const refetchChains = () =>
  apiClient.dispatch.listChains({
    query: { limit: 200 },
    onSuccess: (data) => fetchChainsSucceeded(data),
    onError: () => fetchChainsFailed(),
  });

const refetchRpcs = (chainId: number) =>
  apiClient.dispatch.listRpcs({
    params: { chainId: String(chainId) },
    onSuccess: (data) =>
      fetchRpcsSucceeded({ chainId, endpoints: data.endpoints }),
    onError: () => fetchChainsFailed(),
  });

export const chainsApi = {
  fetchChains: (q?: string, limit = 200) => [
    fetchChainsStarted(),
    apiClient.dispatch.listChains({
      query: { q, limit },
      onSuccess: (data) => fetchChainsSucceeded(data),
      onError: () => fetchChainsFailed(),
    }),
  ],

  refreshChains: () => {
    const apiAction = apiClient.dispatch.refreshChains({
      onSuccess: () => refetchChains(),
      onError: () => fetchChainsFailed(),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Refreshing chain list...',
        description: 'Fetching the latest chainlist dataset',
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Chain list refreshed',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },

  upsertChain: (body: UpsertChainRequest) => {
    const apiAction = apiClient.dispatch.upsertChain({
      body,
      onSuccess: () => refetchChains(),
      onError: () => fetchChainsFailed(),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Saving chain...',
        description: `Saving "${body.name}" (${body.chainId})`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: `Chain "${body.name}" saved`,
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },

  deleteChain: (chainId: number) => {
    const apiAction = apiClient.dispatch.deleteChain({
      params: { chainId: String(chainId) },
      onSuccess: () => refetchChains(),
      onError: () => fetchChainsFailed(),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Deleting chain...',
        description: `Removing custom chain ${chainId}`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Custom chain deleted',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },

  fetchRpcs: (chainId: number) => refetchRpcs(chainId),

  addRpc: (
    chainId: number,
    body: { url: string; label?: string; source?: 'manual' | 'chainlist' }
  ) => {
    const apiAction = apiClient.dispatch.addRpc({
      params: { chainId: String(chainId) },
      body,
      onSuccess: () => refetchRpcs(chainId),
      onError: () => fetchChainsFailed(),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Adding RPC endpoint...',
        description: body.url,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'RPC endpoint added',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },

  deleteRpc: (chainId: number, endpointId: string) => {
    const apiAction = apiClient.dispatch.deleteRpc({
      params: { chainId: String(chainId), endpointId },
      onSuccess: () => refetchRpcs(chainId),
      onError: () => fetchChainsFailed(),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Removing RPC endpoint...',
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'RPC endpoint removed',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },

  setPreferredRpc: (chainId: number, endpointId: string) =>
    apiClient.dispatch.setPreferredRpc({
      params: { chainId: String(chainId), endpointId },
      onSuccess: (data) =>
        fetchRpcsSucceeded({ chainId, endpoints: data.endpoints }),
      onError: () => fetchChainsFailed(),
    }),

  verifyRpc: (chainId: number, endpointId: string) =>
    apiClient.dispatch.verifyRpc({
      params: { chainId: String(chainId), endpointId },
      onSuccess: (data) =>
        rpcVerificationReceived({ chainId, endpointId, result: data.result }),
      onError: () => fetchChainsFailed(),
    }),

  checkRpc: (url: string, expectedChainId: number) => [
    rpcCheckStarted(url),
    apiClient.dispatch.checkRpc({
      body: { url, expectedChainId },
      onSuccess: (data) => rpcCheckFinished({ url, result: data.result }),
      onError: (err) =>
        rpcCheckFailed({
          url,
          error:
            (err as { message?: string })?.message || 'Endpoint check failed',
        }),
    }),
  ],
};
