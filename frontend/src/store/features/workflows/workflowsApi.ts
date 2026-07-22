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
  workflowStatusFailed,
  workflowStatusLoaded,
  workflowStatusRequested,
  workflowOriginsApprovalCleared,
  workflowOriginsApprovalRequested,
  workflowInstallFailed,
  workflowInstallStarted,
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

const installDocHashes = new Map<string, string>();
const installKey = (repoPathOrUrl: string, name: string) => `${repoPathOrUrl}\0${name}`;

export const workflowsApi = {
  list: (repoPathOrUrl: string) => [
    workflowListRequested(repoPathOrUrl),
    apiClient.dispatch.listWorkflows({
      query: { pathOrUrl: repoPathOrUrl },
      onSuccess: ({ workflows, truncated }) => workflowListLoaded({ repoPathOrUrl, workflows, truncated }),
      onError: (error) => workflowListFailed({ repoPathOrUrl, error: formatApiError(error).description }),
    }),
  ],
  getWorkflowsStatus: (repoPathOrUrl: string, profileId: string) => [
    workflowStatusRequested({ profileId, repoPathOrUrl }),
    apiClient.dispatch.getWorkflowsStatus({
      query: { pathOrUrl: repoPathOrUrl },
      onSuccess: ({ workflows }) => workflowStatusLoaded({ profileId, repoPathOrUrl, workflows }),
      onError: (error) => workflowStatusFailed({ profileId, repoPathOrUrl, error: formatApiError(error).description }),
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
  installWorkflow: ({ repoPathOrUrl, name, expectedDocHash }: { repoPathOrUrl: string; name: string; expectedDocHash: string }, profileId?: string, onDocumentChanged?: () => void) => {
    installDocHashes.set(installKey(repoPathOrUrl, name), expectedDocHash);
    return apiClient.dispatch.installWorkflow({
    body: { repoPathOrUrl, name, expectedDocHash },
    onSuccess: ({ jobId }) => [
      workflowInstallStarted({ repoPathOrUrl, name, jobId }),
      jobStarted({ jobId, type: 'workflow.install', params: { repoPathOrUrl, name, ...(profileId ? { profileId } : {}) } }),
      wsSend({ type: 'subscribe', jobId }),
    ],
    onError: (error) => {
      const origins = originDetails(error);
      if (origins) return workflowOriginsApprovalRequested({ repoPathOrUrl, name, origins, retry: 'install' });
      const installFailed = workflowInstallFailed({ repoPathOrUrl, name, error: formatApiError(error).description });
      if (error.status === 409 && error.body?.code === 'WORKFLOW_DOC_CHANGED' && profileId) {
        onDocumentChanged?.();
        return [installFailed, ...workflowsApi.getWorkflowsStatus(repoPathOrUrl, profileId)];
      }
      return installFailed;
    },
    });
  },
  approveOrigins: (repoPathOrUrl: string, name: string, origins: string[], retry: 'install' | 'updates' = 'install', profileId?: string) => apiClient.dispatch.approveWorkflowOrigins({
    body: { origins },
    onSuccess: () => [workflowOriginsApprovalCleared(), ...(retry === 'updates' ? workflowsApi.checkUpdates(repoPathOrUrl, name) : [workflowsApi.installWorkflow({ repoPathOrUrl, name, expectedDocHash: installDocHashes.get(installKey(repoPathOrUrl, name)) ?? '' }, profileId)])],
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
