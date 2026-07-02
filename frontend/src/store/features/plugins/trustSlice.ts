import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../store';

// The original api/dispatch payload (endpoint/params/query/body only — the
// success/error callbacks are not serializable and are dropped on retry).
export interface RetryCall {
  endpoint: string;
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

export interface PendingApproval {
  pluginId: string;
  permission: 'hostWrite' | 'net';
  retry: RetryCall | null;
}

interface TrustState {
  pendingApproval: PendingApproval | null;
}

const initialState: TrustState = {
  pendingApproval: null,
};

const trustSlice = createSlice({
  name: 'trust',
  initialState,
  reducers: {
    permissionRequired(state, action: PayloadAction<PendingApproval>) {
      // First prompt wins; further denials for the same run are noise.
      if (!state.pendingApproval) {
        state.pendingApproval = action.payload;
      }
    },
    approvalDismissed(state) {
      state.pendingApproval = null;
    },
  },
});

export const { permissionRequired, approvalDismissed } = trustSlice.actions;
export const selectPendingApproval = (s: RootState) =>
  s.trust.pendingApproval;
export const trustReducer = trustSlice.reducer;
