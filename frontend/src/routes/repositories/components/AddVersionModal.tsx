import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import type { AddRepoVersionRequest, InspectGitRemoteData } from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch } from '../../../store/hooks';
import Select from '../../../components/Select';

interface AddVersionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: {
    sourceKey: string;
    label: string;
    url?: string;
    repoPathOrUrl?: string;
    local: boolean;
  } | null;
  onSubmit: (request: AddRepoVersionRequest) => void;
  onSwitchBranch: (path: string, branch: string) => void;
}

export default function AddVersionModal({
  open,
  onOpenChange,
  source,
  onSubmit,
  onSwitchBranch,
}: AddVersionModalProps) {
  const dispatch = useAppDispatch();
  const [inspect, setInspect] = useState<InspectGitRemoteData | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [release, setRelease] = useState('');
  const [tag, setTag] = useState('');
  const [commit, setCommit] = useState('');
  const [mode, setMode] = useState<'copy' | 'switch'>('copy');

  useEffect(() => {
    if (!open || !source) return;
    setInspect(null);
    setInspectError('');
    setLocalBranches([]);
    setBranch('');
    setRelease('');
    setTag('');
    setCommit('');
    setMode('copy');

    if (source.local && source.repoPathOrUrl) {
      dispatch(
        apiClient.dispatch.getBranches({
          body: { pathOrUrl: source.repoPathOrUrl },
          onSuccess: ({ branches }) => {
            setLocalBranches(branches);
            setBranch(branches[0] ?? '');
          },
        })
      );
      return;
    }

    if (!source.url) return;
    setInspecting(true);
    dispatch(
      apiClient.dispatch.inspectGitRemote({
        body: { url: source.url },
        onSuccess: (data) => {
          setInspect(data);
          setInspecting(false);
          const stable = data.releases.find((item) => !item.prerelease);
          if (stable) setRelease(stable.tag);
          else setBranch(data.defaultBranch ?? data.branches[0] ?? '');
        },
        onError: (error) => {
          setInspecting(false);
          setInspectError(error.body.message);
        },
      })
    );
  }, [dispatch, open, source]);

  const commitValid = !commit.trim() || /^[0-9a-f]{7,40}$/i.test(commit.trim());
  const selectedRef = branch || release || tag;
  const canSubmit = Boolean(
    source && commitValid && (commit.trim() || selectedRef)
  );
  const canSwitch = source?.local && Boolean(branch) && !commit.trim();

  const handleSubmit = () => {
    if (!source || !canSubmit) return;
    if (source.local && mode === 'switch') {
      if (canSwitch && source.repoPathOrUrl)
        onSwitchBranch(source.repoPathOrUrl, branch);
      return;
    }
    const target = commit.trim()
      ? { commit: commit.trim() }
      : { ref: selectedRef, ...(release || tag ? { refKind: 'tag' as const } : { refKind: 'branch' as const }) };
    onSubmit(
      source.local
        ? { repoPathOrUrl: source.repoPathOrUrl!, ...target }
        : { url: source.url!, ...target }
    );
  };

  const releases = inspect?.releases ?? [];
  const tags = (inspect ? Object.keys(inspect.tagHeads ?? {}).filter((name) => !releases.some((release) => release.tag === name)).sort() : []);
  const branches = source?.local ? localBranches : (inspect?.branches ?? []);

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

          {!source?.local && releases.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">
                Release or tag
              </label>
              <Select
                options={releases.map((item, index) => ({
                  value: item.tag,
                  label: `${item.tag}${index === 0 && !item.prerelease ? ' (latest)' : ''}${item.prerelease ? ' (prerelease)' : ''}`,
                }))}
                value={release}
                onValueChange={(value) => {
                  setRelease(value);
                  setBranch('');
                  setTag('');
                }}
                anchor="left"
              />
            </div>
          )}

          <div className="mb-3">
            <label className="block text-sm font-medium mb-2">
              {source?.local ? 'Local branch' : 'Branch'}
            </label>
            <Select
              options={[
                ...(releases.length > 0 && !source?.local
                  ? [{ value: '', label: '— none (use release) —' }]
                  : []),
                ...branches.map((name) => ({ value: name, label: name })),
              ]}
              value={branch}
              onValueChange={(value) => {
                setBranch(value);
                if (value) setRelease('');
                if (value) setTag('');
              }}
              placeholder={source?.local ? 'Choose branch' : 'Choose branch'}
              anchor="left"
            />
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium mb-2">
              Commit hash
            </label>
            <input
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

          {!source?.local && tags.length > 0 && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-2">Tags</label>
              <Select options={[{ value: '', label: '— none —' }, ...tags.map((name) => ({ value: name, label: name }))]} value={tag} onValueChange={(value) => { setTag(value); if (value) { setRelease(''); setBranch(''); } }} anchor="left" />
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
              </div>
              {mode === 'switch' && !canSwitch && (
                <div className="text-xs text-warn mt-2">
                  Switching requires a local branch; use Make a copy for a
                  commit.
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
              {source?.local && mode === 'switch'
                ? 'Switch branch'
                : 'Add version'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
