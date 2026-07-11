import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ExplorerEntry, ExplorerSelection, ListExplorersData } from '@ignite/api';
import type { RootState } from '../../store';

export interface ExplorersState {
  // An absent key is deliberately distinct from an empty array: callers use
  // undefined for a loading spinner and [] for a completed, empty response.
  byChain: Record<string, ExplorerEntry[] | undefined>;
  selection: Record<string, string[]>;
}

const initialState: ExplorersState = { byChain: {}, selection: {} };

function replaceEntry(state: ExplorersState, entry: ExplorerEntry): void {
  const key = String(entry.chainId);
  const entries = state.byChain[key];
  if (!entries) {
    state.byChain[key] = [entry];
    return;
  }
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) entries.push(entry);
  else entries[index] = entry;
}

const explorersSlice = createSlice({
  name: 'explorers',
  initialState,
  reducers: {
    explorersFetchStarted(state, action: PayloadAction<number>) {
      const key = String(action.payload);
      // Preserve an existing result while an explicit refresh is in flight.
      // Only a never-requested chain uses undefined as its loading sentinel.
      if (!(key in state.byChain)) state.byChain[key] = undefined;
    },
    explorersFetched(
      state,
      action: PayloadAction<{ chainId: number; data: ListExplorersData }>
    ) {
      const key = String(action.payload.chainId);
      state.byChain[key] = action.payload.data.entries;
      state.selection[key] = action.payload.data.selection;
    },
    explorersFetchFailed(state, action: PayloadAction<number>) {
      const key = String(action.payload);
      if (state.byChain[key] === undefined) state.byChain[key] = [];
    },
    explorerReceived(state, action: PayloadAction<ExplorerEntry>) {
      replaceEntry(state, action.payload);
    },
    explorerRemoved(state, action: PayloadAction<string>) {
      for (const [chainId, entries] of Object.entries(state.byChain)) {
        if (!entries) continue;
        const next = entries.filter((entry) => entry.id !== action.payload);
        if (next.length !== entries.length) {
          state.byChain[chainId] = next;
          state.selection[chainId] = (state.selection[chainId] ?? []).filter(
            (id) => id !== action.payload
          );
          return;
        }
      }
    },
    explorerSelectionReceived(state, action: PayloadAction<ExplorerSelection>) {
      Object.assign(state.selection, action.payload);
    },
    explorerSelectionSet(
      state,
      action: PayloadAction<{ chainId: number; entryIds: string[] }>
    ) {
      state.selection[String(action.payload.chainId)] = action.payload.entryIds;
    },
  },
});

export const {
  explorersFetchStarted,
  explorersFetched,
  explorersFetchFailed,
  explorerReceived,
  explorerRemoved,
  explorerSelectionReceived,
  explorerSelectionSet,
} = explorersSlice.actions;
export const explorersReducer = explorersSlice.reducer;
export { initialState as explorersInitialState };

export const selectExplorersForChain = (state: RootState, chainId: number) =>
  state.explorers.byChain[String(chainId)];
