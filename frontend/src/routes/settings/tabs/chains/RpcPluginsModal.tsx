// frontend/src/routes/settings/tabs/chains/RpcPluginsModal.tsx
// Lightweight shortcut: lists installed rpc-provider plugins so a user can
// jump straight to configuring one (e.g. an Infura/Alchemy API key) without
// hunting through the Plugins tab. Configure routes into the global
// PluginConfigModal (mounted in App.tsx).
import { useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router-dom';
import { Plug, Settings2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../../../store';
import {
  openConfigModal,
  pluginsApi,
  selectPluginRows,
} from '../../../../store/features/plugins/pluginsSlice';

interface RpcPluginsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TRUST_LABEL: Record<string, string> = {
  native: 'built-in',
  trusted: 'trusted',
  untrusted: 'untrusted',
};

export default function RpcPluginsModal({
  open,
  onOpenChange,
}: RpcPluginsModalProps) {
  const dispatch = useAppDispatch();
  const rows = useAppSelector(selectPluginRows);
  const rpcPlugins = rows
    .filter((p) => p.type === 'rpc-provider')
    .sort((a, b) => (a.name ?? a.pluginId).localeCompare(b.name ?? b.pluginId));

  // Refresh on open so trust/config-field metadata reflects any recent
  // install/uninstall rather than a stale cache from a prior tab visit.
  useEffect(() => {
    if (open) pluginsApi.refresh().forEach((a) => dispatch(a));
  }, [open, dispatch]);

  const configure = (pluginId: string) => {
    dispatch(openConfigModal({ pluginId }));
    // Close this shortcut modal: it and the global PluginConfigModal don't
    // compose as stacked dialogs, so hand off cleanly instead of stacking.
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 480, width: '90vw', padding: 20 }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div
              className="icon-tile"
              style={{
                background:
                  'color-mix(in oklch, var(--accent) 12%, transparent)',
                borderColor:
                  'color-mix(in oklch, var(--accent) 25%, transparent)',
              }}
            >
              <Plug size={16} />
            </div>
            <Dialog.Title className="text-base font-semibold">
              RPC provider plugins
            </Dialog.Title>
          </div>

          <div className="glass-list mb-3">
            {rpcPlugins.length === 0 ? (
              <div className="list-row text-muted">
                No RPC provider plugins installed. Install one from the{' '}
                <Link to="/settings#plugins" onClick={() => onOpenChange(false)}>
                  Plugins tab
                </Link>
                .
              </div>
            ) : (
              rpcPlugins.map((plugin) => (
                <div key={plugin.pluginId} className="list-row">
                  <div className="flex items-center justify-between gap-2 w-full min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">
                        {plugin.name ?? plugin.pluginId}
                      </span>
                      <span className="pill">
                        {TRUST_LABEL[plugin.trust] ?? plugin.trust}
                      </span>
                    </div>
                    <button
                      className="btn btn-sm btn-secondary shrink-0"
                      onClick={() => configure(plugin.pluginId)}
                    >
                      <Settings2 size={14} />
                      Configure
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-end">
            <Dialog.Close asChild>
              <button className="btn btn-secondary">Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
