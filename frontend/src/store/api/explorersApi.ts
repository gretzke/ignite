import type { AddExplorerRequest, UpdateExplorerRequest } from '@ignite/api';
import { apiClient } from './client';
import {
  explorerReceived,
  explorerRemoved,
  explorersFetched,
  explorersFetchFailed,
  explorersFetchStarted,
  explorerSelectionReceived,
  explorerSelectionSet,
} from '../features/explorers/explorersSlice';

export const explorersApi = {
  fetchExplorers: (chainId: number) => [
    explorersFetchStarted(chainId),
    apiClient.dispatch.listExplorers({
      query: { chainId },
      onSuccess: (data) => explorersFetched({ chainId, data }),
      onError: () => explorersFetchFailed(chainId),
    }),
  ],
  addExplorer: (body: AddExplorerRequest) =>
    apiClient.dispatch.addExplorer({
      body,
      onSuccess: (data) => explorerReceived(data.entry),
    }),
  updateExplorer: (id: string, body: UpdateExplorerRequest) =>
    apiClient.dispatch.updateExplorer({
      params: { id },
      body,
      onSuccess: (data) => explorerReceived(data.entry),
    }),
  removeExplorer: (id: string) =>
    apiClient.dispatch.removeExplorer({
      params: { id },
      onSuccess: () => explorerRemoved(id),
    }),
  setSelection: (chainId: number, entryIds: string[]) => [
    explorerSelectionSet({ chainId, entryIds }),
    apiClient.dispatch.setExplorerSelection({
      body: { chainId, entryIds },
      onSuccess: (data) => explorerSelectionReceived(data.selection),
    }),
  ],
};
