import { describe, it, expect, vi } from 'vitest';
import { RepoPrivacyChecker } from '../../plugins/git/RepoPrivacyChecker.js';

describe('RepoPrivacyChecker', () => {
  it('uses the GitHub API for github URLs', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ private: false }),
    })) as never;
    const checker = new RepoPrivacyChecker({ fetchFn, now: () => 1000 });
    await expect(
      checker.isRepoPublic('https://github.com/a/b')
    ).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/a/b',
      expect.anything()
    );
  });

  it('treats GitHub 404 as private/nonexistent (false)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as never;
    const checker = new RepoPrivacyChecker({ fetchFn, now: () => 1000 });
    await expect(
      checker.isRepoPublic('https://github.com/a/b')
    ).resolves.toBe(false);
  });

  it('falls back to git ls-remote for non-GitHub hosts', async () => {
    const lsRemote = vi.fn(async () => ({ ok: true }));
    const checker = new RepoPrivacyChecker({
      lsRemote,
      now: () => 1000,
    });
    await expect(
      checker.isRepoPublic('https://gitlab.com/a/b')
    ).resolves.toBe(true);
    expect(lsRemote).toHaveBeenCalledWith('https://gitlab.com/a/b');
  });

  it('caches results for five minutes', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ private: true }),
    })) as never;
    let t = 0;
    const checker = new RepoPrivacyChecker({ fetchFn, now: () => t });
    await checker.isRepoPublic('https://github.com/a/b');
    t = 4 * 60 * 1000;
    await checker.isRepoPublic('https://github.com/a/b');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 6 * 60 * 1000;
    await checker.isRepoPublic('https://github.com/a/b');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
