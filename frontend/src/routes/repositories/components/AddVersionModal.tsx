import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { Loader2 } from 'lucide-react';
import type { AddRepoVersionRequest, InspectGitRemoteData } from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch } from '../../../store/hooks';
import Select from '../../../components/Select';

export interface VersionSource {
  sourceKey: string;
  label: string;
  /** Remote origin used for releases, tags, and remote branches. */
  url?: string;
  /** Present for every source with a live workspace, including clones. */
  repoPathOrUrl?: string;
  /** A local source can resolve refs that have not been pushed to origin. */
  local: boolean;
  initialBranch?: string;
  initialCommit?: string;
  existingVersions?: Array<{ commit: string; refLabel?: string }>;
}

type VersionTab = 'releases' | 'branches' | 'commit';

export type VersionSelection = { tab: VersionTab; value: string };
export type WorkspaceSwitchTarget =
  { kind: 'branch'; branch: string } | { kind: 'commit'; commit: string };

type AddVersionModalProps =
  | {
      variant: 'add';
      open: boolean;
      onOpenChange: (open: boolean) => void;
      source: VersionSource | null;
      onSubmit: (request: AddRepoVersionRequest) => void;
      onSwitchWorkspace: (
        path: string,
        target: WorkspaceSwitchTarget
      ) => Promise<void>;
    }
  | {
      variant: 'pick';
      open: boolean;
      onOpenChange: (open: boolean) => void;
      source: VersionSource | null;
      onPick: (pick: {
        url: string;
        commit: string;
        ref?: string;
        refKind?: 'tag' | 'branch';
      }) => void;
    };

type AddVersionModalAddProps = Extract<
  AddVersionModalProps,
  { variant: 'add' }
>;

export function versionPickerSections(
  source: VersionSource | null,
  inspect: InspectGitRemoteData | null,
  workspaceBranches: string[]
) {
  const releases = source?.url ? (inspect?.releases ?? []) : [];
  const tags = source?.url
    ? Object.keys(inspect?.tagHeads ?? {})
        .filter((name) => !releases.some((item) => item.tag === name))
        .sort()
    : [];
  const branches = [
    ...new Set([
      ...(source?.url ? (inspect?.branches ?? []) : []),
      ...(source?.repoPathOrUrl ? workspaceBranches : []),
    ]),
  ];
  return { releases, tags, branches };
}

export function canSwitchWorkspaceVersion({
  hasWorkspace,
  target,
}: {
  hasWorkspace: boolean;
  target: WorkspaceSwitchTarget | null;
}) {
  return hasWorkspace && target !== null;
}

export function shouldShowVersionMode(hasWorkspace: boolean) {
  return hasWorkspace;
}

export function versionSwitchTarget(
  selection: VersionSelection,
  inspect: InspectGitRemoteData | null
): WorkspaceSwitchTarget | null {
  const value = selection.value.trim();
  if (!value) return null;
  if (selection.tab === 'branches') return { kind: 'branch', branch: value };
  if (selection.tab === 'commit') return { kind: 'commit', commit: value };

  const release = inspect?.releases.find((item) => item.tag === value);
  const commit = release?.sha ?? inspect?.tagHeads?.[value];
  return commit ? { kind: 'commit', commit } : null;
}

export function versionSubmitPayload(
  source: VersionSource,
  selection: VersionSelection
): AddRepoVersionRequest {
  const target =
    selection.tab === 'commit'
      ? { commit: selection.value.trim() }
      : {
          ref: selection.value,
          refKind:
            selection.tab === 'releases'
              ? ('tag' as const)
              : ('branch' as const),
        };

  // A live workspace retains Git's verbatim remote URL, including a required
  // trailing .git. Only orphaned cache groups must submit canonical identity.
  return source.repoPathOrUrl && !(source.local && selection.tab === 'releases')
    ? { repoPathOrUrl: source.repoPathOrUrl, ...target }
    : { url: source.url!, ...target };
}

