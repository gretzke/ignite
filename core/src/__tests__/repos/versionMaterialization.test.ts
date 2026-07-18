import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { RepoService } from '../../repos/RepoService.js';
import { VersionStore } from '../../repos/VersionStore.js';
import type { ProfileManager } from '../../filesystem/ProfileManager.js';
import { runCommand } from '../../utils/runCommand.js';
import { getLogger } from '../../utils/logger.js';

const profileId = 'profile-1';
const dirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function temp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function sourceRepo(prefix = 'ignite-version-source-'): Promise<{
  source: string;
  remote: string;
  first: string;
  second: string;
}> {
  const source = await temp(prefix);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(source, 'tracked.txt'), 'one\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-q', '-m', 'one']);
  const first = git(source, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(source, 'tracked.txt'), 'two\n');
  git(source, ['commit', '-qam', 'two']);
  const second = git(source, ['rev-parse', 'HEAD']);
  const bare = await temp('ignite-version-remote-');
  git(bare, ['init', '-q', '--bare']);
  git(source, ['remote', 'add', 'origin', `file://${bare}`]);
  git(source, ['push', '-q', 'origin', 'main']);
  return { source, remote: `file://${bare}`, first, second };
}

async function service(
  home: string,
  run = runCommand
): Promise<{
  repos: RepoService;
  versions: VersionStore;
}> {
  FileSystem.resetInstance();
  const fileSystem = FileSystem.getInstance(home);
  return {
    repos: new RepoService({
      fileSystem,
      profiles: {
        getCurrentProfile: () => profileId,
      } as unknown as ProfileManager,
      run,
    }),
    versions: new VersionStore(fileSystem),
  };
}

async function approved(home: string, url: string, run = runCommand) {
  const result = await service(home, run);
  await result.versions.approveOrigins(profileId, [url]);
  return result;
}

