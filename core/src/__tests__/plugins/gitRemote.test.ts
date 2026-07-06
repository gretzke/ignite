import { describe, it, expect } from 'vitest';
import {
  parseLsRemote,
  parseSemverTag,
  compareVersionStrings,
  releasesFromTags,
  deriveTrack,
  assertAllowedGitUrl,
} from '../../plugins/install/gitRemote.js';

const SAMPLE = [
  'ref: refs/heads/main\tHEAD',
  'aaaa000000000000000000000000000000000000\tHEAD',
  'aaaa000000000000000000000000000000000000\trefs/heads/main',
  'bbbb000000000000000000000000000000000000\trefs/heads/dev',
  'cccc000000000000000000000000000000000000\trefs/tags/v0.4.0',
  'dddd000000000000000000000000000000000000\trefs/tags/v0.4.0^{}',
  'eeee000000000000000000000000000000000000\trefs/tags/v0.10.0',
  'ffff000000000000000000000000000000000000\trefs/tags/not-a-version',
].join('\n');

describe('gitRemote', () => {
  it('parses ls-remote output: default branch, branches, peeled tags', () => {
    const refs = parseLsRemote(SAMPLE);
    expect(refs.defaultBranch).toBe('main');
    expect(refs.branches).toEqual({
      main: 'aaaa000000000000000000000000000000000000',
      dev: 'bbbb000000000000000000000000000000000000',
    });
    // Annotated tag resolves to the peeled (commit) sha.
    expect(refs.tags['v0.4.0']).toBe(
      'dddd000000000000000000000000000000000000'
    );
    expect(refs.tags['not-a-version']).toBeDefined();
  });

  it('orders semver correctly, including double-digit segments and prereleases', () => {
    expect(compareVersionStrings('0.10.0', '0.4.0')).toBeGreaterThan(0);
    expect(compareVersionStrings('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersionStrings('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersionStrings('abc', '1.0.0')).toBeNull();
    expect(parseSemverTag('v1.2.3-rc.1')?.prerelease).toBe('rc.1');
    expect(parseSemverTag('release-1')).toBeNull();
  });

  it('turns semver tags into releases, newest first, skipping non-semver tags', () => {
    const releases = releasesFromTags(parseLsRemote(SAMPLE).tags);
    expect(releases.map((r) => r.tag)).toEqual(['v0.10.0', 'v0.4.0']);
    expect(releases[0].version).toBe('0.10.0');
    expect(releases[1].sha).toBe('dddd000000000000000000000000000000000000');
  });

  it('derives what an install tracks from its ref', () => {
    const remote = {
      defaultBranch: 'main',
      branches: ['main', 'dev'],
      releases: [{ tag: 'v0.4.0', version: '0.4.0', sha: 'd'.repeat(40) }],
    };
    expect(deriveTrack(undefined, remote)).toEqual({
      mode: 'branch',
      branch: 'main',
    });
    expect(deriveTrack('a'.repeat(40), remote)).toEqual({ mode: 'commit' });
    expect(deriveTrack('v0.4.0', remote)).toEqual({
      mode: 'release',
      version: 'v0.4.0',
    });
    expect(deriveTrack('dev', remote)).toEqual({
      mode: 'branch',
      branch: 'dev',
    });
    // Non-semver tag known to the remote → pinned.
    expect(
      deriveTrack('not-a-version', remote, { 'not-a-version': 'f'.repeat(40) })
    ).toEqual({ mode: 'commit' });
  });

  it('rejects command-executing git transports', () => {
    expect(() => assertAllowedGitUrl('ext::sh -c "touch /tmp/pwned"')).toThrow(
      /scheme/i
    );
    expect(() => assertAllowedGitUrl('https://github.com/a/b')).not.toThrow();
  });
});