export function versionPickPayload(
  source: VersionSource,
  selection: VersionSelection,
  inspect: InspectGitRemoteData | null
): {
  url: string;
  commit: string;
  ref?: string;
  refKind?: 'tag' | 'branch';
} | null {
  if (!source.url) return null;
  const value = selection.value.trim();
  if (selection.tab === 'commit')
    return /^[0-9a-f]{40}$/i.test(value)
      ? { url: source.url, commit: value }
      : null;
  const commit =
    selection.tab === 'releases'
      ? (inspect?.releases.find((release) => release.tag === value)?.sha ??
        inspect?.tagHeads?.[value])
      : inspect?.branchHeads?.[value];
  return commit && /^[0-9a-f]{40}$/i.test(commit)
    ? {
        url: source.url,
        commit,
        ref: value,
        refKind: selection.tab === 'releases' ? 'tag' : 'branch',
      }
    : null;
}

export function existingVersionHint(
  source: VersionSource | null,
  selection: VersionSelection,
  inspect: InspectGitRemoteData | null,
  mode: 'copy' | 'switch'
): string | null {
  const value = selection.value.trim();
  if (!source || !value || !source.existingVersions?.length) return null;
  const matches =
    selection.tab === 'commit'
      ? source.existingVersions.some((version) =>
          version.commit.toLowerCase().startsWith(value.toLowerCase())
        )
      : source.existingVersions.some((version) => {
          if (version.refLabel === value) return true;
          if (selection.tab !== 'releases') return false;
          const commit =
            inspect?.releases.find((release) => release.tag === value)?.sha ??
            inspect?.tagHeads?.[value];
          return Boolean(commit && version.commit === commit);
        });
  if (!matches) return null;
  return mode === 'switch'
    ? 'This ref is already available as a pinned version. Switching changes your live checkout instead.'
    : "Already added to this repository's versions.";
}

function switchErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'body' in error &&
    typeof error.body === 'object' &&
    error.body !== null &&
    'message' in error.body &&
    typeof error.body.message === 'string'
  ) {
    return error.body.message;
  }
  return error instanceof Error ? error.message : 'Unable to switch branch';
}

