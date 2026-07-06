import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldCheck } from 'lucide-react';
import Switch from './Switch';
import { useAppDispatch, useAppSelector } from '../store';
import {
  closePermissionsModal,
  pluginsApi,
  selectPermissionsModal,
  selectPluginRow,
} from '../store/features/plugins/pluginsSlice';
import type { RootState } from '../store/store';

const PERMISSION_TITLES: Record<string, string> = {
  hostWrite: 'Host Write',
  net: 'Network',
};

type Pending = { hostWrite: boolean; net: boolean };

// Global permission-grant modal. Opened from a plugin card's Permissions
// button, automatically after installing a plugin that requests permissions,
// and after an update that requests NEW permissions (highlighted). Only
// manifest-requested permissions are shown — nothing else is grantable.
export default function PluginPermissionsModal() {
  const dispatch = useAppDispatch();
  const modal = useAppSelector(selectPermissionsModal);
  const row = useAppSelector((s: RootState) =>
    modal ? selectPluginRow(s, modal.pluginId) : undefined
  );
  const [pending, setPending] = useState<Pending>({
    hostWrite: false,
    net: false,
  });

  // Re-seed the toggles from the stored grant whenever the modal targets a
  // (possibly different) plugin or its trust state arrives from the server.
  const grantKey = modal
    ? `${modal.pluginId}:${row?.permissions.hostWrite}:${row?.permissions.net}`
    : '';
  useEffect(() => {
    if (!modal) return;
    setPending({
      hostWrite: row?.permissions.hostWrite ?? false,
      net: row?.permissions.net ?? false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantKey]);

  if (!modal) return null;

  const requested = row?.requested ?? [];
  const name = row?.name ?? modal.pluginId;
  const allOn = requested.every((r) => pending[r.id]);

  const close = () => dispatch(closePermissionsModal());

  const handleSave = () => {
    // Clamp to the requested set so a stale toggle can never grant something
    // the manifest doesn't declare.
    const next: Pending = {
      hostWrite:
        pending.hostWrite && requested.some((r) => r.id === 'hostWrite'),
      net: pending.net && requested.some((r) => r.id === 'net'),
    };
    dispatch(
      pluginsApi.setPermissions(
        modal.pluginId,
        next.hostWrite || next.net ? 'trusted' : 'untrusted',
        next
      )
    );
    close();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 520, width: '90vw', padding: 24 }}
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className="size-10 rounded-full flex items-center justify-center shrink-0"
              style={{
                background:
                  'color-mix(in oklch, var(--profile-color) 12%, transparent)',
                color: 'var(--profile-color)',
              }}
            >
              <ShieldCheck size={20} />
            </div>
            <Dialog.Title className="text-base font-semibold">
              {name} Permissions
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm opacity-80 mb-4">
            {requested.length > 0
              ? 'This plugin requests the following permissions. They are off by default and can be changed here at any time.'
              : 'This plugin does not request any permissions. It can read the repository and produce artifacts, but cannot write to your machine or access the network.'}
          </Dialog.Description>

          {requested.length > 0 && (
            <div className="flex flex-col gap-3 mb-5">
              {requested.map((request) => (
                <div
                  key={request.id}
                  className="card-milky p-3 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {PERMISSION_TITLES[request.id] ?? request.id}
                      </span>
                      {modal.newPermissionIds.includes(request.id) && (
                        <span className="text-xs rounded-full pill pill-primary px-2 py-0.5 shrink-0">
                          New
                        </span>
                      )}
                    </div>
                    {/* Plugin-authored text: rendered strictly as plain text */}
                    <div className="text-sm opacity-80 mt-1 break-words">
                      {request.description}
                    </div>
                  </div>
                  <div className="shrink-0 pt-1">
                    <Switch
                      checked={pending[request.id]}
                      onCheckedChange={(v) =>
                        setPending((p) => ({ ...p, [request.id]: v }))
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 mt-2">
            <div>
              {requested.length > 1 && !allOn && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setPending((p) => ({
                      ...p,
                      ...Object.fromEntries(requested.map((r) => [r.id, true])),
                    }))
                  }
                >
                  Allow All
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary">
                  Cancel
                </button>
              </Dialog.Close>
              {requested.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSave}
                >
                  Save
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
