import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  SendSignerTxRequest,
  SignerProviderAccounts,
} from '@ignite/api';
import type { ApiError } from '@ignite/api/client';
import { apiClient } from '../../api/client';
import { formatApiError } from '../../middleware/apiGate';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';

interface SignersState {
  providers: SignerProviderAccounts[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  sendError: string | null;
  lastSendJobId: string | null;
}

const initialState: SignersState = {
  providers: [],
  loading: false,
  sending: false,
  error: null,
  sendError: null,
  lastSendJobId: null,
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
  },
});

export const {
  listSignerAccountsStarted,
  listSignerAccountsSucceeded,
  listSignerAccountsFailed,
  sendSignerTxStarted,
  sendSignerTxSucceeded,
  sendSignerTxFailed,
} = signersSlice.actions;

export const signersReducer = signersSlice.reducer;

export const signersApi = {
  listAccounts(refresh?: boolean) {
    return [
      listSignerAccountsStarted(),
      apiClient.dispatch.listSignerAccounts({
        query: refresh ? { refresh: 'true' } : undefined,
        onSuccess: (data) => [
          listSignerAccountsSucceeded(data.providers),
        ],
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
};
