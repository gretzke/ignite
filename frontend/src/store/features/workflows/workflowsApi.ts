import { apiClient } from '../../api/client';
import { formatApiError } from '../../middleware/apiGate';
import { triggerToast } from '../../middleware/toastListener';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';
import {
  workflowDocumentLoaded,
  workflowListFailed,
  workflowListLoaded,
  workflowListRequested,
  workflowOriginsApprovalCleared,
  workflowOriginsApprovalRequested,
  workflowResolveFailed,
  workflowResolveStarted,
  workflowUpdatesFailed,
  workflowUpdatesLoaded,
  workflowUpdatesRequested,
} from './workflowsSlice';
import type { WorkflowDocument } from '@ignite/api';
import { workflowDraftSaved } from '../deployments/deployDraftSlice';

function originDetails(error: { body?: { code?: string; details?: unknown } }): string[] | undefined {
  if (error.body?.code !== 'PINNED_ORIGIN_UNAPPROVED') return undefined;
  const origins = (error.body.details as { origins?: unknown } | undefined)?.origins;
  return Array.isArray(origins) && origins.every((origin) => typeof origin === 'string') ? origins : undefined;
}

export const workflowsApi = {
  list: (repoPathOrUrl: string) => [
    workflowListRequested(repoPathOrUrl),
    apiClient.dispatch.listWorkflows({
      query: { pathOrUrl: repoPathOrUrl },
      onSuccess: ({ workflows, truncated }) => workflowListLoaded({ repoPathOrUrl, workflows, truncated }),
      onError: (error) => workflowListFailed({ repoPathOrUrl, error: formatApiError(error).description }),
    }),
  ],
  get: (repoPathOrUrl: string, name: string) => apiClient.dispatch.getWorkflow({
    params: { name }, query: { pathOrUrl: repoPathOrUrl },
    onSuccess: (data) => workflowDocumentLoaded({ repoPathOrUrl, name, ...data }),
  }),
  put: (repoPathOrUrl: string, name: string, document: WorkflowDocument, baseDocHash: string) => apiClient.dispatch.putWorkflow({
    params: { name }, query: { pathOrUrl: repoPathOrUrl }, body: { document, baseDocHash },
    onSuccess: ({ docHash }) => [
      workflowDraftSaved({ document, docHash }),
      workflowDocumentLoaded({ repoPathOrUrl, name, document, raw: JSON.stringify(document, null, 2), docHash }),
      triggerToast({ title: 'Workflow saved', description: `${name}.json was updated.`, variant: 'success' }),
    ],
    onError: (error) => {
      if (error.status === 409) return triggerToast({ title: 'Workflow changed on disk', description: 'Reload the workflow before saving so you do not overwrite someone else’s changes.', variant: 'warning', duration: 8000 });
      return triggerToast({ title: 'Workflow save failed', description: formatApiError(error).description, variant: 'error' });
    },
  }),
  resolve: (repoPathOrUrl: string, name: string) => apiClient.dispatch.resolveWorkflow({
    body: { repoPathOrUrl, name },
    onSuccess: ({ jobId }) => [
      workflowResolveStarted({ repoPathOrUrl, name, jobId }),
      jobStarted({ jobId, type: 'workflow.resolve', params: { repoPathOrUrl, name } }),
      wsSend({ type: 'subscribe', jobId }),
    ],
    onError: (error) => {
      const origins = originDetails(error);
      if (origins) return workflowOriginsApprovalRequested({ repoPathOrUrl, name, origins });
      return workflowResolveFailed({ repoPathOrUrl, name, error: formatApiError(error).description });
    },
  }),
  approveOrigins: (repoPathOrUrl: string, name: string, origins: string[]) => apiClient.dispatch.approveWorkflowOrigins({
    body: { origins },
    onSuccess: () => [workflowOriginsApprovalCleared(), workflowsApi.resolve(repoPathOrUrl, name)],
  }),
  checkUpdates: (repoPathOrUrl: string, name: string) => [
    workflowUpdatesRequested({ repoPathOrUrl, name }),
    apiClient.dispatch.checkWorkflowUpdates({
      body: { repoPathOrUrl, name },
      onSuccess: (report) => workflowUpdatesLoaded({ repoPathOrUrl, name, report }),
      onError: (error) => [
        workflowUpdatesFailed({ repoPathOrUrl, name, error: formatApiError(error).description }),
        triggerToast({ title: 'Update check failed', description: formatApiError(error).description, variant: 'error' }),
      ],
    }),
  ],
};
