import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpCircle, Loader2 } from 'lucide-react';
import type { InspectGitRemoteData, PluginVersionInfoData } from '@ignite/api';
import { useAppDispatch } from '../../../../store';
import { apiClient } from '../../../../store/api/client';
import { pluginsApi } from '../../../../store/features/plugins/pluginsSlice';

// Naive semver compare good enough for filtering changelog entries; parity
// with core's compareVersionStrings (which drives updateAvailable).
function versionGreaterThan(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(Number);
  const pb = b.replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

interface PluginUpdateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginName: string;
  info: PluginVersionInfoData | null;
}

// Update confirmation. Release-tracking installs show the release notes
// between the installed and latest version; branch-tracking installs show
// the commit change. Updates are always user-initiated — this is the
// explicit consent step.
export default function PluginUpdateModal({
  open,
  onOpenChange,
  pluginName,
  info,
}: PluginUpdateModalProps) {
  const dispatch = useAppDispatch();
  const [inspect, setInspect] = useState<InspectGitRemoteData | null>(null);
  const [loading, setLoading] = useState(false);

  const isRelease = info?.track === 'release';

  // Release updates: fetch the changelog when the modal opens.
  useEffect(() => {
    if (!open || !info?.repoUrl || !isRelease) {
      setInspect(null);
      return;
    }
    setLoading(true);
    dispatch(
      apiClient.dispatch.inspectGitRemote({
        body: { url: info.repoUrl },
        onSuccess: (data) => {
          setInspect(data);
          setLoading(false);
        },
        onError: () => {
          // Changelog is a nicety; the update itself still works.
          setLoading(false);
        },
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!info) return null;

  const changelog = (inspect?.releases ?? []).filter(
    (release) =>
      !release.prerelease &&
      info.currentVersion !== undefined &&
      versionGreaterThan(release.version, info.currentVersion)
  );

  const handleConfirm = () => {
    if (!info.repoUrl) return;
    if (isRelease && info.latestVersion) {
      // Prefer the exact tag name from the changelog (keeps the v prefix).
      const latestTag =
        changelog.find((r) => r.version === info.latestVersion)?.tag ??
        `v${info.latestVersion}`;
      dispatch(
        pluginsApi.update(info.pluginId, {
          url: info.repoUrl,
          ref: latestTag,
          track: { mode: 'release', version: latestTag },
        })
      );
    } else if (info.track === 'branch' && info.trackRef) {
      dispatch(
        pluginsApi.update(info.pluginId, {
          url: info.repoUrl,
          ref: info.trackRef,
          track: { mode: 'branch', branch: info.trackRef },
        })
      );
    }
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
          style={{ maxWidth: 560, width: '90vw', padding: 24 }}
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className="size-10 rounded-full flex items-center justify-center shrink-0"
              style={{
                background:
                  'color-mix(in oklch, var(--profile-color) 22%, transparent)',
                color: 'color-mix(in oklch, var(--profile-color) 55%, var(--text))',
              }}
            >
              <ArrowUpCircle size={20} />
            </div>
            <Dialog.Title className="text-base font-semibold">
              Update {pluginName}
            </Dialog.Title>
          </div>

          {isRelease ? (
            <>
              <Dialog.Description className="text-sm opacity-80 mb-4">
                {info.currentVersion} → {info.latestVersion}. Review what
                changed before updating. Existing permission grants carry
                over; newly requested permissions will be shown after the
                update and start disabled.
              </Dialog.Description>
              {loading && (
                <div className="flex items-center gap-2 text-sm opacity-70 mb-4">
                  <Loader2 size={14} className="animate-spin" />
                  Loading changelog…
                </div>
              )}
              {!loading && changelog.length > 0 && (
                <div
                  className="flex flex-col gap-3 mb-4 overflow-y-auto"
                  style={{ maxHeight: 320 }}
                >
                  {changelog.map((release) => (
                    // Shadow off: the scroll container clips card-milky's
                    // large drop shadow at its edges, which reads as a
                    // rendering glitch.
                    <div
                      key={release.tag}
                      className="card-milky p-3"
                      style={{ boxShadow: 'none' }}
                    >
                      <div className="text-sm font-semibold">
                        {release.name ?? release.tag}
                      </div>
                      {release.publishedAt && (
                        <div className="text-xs opacity-60 mb-1">
                          {new Date(release.publishedAt).toLocaleDateString()}
                        </div>
                      )}
                      {/* Third-party release notes: plain text, never HTML */}
                      <div className="text-xs opacity-80 whitespace-pre-wrap break-words">
                        {release.notes ?? 'No release notes.'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!loading && changelog.length === 0 && (
                <div className="text-sm opacity-70 mb-4">
                  No release notes available.
                </div>
              )}
            </>
          ) : (
            <Dialog.Description className="text-sm opacity-80 mb-4">
              The tracked branch &quot;{info.trackRef}&quot; has new commits.
              <span className="block font-mono text-xs mt-2">
                {(info.currentCommit ?? 'unknown').slice(0, 12)} →{' '}
                {(info.latestCommit ?? 'unknown').slice(0, 12)}
              </span>
              <span className="block mt-2">
                Existing permission grants carry over; newly requested
                permissions will be shown after the update and start disabled.
              </span>
            </Dialog.Description>
          )}

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirm}
            >
              Update
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
