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
  permission: 'repoWrite' | 'net';
  retry: RetryCall | null;
}

interface TrustState {
  pendingApproval: PendingApproval | null;
  // True while the grant round-trip (listPluginTrust → setPluginTrust →
  // retry) is running; pendingApproval is kept so permissionRequired keeps
  // ignoring new denials until the whole flow settles.
  inFlight: boolean;
}

const initialState: TrustState = {
  pendingApproval: null,
  inFlight: false,
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
    // User clicked Allow: hide the dialog but keep the approval reserved
    // while the grant round-trip runs.
    approvalConfirmed(state) {
      if (state.pendingApproval) {
        state.inFlight = true;
      }
    },
    // User cancelled (Cancel button, overlay, Escape). No-op while the
    // grant is in flight — ConfirmDialog closes itself synchronously after
    // onConfirm, and that close must not clear the reserved approval.
    approvalCancelled(state) {
      if (!state.inFlight) {
        state.pendingApproval = null;
      }
    },
    approvalDismissed(state) {
      state.pendingApproval = null;
      state.inFlight = false;
    },
  },
});

export const {
  permissionRequired,
  approvalConfirmed,
  approvalCancelled,
  approvalDismissed,
} = trustSlice.actions;
export const selectPendingApproval = (s: RootState) =>
  s.trust.pendingApproval;
export const selectApprovalInFlight = (s: RootState) => s.trust.inFlight;
export const trustReducer = trustSlice.reducer;
