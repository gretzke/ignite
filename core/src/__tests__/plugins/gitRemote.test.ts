import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  parseLsRemote,
  parseSemverTag,
  compareVersionStrings,
  releasesFromTags,
  deriveTrack,
  assertAllowedGitUrl,
  inspectGitRemote,
  clearGitRemoteCaches,
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

  it('publishes branch heads from a file:// remote', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-git-remote-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await fs.writeFile(path.join(dir, 'README.md'), 'test\n');
      execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      clearGitRemoteCaches();
      const inspected = await inspectGitRemote(`file://${dir}`);
      expect(inspected.branchHeads).toEqual({ main: head });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('inspects an scp remote through the same ssh URL identity used by the version store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-git-scp-'));
    const saved = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => url.includes('/releases?') ? [] : { description: 'fixture' },
      } as Response;
    });
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await fs.writeFile(path.join(dir, 'README.md'), 'scp fixture\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = `url.file://${dir}/.insteadOf`;
      process.env.GIT_CONFIG_VALUE_0 = 'ssh://git@github.com/org/repo.git';
      clearGitRemoteCaches();

      const inspected = await inspectGitRemote('git@github.com:org/repo.git');

      expect(inspected.branchHeads).toEqual({ main: head });
      expect(inspected.github).toMatchObject({ owner: 'org', repo: 'repo' });
    } finally {
      fetchSpy.mockRestore();
      for (const [name, value] of Object.entries({ GIT_CONFIG_COUNT: saved.count, GIT_CONFIG_KEY_0: saved.key, GIT_CONFIG_VALUE_0: saved.value })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      clearGitRemoteCaches();
      await fs.rm(dir, { recursive: true, force: true });
    }
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
      branchHeads: { main: 'a'.repeat(40), dev: 'b'.repeat(40) },
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