beforeAll(() => {
  execFileSync('git', ['--version']);
});
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('RepoService version materialization', () => {
  it('requires origin approval before any git invocation', async () => {
    const home = await temp('ignite-version-home-');
    const run = vi.fn(runCommand);
    const { repos } = await service(home, run as typeof runCommand);

    await expect(
      repos.ensureVersion(profileId, 'file:///unapproved/repo', 'a'.repeat(40))
    ).rejects.toMatchObject({
      code: 'VERSION_ORIGIN_UNAPPROVED',
      origins: ['file://'],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('materializes independent real clones for two versions using one bare cache', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos, versions } = await approved(home, remote.remote);

    const first = await repos.ensureVersion(
      profileId,
      remote.remote,
      remote.first,
      {
        ref: 'refs/heads/main',
        refLabel: 'main',
        refKind: 'branch',
      }
    );
    const second = await repos.ensureVersion(
      profileId,
      remote.remote,
      remote.second
    );

    expect(git(first.checkout, ['rev-parse', 'HEAD'])).toBe(remote.first);
    expect(git(second.checkout, ['rev-parse', 'HEAD'])).toBe(remote.second);
    for (const checkout of [first.checkout, second.checkout]) {
      const dotGit = await fs.stat(path.join(checkout, '.git'));
      expect(dotGit.isDirectory()).toBe(true);
      expect(dotGit.isFile()).toBe(false);
    }
    expect(
      (await fs.stat(versions.bareRepoPath(remote.remote))).isDirectory()
    ).toBe(true);
    expect(await versions.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: remote.remote,
          commit: remote.first,
          refLabel: 'main',
          refKind: 'branch',
        }),
        expect.objectContaining({ url: remote.remote, commit: remote.second }),
      ])
    );
  });

  it('keeps each version’s submodule URL and content isolated', async () => {
    const subA = await temp('ignite-version-sub-a-');
    const subB = await temp('ignite-version-sub-b-');
    let subBCommit = '';
    for (const [repo, content] of [
      [subA, 'A\n'],
      [subB, 'B\n'],
    ] as const) {
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test']);
      await fs.writeFile(path.join(repo, 'submodule.txt'), content);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', content.trim()]);
      if (repo === subB) subBCommit = git(repo, ['rev-parse', 'HEAD']);
    }
    const parent = await temp('ignite-version-parent-');
    git(parent, ['init', '-q', '-b', 'main']);
    git(parent, ['config', 'user.email', 'test@example.com']);
    git(parent, ['config', 'user.name', 'Test']);
    git(parent, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      `file://${subA}`,
      'deps/sub',
    ]);
    git(parent, ['commit', '-q', '-am', 'submodule A']);
    const first = git(parent, ['rev-parse', 'HEAD']);
    await fs.writeFile(
      path.join(parent, '.gitmodules'),
      `[submodule "deps/sub"]\n\tpath = deps/sub\n\turl = file://${subB}\n`
    );
    git(parent, ['add', '.gitmodules']);
    git(parent, [
      'update-index',
      '--cacheinfo',
      `160000,${subBCommit},deps/sub`,
    ]);
    git(parent, ['commit', '-q', '-m', 'submodule B']);
    const second = git(parent, ['rev-parse', 'HEAD']);
    const bare = await temp('ignite-version-parent-remote-');
    git(bare, ['init', '-q', '--bare']);
    git(parent, ['remote', 'add', 'origin', `file://${bare}`]);
    git(parent, ['push', '-q', 'origin', 'main']);
    const remote = `file://${bare}`;
    const home = await temp('ignite-version-home-');
    const { repos } = await approved(home, remote);

    const v1 = await repos.ensureVersion(profileId, remote, first);
    const v2 = await repos.ensureVersion(profileId, remote, second);

    await expect(
      fs.readFile(path.join(v1.checkout, 'deps/sub/submodule.txt'), 'utf8')
    ).resolves.toBe('A\n');
    await expect(
      fs.readFile(path.join(v2.checkout, 'deps/sub/submodule.txt'), 'utf8')
    ).resolves.toBe('B\n');
    await expect(
      repos.assertPinnedIntegrity(v1.checkout, first)
    ).resolves.toBeUndefined();
    await expect(
      repos.assertPinnedIntegrity(v2.checkout, second)
    ).resolves.toBeUndefined();
  });

  it('uses the integrity-checked checkout fast path and serializes concurrent materialization', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const run = vi.fn(runCommand);
    const { repos } = await approved(
      home,
      remote.remote,
      run as typeof runCommand
    );

    await Promise.all([
      repos.ensureVersion(profileId, remote.remote, remote.first),
      repos.ensureVersion(profileId, remote.remote, remote.first),
    ]);
    expect(
      run.mock.calls.filter(([, args]) => (args as string[]).includes('clone'))
    ).toHaveLength(1);
    const fetches = run.mock.calls.filter(([, args]) =>
      (args as string[]).includes('fetch')
    ).length;
    await repos.ensureVersion(profileId, remote.remote, remote.first);
    expect(
      run.mock.calls.filter(([, args]) => (args as string[]).includes('fetch'))
    ).toHaveLength(fetches);
  });

  it('fetches ref first, then SHA, without shallow or partial fetches', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const calls: string[][] = [];
    const run = vi.fn(async (...args: Parameters<typeof runCommand>) => {
      calls.push(args[1] as string[]);
      return runCommand(...args);
    });
    const { repos, versions } = await approved(
      home,
      remote.remote,
      run as typeof runCommand
    );

    await repos.ensureVersion(profileId, remote.remote, remote.first, {
      ref: 'refs/heads/main',
    });

    const fetches = calls.filter((args) => args.includes('fetch'));
    expect(fetches[0]).toEqual(
      expect.arrayContaining(['fetch', 'origin', 'refs/heads/main'])
    );
    expect(fetches.some((args) => args.includes(remote.first))).toBe(false);
    expect(fetches.flat()).not.toContain('--depth');
    expect(fetches.flat()).not.toContain('--filter');
    expect(
      git(versions.bareRepoPath(remote.remote), [
        'rev-parse',
        `refs/ignite/versions/${remote.first}`,
      ])
    ).toBe(remote.first);

    await repos.removeVersionCheckout(remote.remote, remote.first);
    calls.length = 0;
    await repos.ensureVersion(profileId, remote.remote, remote.first);
    expect(
      calls.filter((args) => args.includes('fetch') && args.includes('origin'))
    ).toEqual([]);
  });

  it('falls back from a rejected ref fetch to a SHA fetch', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const calls: string[][] = [];
    const run = vi.fn(async (...args: Parameters<typeof runCommand>) => {
      const gitArgs = args[1] as string[];
      calls.push(gitArgs);
      if (gitArgs.includes('fetch') && gitArgs.includes('refs/heads/rejected'))
        return { code: 1, stdout: '', stderr: 'rejected' };
      return runCommand(...args);
    });
    const { repos } = await approved(
      home,
      remote.remote,
      run as typeof runCommand
    );

    await repos.ensureVersion(profileId, remote.remote, remote.first, {
      ref: 'refs/heads/rejected',
    });
    const fetches = calls.filter((args) => args.includes('fetch'));
    expect(fetches.slice(0, 2)).toEqual([
      expect.arrayContaining(['fetch', 'origin', 'refs/heads/rejected']),
      expect.arrayContaining(['fetch', 'origin', remote.first]),
    ]);
  });

  it('uses only an origin-matched local fallback and records it', async () => {
    const remote = await sourceRepo();
    await fs.writeFile(path.join(remote.source, 'local-only.txt'), 'local\n');
    git(remote.source, ['add', '.']);
    git(remote.source, ['commit', '-q', '-m', 'local only']);
    const localOnly = git(remote.source, ['rev-parse', 'HEAD']);
    const home = await temp('ignite-version-home-');
    const { repos, versions } = await approved(home, remote.remote);

    await repos.ensureVersion(profileId, remote.remote, localOnly, {
      localFallbackPath: remote.source,
    });
    expect(await versions.get(remote.remote, localOnly)).toMatchObject({
      localFallback: true,
    });

    const wrong = await sourceRepo('ignite-version-wrong-source-');
    await fs.writeFile(path.join(wrong.source, 'wrong-only.txt'), 'wrong\n');
    git(wrong.source, ['add', '.']);
    git(wrong.source, ['commit', '-q', '-m', 'wrong only']);
    const wrongCommit = git(wrong.source, ['rev-parse', 'HEAD']);
    await expect(
      repos.ensureVersion(profileId, remote.remote, wrongCommit, {
        localFallbackPath: wrong.source,
      })
    ).rejects.toMatchObject({
      code: 'VERSION_FETCH_FAILED',
      attemptedStages: expect.arrayContaining(['localFallback']),
    });
  });

  it('cleans temporary directories after clone failure', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const run = vi.fn(async (...args: Parameters<typeof runCommand>) => {
      if ((args[1] as string[]).includes('clone'))
        return { code: 1, stdout: '', stderr: 'clone failed' };
      return runCommand(...args);
    });
    const { repos, versions } = await approved(
      home,
      remote.remote,
      run as typeof runCommand
    );

    await expect(
      repos.ensureVersion(profileId, remote.remote, remote.first)
    ).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' });
    const entries = await fs.readdir(versions.groupDir(remote.remote));
    expect(entries.filter((entry) => entry.startsWith('tmp-'))).toEqual([]);
  });

  it('serializes checkout removal with version lifecycle work', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos } = await approved(home, remote.remote);
    const { checkout } = await repos.ensureVersion(
      profileId,
      remote.remote,
      remote.first
    );
    let release!: () => void;
    const held = repos.withVersionLock(
      remote.remote,
      remote.first,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const removing = repos.removeVersionCheckout(remote.remote, remote.first);
    await expect(fs.access(checkout)).resolves.toBeUndefined();
    release();
    await held;
    await removing;
    await expect(fs.access(checkout)).rejects.toThrow();
  });

  it('does not let removal overtake an integrity-checked fast-path return', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    let pauseFastPath = false;
    let entered!: () => void;
    let release!: () => void;
    const fastPathEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fastPathRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async (...args: Parameters<typeof runCommand>) => {
      const gitArgs = args[1] as string[];
      if (
        pauseFastPath &&
        gitArgs.includes('submodule') &&
        gitArgs.includes('foreach')
      ) {
        pauseFastPath = false;
        entered();
        await fastPathRelease;
      }
      return runCommand(...args);
    });
    const { repos } = await approved(
      home,
      remote.remote,
      run as typeof runCommand
    );
    const { checkout } = await repos.ensureVersion(
      profileId,
      remote.remote,
      remote.first
    );

    pauseFastPath = true;
    const completionOrder: string[] = [];
    const ensuring = repos
      .ensureVersion(profileId, remote.remote, remote.first)
      .then((result) => {
        completionOrder.push('ensure');
        return result;
      });
    await fastPathEntered;
    const removing = repos
      .removeVersionCheckout(remote.remote, remote.first)
      .then(() => completionOrder.push('remove'));
    await Promise.resolve();
    await expect(fs.access(checkout)).resolves.toBeUndefined();

    release();
    await ensuring;
    await removing;
    expect(completionOrder).toEqual(['ensure', 'remove']);
  });

  it('logs and rebuilds an existing checkout that fails integrity', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const run = vi.fn(runCommand);
    const { repos } = await approved(
      home,
      remote.remote,
      run as typeof runCommand
    );
    const second = await repos.ensureVersion(
      profileId,
      remote.remote,
      remote.second
    );
    git(second.checkout, ['checkout', '-q', '--detach', remote.first]);
    const clonesBefore = run.mock.calls.filter(([, args]) =>
      (args as string[]).includes('clone')
    ).length;
    const warning = vi
      .spyOn(getLogger(), 'warn')
      .mockImplementation(() => undefined);

    await repos.ensureVersion(profileId, remote.remote, remote.second);

    expect(git(second.checkout, ['rev-parse', 'HEAD'])).toBe(remote.second);
    expect(
      run.mock.calls.filter(([, args]) => (args as string[]).includes('clone'))
    ).toHaveLength(clonesBefore + 1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(remote.remote)
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(remote.second)
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('PINNED_INTEGRITY_VIOLATION')
    );
    warning.mockRestore();
  });
});
