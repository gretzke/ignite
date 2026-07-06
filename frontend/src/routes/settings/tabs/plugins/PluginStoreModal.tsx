import { useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, Package } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../../../store';
import {
  pluginsApi,
  selectPluginVersions,
  selectStorePlugins,
} from '../../../../store/features/plugins/pluginsSlice';

interface PluginStoreModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Hands off to the install modal prefilled with the entry's repo URL.
  onInstall: (repoUrl: string) => void;
}

// Curated plugin catalog. Entries carry their own display name/description;
// installing routes through the normal install modal (version dropdown,
// permission prompt) so the store adds no new trust surface.
export default function PluginStoreModal({
  open,
  onOpenChange,
  onInstall,
}: PluginStoreModalProps) {
  const dispatch = useAppDispatch();
  const store = useAppSelector(selectStorePlugins);
  const versions = useAppSelector(selectPluginVersions);

  useEffect(() => {
    if (open && store === null) {
      dispatch(pluginsApi.fetchStore());
    }
  }, [open, store, dispatch]);

  const installedRepoUrls = new Set(
    Object.values(versions)
      .map((info) => info.repoUrl)
      .filter(Boolean)
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-surface"
          style={{ maxWidth: 560, width: '90vw', padding: 24 }}
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
              <Package size={20} />
            </div>
            <Dialog.Title className="text-base font-semibold">
              Plugin Store
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm opacity-80 mb-4">
            Curated plugins for Ignite. Installing opens the regular install
            dialog where you can pick a version.
          </Dialog.Description>

          <div className="flex flex-col gap-3 mb-2">
            {store === null && (
              <div className="text-sm opacity-70">Loading…</div>
            )}
            {store?.length === 0 && (
              <div className="text-sm opacity-70">
                No curated plugins available yet.
              </div>
            )}
            {store?.map((entry) => {
              const installed = installedRepoUrls.has(entry.repoUrl);
              return (
                <div
                  key={entry.repoUrl}
                  className="card-milky p-4 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {entry.name}
                      </span>
                      {installed && (
                        <span className="text-xs rounded-full pill px-2 py-0.5 shrink-0">
                          Installed
                        </span>
                      )}
                    </div>
                    <div className="text-sm opacity-80 mt-1 break-words">
                      {entry.description}
                    </div>
                    <a
                      href={entry.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs opacity-60 hover:opacity-100 underline break-all"
                    >
                      {entry.repoUrl}
                    </a>
                  </div>
                  {!installed && (
                    <button
                      type="button"
                      className="btn btn-primary shrink-0 flex items-center gap-1"
                      onClick={() => {
                        onOpenChange(false);
                        onInstall(entry.repoUrl);
                      }}
                    >
                      <Download size={14} />
                      Install
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-end mt-3">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
