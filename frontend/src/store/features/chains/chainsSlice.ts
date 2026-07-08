import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  AddRpcRequest,
  ChainInfo,
  ListChainsData,
  ProviderStatus,
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
  providerRpcByChain: Record<string, RpcEndpoint[]>;
  // Per-plugin summary (ok / needs-config), keyed by chainId like the maps
  // above — a provider's config state doesn't actually vary per chain, but
  // the response is per-chain-request so it's stored the same way.
  providerStatusesByChain: Record<string, ProviderStatus[]>;
  // Ephemeral pre-save URL check (add-RPC dialog)
  rpcCheck: {
    url: string | null;
    checking: boolean;
    result: RpcVerificationResult | null;
    error: string | null;
  };
  // Ephemeral verification results for plugin-provided endpoints, keyed by
  // the synthetic endpoint id. Separate from rpcCheck (the add-input slot).
  providerChecks: Record<string, RpcVerificationResult | 'checking'>;
}

const initialState: IChainsState = {
  chains: [],
  total: 0,
  fetchedAt: null,
  loading: false,
  rpcByChain: {},
  providerRpcByChain: {},
  providerStatusesByChain: {},
  rpcCheck: { url: null, checking: false, result: null, error: null },
  providerChecks: {},
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
    fetchRpcsFailed(state, action: PayloadAction<{ chainId: number }>) {
      // Only initialize empty endpoints if never fetched; don't clobber on refresh failure.
      const chainIdStr = String(action.payload.chainId);
      if (state.rpcByChain[chainIdStr] === undefined) {
        state.rpcByChain[chainIdStr] = [];
      }
      if (state.providerRpcByChain[chainIdStr] === undefined) {
        state.providerRpcByChain[chainIdStr] = [];
      }
      if (state.providerStatusesByChain[chainIdStr] === undefined) {
        state.providerStatusesByChain[chainIdStr] = [];
      }
    },
    fetchRpcsSucceeded(
      state,
      action: PayloadAction<{
        chainId: number;
        endpoints: RpcEndpoint[];
        providerEndpoints?: RpcEndpoint[];
        providerStatuses?: ProviderStatus[];
      }>
    ) {
      state.rpcByChain[String(action.payload.chainId)] =
        action.payload.endpoints;
      // Routes that don't compute provider endpoints (setPreferredRpc) must not clobber the cached list.
      if (action.payload.providerEndpoints !== undefined) {
        state.providerRpcByChain[String(action.payload.chainId)] =
          action.payload.providerEndpoints;
      }
      // Same guard as providerEndpoints above: undefined (degraded response)
      // must not clobber a previously-known-good statuses list.
      if (action.payload.providerStatuses !== undefined) {
        state.providerStatusesByChain[String(action.payload.chainId)] =
          action.payload.providerStatuses;
      }
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
    providerCheckStarted(state, action: PayloadAction<string>) {
      state.providerChecks[action.payload] = 'checking';
    },
    providerCheckReceived(
      state,
      action: PayloadAction<{ id: string; result: RpcVerificationResult }>
    ) {
      state.providerChecks[action.payload.id] = action.payload.result;
    },
    providerCheckFailed(
      state,
      action: PayloadAction<{ id: string; error: string }>
    ) {
      state.providerChecks[action.payload.id] = {
        ok: false,
        error: action.payload.error,
        checkedAt: new Date().toISOString(),
      };
    },
    providerChecksReset(state) {
      state.providerChecks = {};
    },
  },
});

export const {
  fetchChainsStarted,
  fetchChainsSucceeded,
  fetchChainsFailed,
  fetchRpcsFailed,
  fetchRpcsSucceeded,
  rpcVerificationReceived,
  rpcCheckStarted,
  rpcCheckFinished,
  rpcCheckFailed,
  rpcCheckReset,
  providerCheckStarted,
  providerCheckReceived,
  providerCheckFailed,
  providerChecksReset,
} = chainsSlice.actions;

export const chainsReducer = chainsSlice.reducer;

const refetchChains = () =>
  apiClient.dispatch.listChains({
    query: { limit: 200 },
    onSuccess: (data) => fetchChainsSucceeded(data),
    onError: () => fetchChainsFailed(),
  });

const refetchRpcs = (chainId: number, refresh?: boolean) =>
  apiClient.dispatch.listRpcs({
    params: { chainId: String(chainId) },
    // Never send refresh=false: the zod coercion on the query treats any
    // non-empty string as true, so the query key must be omitted entirely
    // when refresh isn't truthy.
    ...(refresh ? { query: { refresh: true } } : {}),
    onSuccess: (data) =>
      fetchRpcsSucceeded({
        chainId,
        endpoints: data.endpoints,
        providerEndpoints: data.providerEndpoints,
        providerStatuses: data.providerStatuses,
      }),
    onError: () => fetchRpcsFailed({ chainId }),
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

  fetchRpcs: (chainId: number, refresh?: boolean) =>
    refetchRpcs(chainId, refresh),

  addRpc: (chainId: number, body: AddRpcRequest) => {
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
        fetchRpcsSucceeded({
          chainId,
          endpoints: data.endpoints,
        }),
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

  // Ephemeral verification of a plugin-provided endpoint. Uses the shared
  // checkRpc backend call but stores results in providerChecks (keyed by
  // the synthetic endpoint id) rather than the add-input's rpcCheck slot.
  checkProviderRpc: (chainId: number, endpoint: RpcEndpoint) => [
    providerCheckStarted(endpoint.id),
    apiClient.dispatch.checkRpc({
      body: { url: endpoint.url, expectedChainId: chainId },
      onSuccess: (data) =>
        providerCheckReceived({ id: endpoint.id, result: data.result }),
      onError: (err) =>
        providerCheckFailed({
          id: endpoint.id,
          error: (err as { message?: string })?.message ?? 'Check failed',
        }),
    }),
  ],
};
