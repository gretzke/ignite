import type { CreateVerificationRequest, ListVerificationsQuery } from '@ignite/api';
import { apiClient } from './client';
import {
  verificationTasksReceived,
  verificationsFetched,
  verificationsFetchFailed,
  verificationsFetchStarted,
} from '../features/verifications/verificationsSlice';

export const verificationsApi = {
  fetch: (query: ListVerificationsQuery = {}) => [
    verificationsFetchStarted({ runId: query.runId }),
    apiClient.dispatch.listVerifications({
      query,
      onSuccess: (data) => verificationsFetched({ runId: query.runId, data }),
      onError: () => verificationsFetchFailed({ runId: query.runId }),
    }),
  ],
  create: (body: CreateVerificationRequest) =>
    apiClient.dispatch.createVerification({
      body,
      onSuccess: (data) => verificationTasksReceived(data.tasks),
    }),
  retry: (id: string) =>
    apiClient.dispatch.retryVerification({
      params: { id },
      onSuccess: (data) => verificationTasksReceived([data.task]),
    }),
  cancel: (id: string) =>
    apiClient.dispatch.cancelVerification({
      params: { id },
      onSuccess: (data) => verificationTasksReceived([data.task]),
    }),
};
