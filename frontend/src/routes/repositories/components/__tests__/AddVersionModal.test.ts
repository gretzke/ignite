// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  canSwitchWorkspaceVersion,
  shouldShowVersionMode,
  versionSubmitPayload,
  versionPickerSections,
  versionSwitchTarget,
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

  it('submits only the active tab selection with its matching ref kind', () => {
    expect(
      versionSubmitPayload(source, { tab: 'releases', value: 'v1.1.0' })
    ).toEqual({
      url: source.url,
      ref: 'v1.1.0',
      refKind: 'tag',
    });
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
});
