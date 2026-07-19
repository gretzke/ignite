import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import type { AddRepoVersionRequest, InspectGitRemoteData } from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch } from '../../../store/hooks';
import Select from '../../../components/Select';

export interface VersionSource {
  sourceKey: string;
  label: string;
  /** Remote origin used for releases, tags, and remote branches. */
  url?: string;
  repoPathOrUrl?: string;
  local: boolean;
  initialBranch?: string;
  initialCommit?: string;
}

interface AddVersionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: VersionSource | null;
  onSubmit: (request: AddRepoVersionRequest) => void;
  onSwitchBranch: (path: string, branch: string) => void;
}

export function versionPickerSections(
  source: VersionSource | null,
  inspect: InspectGitRemoteData | null,
  localBranches: string[]
) {
  const releases = source?.url ? (inspect?.releases ?? []) : [];
  const tags = source?.url
    ? Object.keys(inspect?.tagHeads ?? {})
        .filter((name) => !releases.some((item) => item.tag === name))
        .sort()
    : [];
  return {
    releases,
    tags,
    remoteBranches: source?.url ? (inspect?.branches ?? []) : [],
    localBranches: source?.local ? localBranches : [],
  };
}

export function canSwitchLocalBranch({
  local,
  localBranch,
  remoteRefSelected,
  commit,
}: {
  local: boolean | undefined;
  localBranch: string;
  remoteRefSelected: boolean;
  commit: string;
}) {
  return local && Boolean(localBranch) && !remoteRefSelected && !commit.trim();
}

