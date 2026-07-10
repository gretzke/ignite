import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SendSignerTxRequest, SignerProviderAccounts } from '@ignite/api';
import type { ApiError } from '@ignite/api/client';
import { apiClient } from '../../api/client';
import { formatApiError } from '../../middleware/apiGate';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';
import { runtimeHost } from '../../../runtime/RuntimeHost';
import type { AppDispatch } from '../../store';

interface SignersState {
  providers: SignerProviderAccounts[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  sendError: string | null;
  lastSendJobId: string | null;
  connectingPluginId: string | null;
  connectError: { pluginId: string; message: string } | null;
}

const initialState: SignersState = {
  providers: [],
  loading: false,
  sending: false,
  error: null,
  sendError: null,
  lastSendJobId: null,
  connectingPluginId: null,
  connectError: null,
};

const signersSlice = createSlice({
  name: 'signers',
  initialState,
  reducers: {
    listSignerAccountsStarted(state) {
      state.loading = true;
      state.error = null;
    },
    listSignerAccountsSucceeded(
      state,
      action: PayloadAction<SignerProviderAccounts[]>
    ) {
      state.providers = action.payload;
      state.loading = false;
      state.error = null;
    },
    listSignerAccountsFailed(state, action: PayloadAction<string>) {
      state.loading = false;
      state.error = action.payload;
    },
    sendSignerTxStarted(state) {
      state.sending = true;
      state.sendError = null;
    },
    sendSignerTxSucceeded(state, action: PayloadAction<string>) {
      state.sending = false;
      state.sendError = null;
      state.lastSendJobId = action.payload;
    },
    sendSignerTxFailed(state, action: PayloadAction<string>) {
      state.sending = false;
      state.sendError = action.payload;
    },
    connectWalletStarted(state, action: PayloadAction<string>) {
      state.connectingPluginId = action.payload;
      state.connectError = null;
    },
    connectWalletSucceeded(state) {
      state.connectingPluginId = null;
      state.connectError = null;
    },
    connectWalletFailed(
      state,
      action: PayloadAction<{ pluginId: string; message: string }>
    ) {
      state.connectingPluginId = null;
      state.connectError = action.payload;
    },
  },
});

export const {
  listSignerAccountsStarted,
  listSignerAccountsSucceeded,
  listSignerAccountsFailed,
  sendSignerTxStarted,
  sendSignerTxSucceeded,
  sendSignerTxFailed,
  connectWalletStarted,
  connectWalletSucceeded,
  connectWalletFailed,
} = signersSlice.actions;

export const signersReducer = signersSlice.reducer;

export const signersApi = {
  listAccounts(refresh?: boolean) {
    return [
      listSignerAccountsStarted(),
      apiClient.dispatch.listSignerAccounts({
        query: refresh ? { refresh: 'true' } : undefined,
        onSuccess: (data) => [listSignerAccountsSucceeded(data.providers)],
        onError: (error) => [
          listSignerAccountsFailed(formatApiError(error).description),
        ],
      }),
    ];
  },
  sendTx(body: SendSignerTxRequest) {
    return [
      sendSignerTxStarted(),
      apiClient.dispatch.sendSignerTx({
        body,
        onSuccess: (data) => [
          sendSignerTxSucceeded(data.job.id),
          jobStarted({
            jobId: data.job.id,
            type: data.job.type,
            params: data.job.params,
          }),
          wsSend({ type: 'subscribe', jobId: data.job.id }),
        ],
        onError: (error: ApiError) => [
          sendSignerTxFailed(formatApiError(error).description),
        ],
      }),
    ];
  },
  connectWallet(pluginId: string, rdns?: string) {
    return async (dispatch: AppDispatch) => {
      dispatch(connectWalletStarted(pluginId));
      // With an rdns only that wallet extension prompts; without one the
      // plugin loops eth_requestAccounts over every installed wallet.
      const result = await runtimeHost.invokeLocal(
        pluginId,
        'connect',
        rdns ? { rdns } : undefined
      );
      if (!result.success) {
        dispatch(
          connectWalletFailed({
            pluginId,
            message: result.error.message,
          })
        );
        return;
      }
      dispatch(connectWalletSucceeded());
      signersApi.listAccounts(true).forEach((action) => dispatch(action));
    };
  },
};
