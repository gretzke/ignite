import ConfirmDialog from './ConfirmDialog';
import { useAppDispatch, useAppSelector } from '../store';
import {
  approvalCancelled,
  approvalConfirmed,
  approvalDismissed,
  selectApprovalInFlight,
  selectPendingApproval,
} from '../store/features/plugins/trustSlice';
import { apiClient, apiDispatchAction } from '../store/api/client';
import { triggerToast } from '../store/middleware/toastListener';
import { jobStarted } from '../store/features/jobs/jobsSlice';
import { wsSend } from '../store/middleware/websocket';
import type { ApiError } from '@ignite/api/client';
import type { ListPluginTrustData } from '@ignite/api';

const PERMISSION_COPY: Record<'hostWrite' | 'net', string> = {
  hostWrite:
    'write files in your repository (compilation output, artifacts)',
  net: 'access the network (RPC endpoints, block explorers)',
};

export default function PermissionApprovalDialog() {
  const dispatch = useAppDispatch();
  const pending = useAppSelector(selectPendingApproval);
  const inFlight = useAppSelector(selectApprovalInFlight);

  if (!pending) return null;

  const { pluginId, permission, retry } = pending;

  // Surface the failure and settle the flow. approvalDismissed clears the
  // in-flight state so a failed grant doesn't wedge future prompts.
  const grantFailed = (error: ApiError) => [
    triggerToast({
      title: 'Permission grant failed',
      description: error.body.message,
      variant: 'error',
      duration: 6000,
    }),
    approvalDismissed(),
  ];

  const grantTrust = (permissions: { hostWrite: boolean; net: boolean }) => {
    dispatch(
      apiClient.dispatch.setPluginTrust({
        params: { pluginId },
        body: { trust: 'trusted', permissions },
        onSuccess: () => {
          const actions = [];
          if (retry) {
            actions.push(
              apiDispatchAction({
                endpoint: retry.endpoint as Parameters<
                  typeof apiDispatchAction
                >[0]['endpoint'],
                params: retry.params,
                query: retry.query,
                body: retry.body,
                // The retried call has no onSuccess of its own (RetryCall
                // only carries endpoint/params/query/body — callbacks
                // aren't serializable), so a job-based retry (e.g.
                // installPlugin) would otherwise never get tracked or
                // subscribed to. Seed a placeholder job here; jobsEffects'
                // terminal routing reads job.type from the WS snapshot, not
                // this placeholder, so an empty type is safe.
                onSuccess: (data: unknown) => {
                  if (
                    data &&
                    typeof data === 'object' &&
                    typeof (data as { jobId?: unknown }).jobId === 'string'
                  ) {
                    const { jobId } = data as { jobId: string };
                    return [
                      jobStarted({ jobId, type: '', params: {} }),
                      wsSend({ type: 'subscribe', jobId }),
                    ];
                  }
                },
              })
            );
          }
          actions.push(approvalDismissed());
          return actions;
        },
        onError: grantFailed,
      })
    );
  };

  const handleApprove = () => {
    // Reserve the approval for the whole round-trip: the dialog hides, but
    // pendingApproval stays set so new PERMISSION_REQUIRED denials are
    // ignored until the grant settles.
    dispatch(approvalConfirmed());
    // Merge with any existing granted permissions so approving one
    // permission doesn't clobber a previously-granted other permission.
    dispatch(
      apiClient.dispatch.listPluginTrust({
        onSuccess: (data: unknown) => {
          const existing = (data as ListPluginTrustData).plugins.find(
            (p) => p.pluginId === pluginId
          );
          grantTrust({
            hostWrite:
              (existing?.permissions.hostWrite ?? false) ||
              permission === 'hostWrite',
            net: (existing?.permissions.net ?? false) || permission === 'net',
          });
          return [];
        },
        // If we can't read the current permissions, abort instead of
        // posting a single-permission body that could revoke a
        // previously-granted permission.
        onError: grantFailed,
      })
    );
  };

  return (
    <ConfirmDialog
      open={!inFlight}
      onOpenChange={(open) => {
        // approvalCancelled is a no-op in the reducer while the grant is in
        // flight, so the synchronous close ConfirmDialog fires right after
        // onConfirm doesn't clear the reserved approval.
        if (!open) dispatch(approvalCancelled());
      }}
      title={`Allow ${pluginId}?`}
      description={`The plugin ${pluginId} wants to ${PERMISSION_COPY[permission]}. Only approve plugins you trust — this permission persists until you revoke it.`}
      confirmText="Allow"
      variant="warning"
      onConfirm={handleApprove}
    />
  );
}
