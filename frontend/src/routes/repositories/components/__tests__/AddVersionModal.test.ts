// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  canSwitchWorkspaceBranch,
  versionSubmitPayload,
  versionPickerSections,
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

  it('only shows switching for a selected branch in a live workspace', () => {
    expect(
      canSwitchWorkspaceBranch({
        hasWorkspace: true,
        tab: 'branches',
        branch: 'work',
      })
    ).toBe(true);
    expect(
      canSwitchWorkspaceBranch({
        hasWorkspace: true,
        tab: 'releases',
        branch: 'v1.1.0',
      })
    ).toBe(false);
    expect(
      canSwitchWorkspaceBranch({
        hasWorkspace: false,
        tab: 'branches',
        branch: 'main',
      })
    ).toBe(false);
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