export default function AddVersionModal(props: AddVersionModalProps) {
  const { variant, open, onOpenChange, source } = props;
  const dispatch = useAppDispatch();
  const commitInput = useRef<HTMLInputElement>(null);
  const inspectGeneration = useRef(0);
  const [inspect, setInspect] = useState<InspectGitRemoteData | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [switchError, setSwitchError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [workspaceBranches, setWorkspaceBranches] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<VersionTab>('branches');
  const [selection, setSelection] = useState<VersionSelection>({
    tab: 'branches',
    value: '',
  });
  const [mode, setMode] = useState<'copy' | 'switch'>('copy');

  useEffect(() => {
    const generation = ++inspectGeneration.current;
    if (!open || !source) return;
    const initialTab: VersionTab = source.initialCommit ? 'commit' : 'branches';
    const initialValue = source.initialCommit ?? source.initialBranch ?? '';
    setInspect(null);
    setInspectError('');
    setSwitchError('');
    setSwitching(false);
    setInspecting(Boolean(source.url));
    setWorkspaceBranches([]);
    setActiveTab(initialTab);
    setSelection({ tab: initialTab, value: initialValue });
    setMode('copy');

    if (variant === 'add' && source.repoPathOrUrl) {
      dispatch(
        apiClient.dispatch.getBranches({
          body: { pathOrUrl: source.repoPathOrUrl },
          onSuccess: ({ branches }) => {
            if (generation !== inspectGeneration.current) return;
            setWorkspaceBranches(branches);
            if (!source.initialBranch && !source.initialCommit && !source.url) {
              setSelection((current) =>
                current.tab === 'branches' && !current.value
                  ? { tab: 'branches', value: branches[0] ?? '' }
                  : current
              );
            }
          },
        })
      );
    }

    if (!source.url) return;
    dispatch(
      apiClient.dispatch.inspectGitRemote({
        body: { url: source.url },
        onSuccess: (data) => {
          if (generation !== inspectGeneration.current) return;
          setInspect(data);
          setInspecting(false);
          if (!source.initialBranch && !source.initialCommit) {
            const release = data.releases.find((item) => !item.prerelease);
            const tag = Object.keys(data.tagHeads ?? {})
              .filter(
                (name) => !data.releases.some((item) => item.tag === name)
              )
              .sort()[0];
            if (release || tag) {
              setActiveTab('releases');
              setSelection({
                tab: 'releases',
                value: release?.tag ?? tag ?? '',
              });
            } else {
              setActiveTab('branches');
              setSelection({
                tab: 'branches',
                value: data.defaultBranch ?? data.branches[0] ?? '',
              });
            }
          }
        },
        onError: (error) => {
          if (generation !== inspectGeneration.current) return;
          setInspecting(false);
          setInspectError(error.body.message);
        },
      })
    );
    return () => {
      inspectGeneration.current += 1;
    };
  }, [dispatch, open, source, variant]);

  useEffect(() => {
    if (open && source?.initialCommit) commitInput.current?.focus();
  }, [open, source?.initialCommit]);

  const { releases, tags, branches } = versionPickerSections(
    source,
    inspect,
    workspaceBranches
  );
  const showReleasesTab = Boolean(source?.url);
  const hasWorkspace = Boolean(source?.repoPathOrUrl);
  const commitValid =
    activeTab !== 'commit' ||
    (variant === 'pick'
      ? /^[0-9a-f]{40}$/i.test(selection.value.trim())
      : /^[0-9a-f]{7,40}$/i.test(selection.value.trim()));
  const pick = source ? versionPickPayload(source, selection, inspect) : null;
  const canSubmit = Boolean(
    source &&
    selection.value.trim() &&
    commitValid &&
    (variant === 'add' || pick)
  );
  const switchTarget = versionSwitchTarget(selection, inspect);
  const canSwitch = canSwitchWorkspaceVersion({
    hasWorkspace,
    target: switchTarget,
  });
  const duplicateHint = existingVersionHint(source, selection, inspect, mode);

  const selectTab = (tab: string) => {
    const next = tab as VersionTab;
    setActiveTab(next);
    // A tab is the selection model: changing it deliberately discards the
    // other tab's value, so a submit can never contain multiple ref kinds.
    setSelection({ tab: next, value: '' });
    if (variant === 'add') setMode('copy');
    setSwitchError('');
  };

  const handleSubmit = async () => {
    if (!source || !canSubmit) return;
    if (props.variant === 'pick') {
      props.onPick(pick!);
      onOpenChange(false);
      return;
    }
    const { onSubmit, onSwitchWorkspace } = props as AddVersionModalAddProps;
    if (
      mode === 'switch' &&
      canSwitch &&
      source.repoPathOrUrl &&
      switchTarget
    ) {
      setSwitching(true);
      setSwitchError('');
      try {
        await onSwitchWorkspace(source.repoPathOrUrl, switchTarget);
        onOpenChange(false);
      } catch (error) {
        setSwitchError(switchErrorMessage(error));
      } finally {
        setSwitching(false);
      }
      return;
    }
    onSubmit(versionSubmitPayload(source, selection));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content glass-overlay max-w-xl w-[90vw] p-4">
          <Dialog.Title className="text-base font-semibold mb-2">
            Add repository version
          </Dialog.Title>
          <Dialog.Description className="text-sm opacity-80 mb-4">
            {source ? sanitizeDisplayText(source.label) : ''}
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
          {switchError && (
            <div className="text-xs text-err mb-3">{switchError}</div>
          )}

          <Tabs.Root value={activeTab} onValueChange={selectTab}>
            <Tabs.List aria-label="Version source" className="tabs-list">
              {showReleasesTab && (
                <Tabs.Trigger value="releases" className="tabs-trigger">
                  Releases
                </Tabs.Trigger>
              )}
              <Tabs.Trigger value="branches" className="tabs-trigger">
                Branches
              </Tabs.Trigger>
              <Tabs.Trigger value="commit" className="tabs-trigger">
                Commit
              </Tabs.Trigger>
            </Tabs.List>

            {showReleasesTab && (
              <Tabs.Content value="releases" className="mb-3">
                {inspecting ? (
                  <div className="flex justify-center py-8">
                    <Loader2 size={20} className="animate-spin opacity-70" />
                  </div>
                ) : inspectError ? (
                  <div className="text-xs text-err py-4">{inspectError}</div>
                ) : (
                  <>
                    <label className="block text-sm font-medium mb-2">
                      Release or tag
                    </label>
                    <Select
                      options={[
                        { value: '', label: 'Choose a release or tag' },
                        ...releases.map((item, index) => ({
                          value: item.tag,
                          label: `${item.tag}${index === 0 && !item.prerelease ? ' (latest)' : ''}${item.prerelease ? ' (prerelease)' : ''}`,
                        })),
                        ...tags.map((name) => ({ value: name, label: name })),
                      ]}
                      value={
                        selection.tab === 'releases' ? selection.value : ''
                      }
                      onValueChange={(value) =>
                        setSelection({ tab: 'releases', value })
                      }
                      anchor="left"
                    />
                  </>
                )}
              </Tabs.Content>
            )}

            <Tabs.Content value="branches" className="mb-3">
              {source?.url && inspecting ? (
                <div className="flex justify-center py-8">
                  <Loader2 size={20} className="animate-spin opacity-70" />
                </div>
              ) : source?.url && inspectError ? (
                <div className="text-xs text-err py-4">{inspectError}</div>
              ) : (
                <>
                  <label className="block text-sm font-medium mb-2">
                    Branch
                  </label>
                  <Select
                    options={[
                      { value: '', label: 'Choose a branch' },
                      ...branches.map((name) => ({ value: name, label: name })),
                    ]}
                    value={selection.tab === 'branches' ? selection.value : ''}
                    onValueChange={(value) =>
                      setSelection({ tab: 'branches', value })
                    }
                    anchor="left"
                  />
                </>
              )}
            </Tabs.Content>

            <Tabs.Content value="commit" className="mb-3">
              <label className="block text-sm font-medium mb-2">
                Commit hash
              </label>
              <input
                ref={commitInput}
                type="text"
                placeholder={
                  variant === 'pick'
                    ? 'Full commit hash'
                    : 'Full or short commit hash'
                }
                value={selection.tab === 'commit' ? selection.value : ''}
                onChange={(event) =>
                  setSelection({ tab: 'commit', value: event.target.value })
                }
                className="input-glass font-mono text-xs"
                spellCheck={false}
              />
              {!commitValid && (
                <div className="text-xs text-err mt-1">
                  {variant === 'pick'
                    ? 'Enter all 40 hexadecimal characters. Abbreviated hashes cannot be resolved without fetching.'
                    : 'Enter 7–40 hexadecimal characters.'}
                </div>
              )}
            </Tabs.Content>
          </Tabs.Root>

          {variant === 'add' && shouldShowVersionMode(hasWorkspace) && (
            <fieldset className="mb-4">
              <legend className="block text-sm font-medium mb-2">
                For this repository
              </legend>
              <div className="flex gap-3">
                <label className="card-milky p-3 flex-1 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="version-mode"
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
                    name="version-mode"
                    checked={mode === 'switch'}
                    onChange={() => setMode('switch')}
                    disabled={!canSwitch}
                    className="mr-2"
                  />
                  {activeTab === 'branches'
                    ? 'Switch branch'
                    : 'Switch working copy'}
                  <span className="block text-xs opacity-70 mt-1">
                    {activeTab === 'branches'
                      ? 'Carry changes over when Git allows it.'
                      : 'Check out this commit in detached HEAD; carry changes over when Git allows it.'}
                  </span>
                </label>
              </div>
            </fieldset>
          )}

          {variant === 'add' && duplicateHint && (
            <div className="text-xs opacity-70 mb-4">{duplicateHint}</div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={switching}
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSubmit()}
              disabled={
                !canSubmit ||
                switching ||
                (variant === 'add' && mode === 'switch' && !canSwitch)
              }
            >
              {variant === 'pick'
                ? 'Use version'
                : switching
                  ? 'Switching…'
                  : mode === 'switch' && canSwitch
                    ? activeTab === 'branches'
                      ? 'Switch branch'
                      : 'Switch working copy'
                    : 'Add version'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
