import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { InspectGitRemoteData } from '@ignite/api';
import { useAppDispatch } from '../../../../store';
import { apiClient } from '../../../../store/api/client';
import {
  pluginsApi,
  type GitInstallTarget,
} from '../../../../store/features/plugins/pluginsSlice';
import { DirectoryPicker } from '../../../../components/DirectoryPicker';
import Select from '../../../../components/Select';

const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const isValidAbsolutePath = (path: string): boolean => {
  const trimmedPath = path.trim();
  return (
    trimmedPath.startsWith('/') || // Unix/macOS absolute path
    /^[A-Za-z]:[\\]/.test(trimmedPath) // Windows absolute path (C:\, D:\, etc.)
  );
};

// Reopened-from-card mode: the URL is fixed to the plugin's install source
// and submitting dispatches an update (same-repo rebuild at the chosen ref)
// instead of a fresh install.
export interface ManageTarget {
  pluginId: string;
  name: string;
  url: string;
  currentRef?: string;
}

interface GitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manage?: ManageTarget | null;
  prefillUrl?: string;
}

export function InstallFromGitModal({
  open,
  onOpenChange,
  manage,
  prefillUrl,
}: GitModalProps) {
  const dispatch = useAppDispatch();
  const [url, setUrl] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspect, setInspect] = useState<InspectGitRemoteData | null>(null);
  const [inspectError, setInspectError] = useState('');
  const [version, setVersion] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [branch, setBranch] = useState('');
  const [commit, setCommit] = useState('');
  const lastInspectedRef = useRef<string | null>(null);

  const effectiveUrl = manage ? manage.url : url;

  // Seed state when the modal opens.
  useEffect(() => {
    if (!open) return;
    setUrl(manage ? manage.url : (prefillUrl ?? ''));
    setInspect(null);
    setInspectError('');
    setVersion('');
    setAdvancedOpen(false);
    setBranch('');
    setCommit('');
    lastInspectedRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Inspect the remote (debounced for typing; immediate for fixed URLs).
  useEffect(() => {
    if (!open) return;
    const target = effectiveUrl.trim();
    if (!target || !isValidUrl(target)) {
      setInspect(null);
      return;
    }
    if (lastInspectedRef.current === target) return;
    const timer = setTimeout(
      () => {
        lastInspectedRef.current = target;
        setInspecting(true);
        setInspectError('');
        dispatch(
          apiClient.dispatch.inspectGitRemote({
            body: { url: target },
            onSuccess: (data) => {
              if (lastInspectedRef.current !== target) return;
              setInspect(data);
              setInspecting(false);
              // Default to the newest stable release; prefer the installed
              // ref in manage mode so "Apply" is a no-op by default.
              const stable = data.releases.filter((r) => !r.prerelease);
              if (
                manage?.currentRef &&
                data.releases.some((r) => r.tag === manage.currentRef)
              ) {
                setVersion(manage.currentRef);
              } else if (stable.length > 0) {
                setVersion(stable[0].tag);
              } else if (data.defaultBranch) {
                // No releases: the default branch is what will be installed.
                setBranch(data.defaultBranch);
              }
            },
            onError: (error) => {
              if (lastInspectedRef.current !== target) return;
              setInspecting(false);
              setInspectError(error.body.message);
            },
          })
        );
      },
      manage ? 0 : 500
    );
    return () => clearTimeout(timer);
  }, [open, effectiveUrl, dispatch, manage]);

  const releases = inspect?.releases ?? [];
  const branches = inspect?.branches ?? [];
  const defaultBranch = inspect?.defaultBranch ?? 'main';

  // Precedence: pinned commit > explicitly chosen branch > release > default
  // branch head.
  const resolveTarget = (): GitInstallTarget | null => {
    const targetUrl = effectiveUrl.trim();
    if (!targetUrl || !isValidUrl(targetUrl)) return null;
    const pinned = commit.trim();
    if (pinned) {
      return { url: targetUrl, ref: pinned, track: { mode: 'commit' } };
    }
    if (branch) {
      return {
        url: targetUrl,
        ref: branch,
        track: { mode: 'branch', branch },
      };
    }
    if (releases.length > 0 && version) {
      return {
        url: targetUrl,
        ref: version,
        track: { mode: 'release', version },
      };
    }
    return {
      url: targetUrl,
      track: { mode: 'branch', branch: defaultBranch },
    };
  };

  const target = resolveTarget();
  const canSubmit =
    target !== null &&
    (!commit.trim() || /^[0-9a-f]{7,40}$/i.test(commit.trim()));

  const handleSubmit = () => {
    if (!target || !canSubmit) return;
    if (manage) {
      dispatch(pluginsApi.update(manage.pluginId, target));
    } else {
      dispatch(pluginsApi.installGit(target));
    }
    onOpenChange(false);
  };

  const summary = (() => {
    if (commit.trim()) return `Pinned to commit ${commit.trim().slice(0, 12)}`;
    if (branch) return `Installs the latest commit on "${branch}"`;
    if (releases.length > 0 && version) return `Installs release ${version}`;
    if (inspect)
      return `No releases found — installs the latest commit on "${defaultBranch}"`;
    return '';
  })();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 520, width: '90vw', padding: 16 }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            {manage ? `Manage ${manage.name}` : 'Install Plugin from GitHub'}
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            {manage
              ? 'Switch to a different release, branch, or commit of this plugin. Granted permissions carry over — this rebuilds from the same repository.'
              : 'Enter the URL of the plugin repository. The plugin is built in an isolated environment before it is installed.'}
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium mb-2">
              Repository URL
            </label>
            <input
              type="url"
              placeholder="https://github.com/username/plugin"
              value={effectiveUrl}
              onChange={(e) => setUrl(e.target.value)}
              className="input-glass"
              disabled={!!manage}
              autoFocus={!manage}
            />
            {inspectError && (
              <div className="text-xs text-err mt-1">{inspectError}</div>
            )}
            {inspect?.github?.description && (
              <div className="text-xs opacity-70 mt-1 break-words">
                {inspect.github.description}
              </div>
            )}
          </div>

          {inspecting && (
            <div className="flex items-center gap-2 text-sm opacity-70 mb-3">
              <Loader2 size={14} className="animate-spin" />
              Checking repository…
            </div>
          )}

          {inspect && releases.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">Version</label>
              <Select
                options={releases.map((release, index) => ({
                  value: release.tag,
                  label:
                    release.tag +
                    (index === 0 && !release.prerelease ? ' (latest)' : '') +
                    (release.prerelease ? ' (prerelease)' : '') +
                    (manage?.currentRef === release.tag ? ' (installed)' : ''),
                }))}
                value={version}
                onValueChange={setVersion}
                anchor="left"
              />
            </div>
          )}

          {inspect && (
            <div className="mb-3">
              <button
                type="button"
                className="flex items-center gap-1 text-sm opacity-70 hover:opacity-100 bg-transparent border-0 p-0 cursor-pointer text-[var(--text)]"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
                Advanced
              </button>
              {advancedOpen && (
                <div className="card-milky p-3 mt-2 flex flex-col gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Branch
                    </label>
                    <Select
                      options={[
                        ...(releases.length > 0
                          ? [{ value: '', label: '— none (use version) —' }]
                          : []),
                        ...branches.map((name) => ({
                          value: name,
                          label:
                            name +
                            (name === inspect.defaultBranch
                              ? ' (default)'
                              : ''),
                        })),
                      ]}
                      value={branch}
                      onValueChange={setBranch}
                      anchor="left"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Commit hash
                    </label>
                    <input
                      type="text"
                      placeholder="commit sha"
                      value={commit}
                      onChange={(e) => setCommit(e.target.value)}
                      className="input-glass font-mono text-xs"
                      spellCheck={false}
                    />
                    <div className="text-xs opacity-60 mt-1">
                      A pinned commit never prompts for updates — click the
                      plugin card to switch back to a release or branch later.
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {summary && <div className="text-xs opacity-70 mb-4">{summary}</div>}

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {manage ? 'Apply' : 'Install'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface InstallModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InstallFromPathModal({
  open,
  onOpenChange,
}: InstallModalProps) {
  const dispatch = useAppDispatch();
  const [path, setPath] = useState('');

  const canSubmit = path.trim() !== '' && isValidAbsolutePath(path.trim());

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
    if (!isOpen) setPath('');
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    dispatch(pluginsApi.install(path.trim()));
    handleOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 720, width: '90vw', padding: 16 }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            Install Plugin from Local Path
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            Select the plugin directory to build and install. This option is
            only available in development mode.
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Plugin Path
            </label>
            <DirectoryPicker
              value={path}
              onChange={setPath}
              onSubmit={handleSubmit}
              autoFocus
            />
          </div>

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              Install
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
