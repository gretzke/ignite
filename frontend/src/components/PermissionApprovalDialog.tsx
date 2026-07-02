import ConfirmDialog from './ConfirmDialog';
import { useAppDispatch, useAppSelector } from '../store';
import {
  approvalDismissed,
  selectPendingApproval,
} from '../store/features/plugins/trustSlice';
import { apiClient, apiDispatchAction } from '../store/api/client';
import type { ListPluginTrustData } from '@ignite/api';

const PERMISSION_COPY: Record<'hostWrite' | 'net', string> = {
  hostWrite:
    'write files in your repository (compilation output, artifacts)',
  net: 'access the network (RPC endpoints, block explorers)',
};

export default function PermissionApprovalDialog() {
  const dispatch = useAppDispatch();
  const pending = useAppSelector(selectPendingApproval);

  if (!pending) return null;

  const { pluginId, permission, retry } = pending;

  const dismiss = () => dispatch(approvalDismissed());

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
              })
            );
          }
          actions.push(approvalDismissed());
          return actions;
        },
        onError: () => [approvalDismissed()],
      })
    );
  };

  const handleApprove = () => {
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
        onError: () => {
          // Fall back to granting just the requested permission.
          grantTrust({
            hostWrite: permission === 'hostWrite',
            net: permission === 'net',
          });
          return [];
        },
      })
    );
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      title={`Allow ${pluginId}?`}
      description={`The plugin ${pluginId} wants to ${PERMISSION_COPY[permission]}. Only approve plugins you trust — this permission persists until you revoke it.`}
      confirmText="Allow"
      variant="warning"
      onConfirm={handleApprove}
    />
  );
}
