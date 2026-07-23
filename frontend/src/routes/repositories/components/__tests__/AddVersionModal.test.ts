// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  canSwitchWorkspaceVersion,
  shouldShowVersionMode,
  versionSubmitPayload,
  versionPickPayload,
  versionPickerSections,
  versionPickerSourceKey,
  versionSwitchTarget,
  existingVersionHint,
  type VersionSource,
} from '../AddVersionModal';

const source: VersionSource = {
  sourceKey: '/repo',
  label: '/repo',
  repoPathOrUrl: '/repo',
  url: 'https://example.test/contracts.git',
  local: true,
};

const inspected = {
  defaultBranch: 'main',
  branches: ['main', 'release'],
  branchHeads: {},
  tagHeads: { 'v1.0.0': 'a'.repeat(40), 'v1.1.0': 'b'.repeat(40) },
  releases: [
    { tag: 'v1.1.0', version: '1.1.0', sha: 'b'.repeat(40), prerelease: false },
  ],
};

describe('AddVersionModal picker behavior', () => {
  it('keeps the picker source stable across parent re-renders while remote inspection loads', () => {
    expect(versionPickerSourceKey({ ...source })).toBe(
      versionPickerSourceKey(source)
    );
    expect(
      versionPickerSourceKey({ ...source, initialCommit: 'b'.repeat(40) })
    ).not.toBe(versionPickerSourceKey(source));
  });

  it('warns for an existing release or commit-prefix selection without blocking submit', () => {
    const withExisting: VersionSource = {
      ...source,
      existingVersions: [
        { commit: 'b'.repeat(40), refLabel: 'v1.1.0' },
      ],
    };
    expect(
      existingVersionHint(
        withExisting,
        { tab: 'releases', value: 'v1.1.0' },
        inspected,
        'copy'
      )
    ).toBe("Already added to this repository's versions.");
    expect(
      existingVersionHint(
        withExisting,
        { tab: 'commit', value: 'bbbbbbb' },
        inspected,
        'switch'
      )
    ).toBe(
      'This ref is already available as a pinned version. Switching changes your live checkout instead.'
    );
    expect(
      existingVersionHint(
        withExisting,
        { tab: 'releases', value: 'v9.9.9' },
        inspected,
        'copy'
      )
    ).toBeNull();
  });

  it('merges and deduplicates remote and workspace branches', () => {
    const sections = versionPickerSections(source, inspected, ['work', 'main']);

    expect(sections.releases.map((item) => item.tag)).toEqual(['v1.1.0']);
    expect(sections.tags).toEqual(['v1.0.0']);
    expect(sections.branches).toEqual(['main', 'release', 'work']);
  });

  it('shows the copy-or-switch choices on every tab for live workspaces only', () => {
    expect(shouldShowVersionMode(true)).toBe(true);
    expect(shouldShowVersionMode(false)).toBe(false);

    expect(
      canSwitchWorkspaceVersion({
        hasWorkspace: true,
        target: { kind: 'branch', branch: 'work' },
      })
    ).toBe(true);
    expect(
      canSwitchWorkspaceVersion({
        hasWorkspace: true,
        target: { kind: 'commit', commit: 'a'.repeat(40) },
      })
    ).toBe(true);
    expect(
      canSwitchWorkspaceVersion({
        hasWorkspace: false,
        target: { kind: 'branch', branch: 'main' },
      })
    ).toBe(false);
  });

  it('switches a selected release by its inspected commit SHA', () => {
    expect(
      versionSwitchTarget({ tab: 'releases', value: 'v1.1.0' }, inspected)
    ).toEqual({ kind: 'commit', commit: 'b'.repeat(40) });
  });

  it('submits local branches and commits through the workspace path', () => {
    expect(
      versionSubmitPayload(source, { tab: 'branches', value: 'work' })
    ).toEqual({
      repoPathOrUrl: source.repoPathOrUrl,
      ref: 'work',
      refKind: 'branch',
    });
    expect(
      versionSubmitPayload(source, { tab: 'commit', value: 'abcdef0' })
    ).toEqual({ repoPathOrUrl: source.repoPathOrUrl, commit: 'abcdef0' });
  });

  it('submits a local workspace release through its remote URL', () => {
    expect(
      versionSubmitPayload(source, { tab: 'releases', value: 'v1.1.0' })
    ).toEqual({
      url: source.url,
      ref: 'v1.1.0',
      refKind: 'tag',
    });
  });

  it('submits a cloned workspace release through its workspace path', () => {
    const cloned: VersionSource = { ...source, local: false };

    expect(
      versionSubmitPayload(cloned, { tab: 'releases', value: 'v1.1.0' })
    ).toEqual({
      repoPathOrUrl: cloned.repoPathOrUrl,
      ref: 'v1.1.0',
      refKind: 'tag',
    });
  });

  it('submits an orphaned cache group through its remote URL', () => {
    const orphan: VersionSource = { ...source, repoPathOrUrl: undefined };

    expect(
      versionSubmitPayload(orphan, { tab: 'releases', value: 'v1.1.0' })
    ).toEqual({
      url: orphan.url,
      ref: 'v1.1.0',
      refKind: 'tag',
    });
  });

  it('resolves release, tag, and branch picks to full inspected pins', () => {
    expect(
      versionPickPayload(source, { tab: 'releases', value: 'v1.1.0' }, inspected)
    ).toEqual({ url: source.url, commit: 'b'.repeat(40), ref: 'v1.1.0', refKind: 'tag' });
    expect(
      versionPickPayload(source, { tab: 'releases', value: 'v1.0.0' }, inspected)
    ).toEqual({ url: source.url, commit: 'a'.repeat(40), ref: 'v1.0.0', refKind: 'tag' });
    expect(
      versionPickPayload(source, { tab: 'branches', value: 'main' }, { ...inspected, branchHeads: { main: 'c'.repeat(40) } })
    ).toEqual({ url: source.url, commit: 'c'.repeat(40), ref: 'main', refKind: 'branch' });
  });

  it('rejects abbreviated commit picks while preserving add-version short hashes', () => {
    expect(versionPickPayload(source, { tab: 'commit', value: 'abcdef0' }, inspected)).toBeNull();
    expect(versionSubmitPayload(source, { tab: 'commit', value: 'abcdef0' })).toEqual({ repoPathOrUrl: source.repoPathOrUrl, commit: 'abcdef0' });
  });
});