export default function AddVersionModal({
  open,
  onOpenChange,
  source,
  onSubmit,
  onSwitchBranch,
}: AddVersionModalProps) {
  const dispatch = useAppDispatch();
  const commitInput = useRef<HTMLInputElement>(null);
  const [inspect, setInspect] = useState<InspectGitRemoteData | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [localBranch, setLocalBranch] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [release, setRelease] = useState('');
  const [tag, setTag] = useState('');
  const [commit, setCommit] = useState('');
  const [mode, setMode] = useState<'copy' | 'switch'>('copy');

  useEffect(() => {
    if (!open || !source) return;
    setInspect(null);
    setInspectError('');
    setInspecting(Boolean(source.url));
    setLocalBranches([]);
    setLocalBranch(source.local ? (source.initialBranch ?? '') : '');
    setRemoteBranch(source.local ? '' : (source.initialBranch ?? ''));
    setRelease('');
    setTag('');
    setCommit(source.initialCommit ?? '');
    setMode('copy');

    if (source.local && source.repoPathOrUrl) {
      dispatch(
        apiClient.dispatch.getBranches({
          body: { pathOrUrl: source.repoPathOrUrl },
          onSuccess: ({ branches }) => {
            setLocalBranches(branches);
            if (!source.initialBranch && !source.url)
              setLocalBranch(branches[0] ?? '');
          },
        })
      );
    }

    if (!source.url) return;
    dispatch(
      apiClient.dispatch.inspectGitRemote({
        body: { url: source.url },
        onSuccess: (data) => {
          setInspect(data);
          setInspecting(false);
          // A branch click intentionally keeps its local selection. Otherwise
          // releases are the first, most useful remote choice.
          if (!source.initialBranch && !source.initialCommit) {
            const stable = data.releases.find((item) => !item.prerelease);
            if (stable) setRelease(stable.tag);
            else setRemoteBranch(data.defaultBranch ?? data.branches[0] ?? '');
          }
        },
        onError: (error) => {
          setInspecting(false);
          setInspectError(error.body.message);
        },
      })
    );
  }, [dispatch, open, source]);

  useEffect(() => {
    if (open && source?.initialCommit) commitInput.current?.focus();
  }, [open, source?.initialCommit]);

  const clearRefsExcept = (
    selected: 'release' | 'tag' | 'remoteBranch' | 'localBranch'
  ) => {
    if (selected !== 'release') setRelease('');
    if (selected !== 'tag') setTag('');
    if (selected !== 'remoteBranch') setRemoteBranch('');
    if (selected !== 'localBranch') setLocalBranch('');
  };

  const commitValid = !commit.trim() || /^[0-9a-f]{7,40}$/i.test(commit.trim());
  const selectedRef = release || tag || remoteBranch || localBranch;
  const remoteRefSelected = Boolean(release || tag || remoteBranch);
  const canSubmit = Boolean(
    source && commitValid && (commit.trim() || selectedRef)
  );
  const canSwitch = canSwitchLocalBranch({
    local: source?.local,
    localBranch,
    remoteRefSelected,
    commit,
  });

  const handleSubmit = () => {
    if (!source || !canSubmit) return;
    if (mode === 'switch' && canSwitch && source.repoPathOrUrl) {
      onSwitchBranch(source.repoPathOrUrl, localBranch);
      return;
    }

    const target = commit.trim()
      ? { commit: commit.trim() }
      : {
          ref: selectedRef,
          refKind: (release || tag ? 'tag' : 'branch') as 'tag' | 'branch',
        };
    // Local branches and commits resolve against the local worktree. Remote
    // release/tag/branch choices resolve from the canonical origin instead.
    onSubmit(
      source.local && !remoteRefSelected
        ? { repoPathOrUrl: source.repoPathOrUrl!, ...target }
        : { url: source.url!, ...target }
    );
  };

  const { releases, tags, remoteBranches } = versionPickerSections(
    source,
    inspect,
    localBranches
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content glass-overlay max-w-xl w-[90vw] p-4">
          <Dialog.Title className="text-base font-semibold mb-2">
            Add repository version
          </Dialog.Title>
          <Dialog.Description className="text-sm opacity-80 mb-4">
            {source?.label}
          </Dialog.Description>

          {inspecting && (
            <div className="flex items-center gap-2 text-sm opacity-70 mb-3">
              <Loader2 size={14} className="animate-spin" /> Checking
              repository…
            </div>
          )}
          {inspectError && (
            <div className="text-xs text-err mb-3">{inspectError}</div>
          )}

          {releases.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">Releases</label>
              <Select
                options={releases.map((item, index) => ({
                  value: item.tag,
                  label: `${item.tag}${index === 0 && !item.prerelease ? ' (latest)' : ''}${item.prerelease ? ' (prerelease)' : ''}`,
                }))}
                value={release}
                onValueChange={(value) => {
                  setRelease(value);
                  clearRefsExcept('release');
                  setMode('copy');
                }}
                anchor="left"
              />
            </div>
          )}

          {tags.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">Tags</label>
              <Select
                options={[
                  { value: '', label: '— none —' },
                  ...tags.map((name) => ({ value: name, label: name })),
                ]}
                value={tag}
                onValueChange={(value) => {
                  setTag(value);
                  if (value) {
                    clearRefsExcept('tag');
                    setMode('copy');
                  }
                }}
                anchor="left"
              />
            </div>
          )}

          {remoteBranches.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">
                Remote branch
              </label>
              <Select
                options={[
                  { value: '', label: '— none —' },
                  ...remoteBranches.map((name) => ({
                    value: name,
                    label: name,
                  })),
                ]}
                value={remoteBranch}
                onValueChange={(value) => {
                  setRemoteBranch(value);
                  if (value) {
                    clearRefsExcept('remoteBranch');
                    setMode('copy');
                  }
                }}
                anchor="left"
              />
            </div>
          )}

          {source?.local && localBranches.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">
                Local branch
              </label>
              <Select
                options={localBranches.map((name) => ({
                  value: name,
                  label: name,
                }))}
                value={localBranch}
                onValueChange={(value) => {
                  setLocalBranch(value);
                  clearRefsExcept('localBranch');
                }}
                placeholder="Choose local branch"
                anchor="left"
              />
            </div>
          )}

          <div className="mb-3">
            <label className="block text-sm font-medium mb-2">
              Commit hash
            </label>
            <input
              ref={commitInput}
              type="text"
              placeholder="Optional full or short commit hash"
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              className="input-glass font-mono text-xs"
              spellCheck={false}
            />
            {!commitValid && (
              <div className="text-xs text-err mt-1">
                Enter 7–40 hexadecimal characters.
              </div>
            )}
          </div>

          {source?.local && (
            <fieldset className="mb-4">
              <legend className="block text-sm font-medium mb-2">
                For this local repository
              </legend>
              <div className="flex gap-3">
                <label className="card-milky p-3 flex-1 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="local-version-mode"
                    checked={mode === 'copy'}
                    onChange={() => setMode('copy')}
                    className="mr-2"
                  />
                  Make a copy
                  <span className="block text-xs opacity-70 mt-1">
                    Keep the current workspace unchanged.
                  </span>
                </label>
                {canSwitch && (
                  <label className="card-milky p-3 flex-1 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="local-version-mode"
                      checked={mode === 'switch'}
                      onChange={() => setMode('switch')}
                      className="mr-2"
                    />
                    Switch branch
                    <span className="block text-xs opacity-70 mt-1">
                      Changes the local workspace after confirmation.
                    </span>
                  </label>
                )}
              </div>
              {!canSwitch && (
                <div className="text-xs text-warn mt-2">
                  Remote refs and commits can only be copied.
                </div>
              )}
            </fieldset>
          )}

          <div className="flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={!canSubmit || (mode === 'switch' && !canSwitch)}
            >
              {mode === 'switch' && canSwitch ? 'Switch branch' : 'Add version'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
