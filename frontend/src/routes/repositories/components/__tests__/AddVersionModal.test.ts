// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  canSwitchLocalBranch,
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
  it('shows remote inspect results alongside local branches for a local origin', () => {
    const sections = versionPickerSections(source, inspected, ['work', 'main']);

    expect(sections.releases.map((item) => item.tag)).toEqual(['v1.1.0']);
    expect(sections.tags).toEqual(['v1.0.0']);
    expect(sections.remoteBranches).toEqual(['main', 'release']);
    expect(sections.localBranches).toEqual(['work', 'main']);
  });

  it('only allows switching an explicitly selected local branch', () => {
    expect(
      canSwitchLocalBranch({
        local: true,
        localBranch: 'work',
        remoteRefSelected: false,
        commit: '',
      })
    ).toBe(true);
    expect(
      canSwitchLocalBranch({
        local: true,
        localBranch: '',
        remoteRefSelected: true,
        commit: '',
      })
    ).toBe(false);
  });
});
