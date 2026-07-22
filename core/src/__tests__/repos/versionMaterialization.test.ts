import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { RepoService } from '../../repos/RepoService.js';
import { canonicalGitUrl, VersionStore } from '../../repos/VersionStore.js';
import type { ProfileManager } from '../../filesystem/ProfileManager.js';
import { runCommand } from '../../utils/runCommand.js';
import { getLogger } from '../../utils/logger.js';
import { artifactCacheIdentity, artifactListingCache, artifactListingCacheKey } from '../../repos/ArtifactListingCache.js';

const profileId = 'profile-1';
const dirs: string[] = [];
const testCommit = 'a'.repeat(40);

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
  it('keeps the bare remote on the verbatim fetch URL when canonical identity strips .git', async () => {
    const home = await temp('ignite-version-home-');
    const canonicalUrl = 'https://example.test/team/contracts';
    const fetchUrl = `${canonicalUrl}.git`;
    FileSystem.resetInstance();
    const fileSystem = FileSystem.getInstance(home);
    const versions = new VersionStore(fileSystem);
    await fs.mkdir(versions.bareRepoPath(canonicalUrl), { recursive: true });
    const run = vi.fn(async (_command: string, args: string[]) =>
      args.join(' ') === 'remote get-url origin'
        ? { code: 0, stdout: 'https://example.test/team/stale.git\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    );
    const repos = new RepoService({
      fileSystem,
      profiles: { getCurrentProfile: () => profileId } as unknown as ProfileManager,
      run: run as typeof runCommand,
    });

    await (repos as unknown as {
      ensureBareVersionRepo: (
        group: string,
        url: string,
        remote: string,
        budget: { signal: AbortSignal; remaining: () => number }
      ) => Promise<void>;
    }).ensureBareVersionRepo(
      versions.groupDir(canonicalUrl),
      canonicalUrl,
      fetchUrl,
      { signal: new AbortController().signal, remaining: () => 30_000 }
    );

    expect(run).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['remote', 'set-url', 'origin', fetchUrl]),
      expect.any(Object)
    );
  });

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

  it('rejects unsupported version URLs before approval or any git invocation', async () => {
    const home = await temp('ignite-version-home-');
    const run = vi.fn(runCommand);
    const { repos } = await service(home, run as typeof runCommand);

    await expect(
      repos.ensureVersion(profileId, 'ext::sh -c id', testCommit)
    ).rejects.toMatchObject({ code: 'VERSION_URL_UNSUPPORTED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('streams fresh materialization progress when requested', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos } = await approved(home, remote.remote);
    const logs: string[] = [];

    await repos.ensureVersion(profileId, remote.remote, remote.first, {
      onLog: (text) => logs.push(text),
    });
    await expect(
      repos.ensureVersion(profileId, remote.remote, remote.first)
    ).resolves.toBeDefined();

    expect(logs).toEqual([
      `materialize: fetch ${remote.remote}\n`,
      'materialize: clone\n',
      'materialize: submodules\n',
      'materialize: verify\n',
    ]);
  });

  it('rematerializes from the stored verbatim fetch URL', async () => {
    const remote = await sourceRepo('ignite-version-fetch-url-source-');
    const barePath = remote.remote.slice('file://'.length);
    const fetchPath = `${barePath}.git`;
    await fs.rename(barePath, fetchPath);
    dirs.push(fetchPath);
    const fetchUrl = `file://${fetchPath}`;
    const url = canonicalGitUrl(fetchUrl);
    const home = await temp('ignite-version-fetch-url-home-');
    const { repos, versions } = await approved(home, url);

    const { checkout } = await repos.ensureVersion(profileId, url, remote.first, {
      fetchUrl,
    });
    await fs.rm(checkout, { recursive: true, force: true });

    await repos.ensureVersion(profileId, url, remote.first);

    expect(git(versions.bareRepoPath(url), ['remote', 'get-url', 'origin'])).toBe(fetchUrl);
    expect(await versions.get(url, remote.first)).toEqual(
      expect.objectContaining({ fetchUrl })
    );
  });

  it('invalidates artifacts before rematerialization deletes the checkout', async () => {
    const remote = await sourceRepo('ignite-version-rematerialize-invalidate-');
    const home = await temp('ignite-version-rematerialize-invalidate-home-');
    const { repos, versions } = await approved(home, remote.remote);
    const { checkout } = await repos.ensureVersion(profileId, remote.remote, remote.first);
    const key = artifactListingCacheKey({
      profileId,
      canonicalIdentity: artifactCacheIdentity(remote.remote),
      frameworkId: 'waffle',
      pluginId: 'waffle',
      pluginVersion: '1.0.0',
      generation: 44,
    });
    artifactListingCache.set(key, [{ contractName: 'Old', sourcePath: 'src/Old.sol', artifactPath: 'artifacts/Old.json' }]);
    await versions.updateState(remote.remote, remote.first, {
      frameworks: [{ id: 'waffle', name: 'Waffle', artifactGeneration: 44 }],
    });
    let deletionStarted!: () => void;
    const deleting = new Promise<void>((resolve) => { deletionStarted = resolve; });
    let releaseDeletion!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const remove = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === checkout) {
        deletionStarted();
        await deleteGate;
      }
      return remove(target, options);
    });
    try {
      await repos.withVersionMaterialized(
        profileId,
        remote.remote,
        remote.first,
        {},
        async ({ rematerialize }) => {
          const rematerializing = rematerialize();
          await deleting;

          expect(artifactListingCache.get(key)).toBeUndefined();
          await expect(versions.get(remote.remote, remote.first)).resolves.toEqual(
            expect.objectContaining({ frameworks: [expect.not.objectContaining({ artifactGeneration: expect.anything() })] })
          );

          releaseDeletion();
          await rematerializing;
        }
      );
    } finally {
      rm.mockRestore();
      artifactListingCache.invalidate(artifactCacheIdentity(remote.remote));
    }
  });

  it('clears a stored fetch URL when an explicit canonical URL supersedes it', async () => {
    const remote = await sourceRepo('ignite-version-clear-fetch-url-source-');
    const barePath = remote.remote.slice('file://'.length);
    const fetchPath = `${barePath}.git`;
    await fs.rename(barePath, fetchPath);
    dirs.push(fetchPath);
    const fetchUrl = `file://${fetchPath}`;
    const url = canonicalGitUrl(fetchUrl);
    const home = await temp('ignite-version-clear-fetch-url-home-');
    const { repos, versions } = await approved(home, url);

    await repos.ensureVersion(profileId, url, remote.first, { fetchUrl });
    await repos.ensureVersion(profileId, url, remote.first, { fetchUrl: url });

    const persisted = JSON.parse(
      await fs.readFile(path.join(home, 'repos', 'cache.json'), 'utf8')
    ) as { versions: Array<Record<string, unknown>> };
    expect(persisted.versions[0]).not.toHaveProperty('fetchUrl');
  });

  it('preserves a stored fetch URL when no explicit fetch URL is provided', async () => {
    const remote = await sourceRepo('ignite-version-preserve-fetch-url-source-');
    const barePath = remote.remote.slice('file://'.length);
    const fetchPath = `${barePath}.git`;
    await fs.rename(barePath, fetchPath);
    dirs.push(fetchPath);
    const fetchUrl = `file://${fetchPath}`;
    const url = canonicalGitUrl(fetchUrl);
    const home = await temp('ignite-version-preserve-fetch-url-home-');
    const { repos, versions } = await approved(home, url);

    await repos.ensureVersion(profileId, url, remote.first, { fetchUrl });
    await repos.ensureVersion(profileId, url, remote.first);

    await expect(versions.get(url, remote.first)).resolves.toEqual(
      expect.objectContaining({ fetchUrl })
    );
  });

  it('rejects unsafe refs and labels before any git invocation', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const run = vi.fn(runCommand);
    const { repos } = await approved(home, remote.remote, run as typeof runCommand);

    await expect(
      repos.ensureVersion(profileId, remote.remote, remote.first, {
        ref: '--upload-pack=/bin/true',
      })
    ).rejects.toMatchObject({ code: 'VERSION_REF_INVALID' });
    await expect(
      repos.ensureVersion(profileId, remote.remote, remote.first, {
        refLabel: 'release candidate',
      })
    ).rejects.toMatchObject({ code: 'VERSION_REF_INVALID' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects relative local fallback paths before any git invocation', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const run = vi.fn(runCommand);
    const { repos } = await approved(home, remote.remote, run as typeof runCommand);

    await expect(
      repos.ensureVersion(profileId, remote.remote, remote.first, {
        localFallbackPath: 'relative/repository',
      })
    ).rejects.toMatchObject({ code: 'VERSION_LOCAL_FALLBACK_PATH_INVALID' });
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves git probe failures from version integrity checks', async () => {
    const home = await temp('ignite-version-home-');
    const { repos } = await service(home, (async (_command, args) => {
      if (args.includes('status'))
        return { code: 1, stdout: '', stderr: 'probe timed out' };
      return { code: 0, stdout: testCommit, stderr: '' };
    }) as typeof runCommand);

    await expect(
      repos.assertPinnedIntegrity('/version/repo', testCommit)
    ).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      message: expect.stringContaining('probe timed out'),
    });
  });

  it('enforces the version materialization deadline and removes its temporary checkout', async () => {
    const home = await temp('ignite-version-home-');
    const url = 'file:///deadline/repo';
    FileSystem.resetInstance();
    const fileSystem = FileSystem.getInstance(home);
    const versions = new VersionStore(fileSystem);
    await versions.approveOrigins(profileId, [url]);
    const run = vi.fn(
      async (
        _command: string,
        args: string[],
        options?: { signal?: AbortSignal }
      ) => {
        if (args.includes('rev-parse'))
          return { code: 1, stdout: '', stderr: 'missing' };
        if (args.includes('fetch')) {
          return new Promise<never>((_resolve, reject) => {
            if (options?.signal?.aborted) reject(options.signal.reason);
            else
              options?.signal?.addEventListener(
                'abort',
                () => reject(options.signal?.reason),
                { once: true }
              );
          });
        }
        return { code: 0, stdout: '', stderr: '' };
      }
    );
    const repos = new RepoService({
      fileSystem,
      profiles: {
        getCurrentProfile: () => profileId,
      } as unknown as ProfileManager,
      run: run as typeof runCommand,
      materializationTimeoutMs: 5,
    });

    await expect(
      repos.ensureVersion(profileId, url, testCommit)
    ).rejects.toThrow(/timed out/i);
    const entries = await fs.readdir(versions.groupDir(url));
    expect(entries.filter((entry) => entry.startsWith('tmp-'))).toEqual([]);
    expect(
      run.mock.calls.some(
        (call) => (call[2] as { signal?: AbortSignal } | undefined)?.signal
      )
    ).toBe(true);
  });

  it('aborts materialization when the caller cancels its job signal', async () => {
    const home = await temp('ignite-version-home-');
    const url = 'file:///cancelled/repo';
    FileSystem.resetInstance();
    const fileSystem = FileSystem.getInstance(home);
    const versions = new VersionStore(fileSystem);
    await versions.approveOrigins(profileId, [url]);
    const controller = new AbortController();
    const run = vi.fn(
      async (
        _command: string,
        args: string[],
        options?: { signal?: AbortSignal }
      ) => {
        if (args.includes('rev-parse'))
          return { code: 1, stdout: '', stderr: 'missing' };
        if (args.includes('fetch')) {
          return new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true }
            );
          });
        }
        return { code: 0, stdout: '', stderr: '' };
      }
    );
    const repos = new RepoService({
      fileSystem,
      profiles: {
        getCurrentProfile: () => profileId,
      } as unknown as ProfileManager,
      run: run as typeof runCommand,
    });

    const materializing = repos.ensureVersion(profileId, url, testCommit, {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(run.mock.calls.some((call) => call[1].includes('fetch'))).toBe(true)
    );
    controller.abort(new Error('job cancelled'));

    await expect(materializing).rejects.toThrow('job cancelled');
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

  it('resets tracked mutations in a version checkout while preserving untracked outputs', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos } = await approved(home, remote.remote);
    const { checkout } = await repos.ensureVersion(
      profileId,
      remote.remote,
      remote.first
    );

    await fs.writeFile(path.join(checkout, 'tracked.txt'), 'mutated\n');
    await fs.writeFile(path.join(checkout, 'build.out'), 'keep\n');
    await repos.assertPinnedIntegrity(checkout, remote.first);

    await expect(
      fs.readFile(path.join(checkout, 'tracked.txt'), 'utf8')
    ).resolves.toBe('one\n');
    await expect(
      fs.readFile(path.join(checkout, 'build.out'), 'utf8')
    ).resolves.toBe('keep\n');
  });

  it('keeps each version’s submodule URL and content isolated (including quiet integrity probes)', async () => {
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

  it('does not opt network-origin groups into file submodule transport', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const networkUrl = 'https://example.test/repo.git';
    const calls: string[][] = [];
    const run = vi.fn(async (...args: Parameters<typeof runCommand>) => {
      calls.push(args[1] as string[]);
      return runCommand(...args);
    });
    const { repos, versions } = await approved(home, networkUrl, run as typeof runCommand);
    await fs.mkdir(versions.groupDir(networkUrl), { recursive: true });
    git(versions.groupDir(networkUrl), ['clone', '--bare', remote.remote, versions.bareRepoPath(networkUrl)]);

    await repos.ensureVersion(profileId, networkUrl, remote.first);
    const submoduleUpdate = calls.find((args) =>
      args.includes('submodule') && args.includes('update')
    );
    expect(submoduleUpdate).toBeDefined();
    expect(submoduleUpdate).not.toContain('protocol.file.allow=always');
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

  it('repairs a missing fast-path registry record and merges a new ref label', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos, versions } = await approved(home, remote.remote);
    await repos.ensureVersion(profileId, remote.remote, remote.first);
    await versions.remove(remote.remote, remote.first);

    await repos.ensureVersion(profileId, remote.remote, remote.first, {
      refLabel: 'v1.2.3',
      refKind: 'tag',
    });
    expect(await versions.get(remote.remote, remote.first)).toMatchObject({
      url: remote.remote,
      commit: remote.first,
      refLabel: 'v1.2.3',
      refKind: 'tag',
      createdAt: expect.any(String),
      lastUsedAt: expect.any(String),
    });
  });

  it('records opts.ref as the ref label on the fast path', async () => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos, versions } = await approved(home, remote.remote);
    await repos.ensureVersion(profileId, remote.remote, remote.first);

    await repos.ensureVersion(profileId, remote.remote, remote.first, {
      ref: 'release/v4',
    });

    expect(await versions.get(remote.remote, remote.first)).toMatchObject({
      refLabel: 'release/v4',
    });
  });

  it('does not count an ancestor fetched through a moved ref as ref-stage success', async () => {
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
    expect(fetches[1]).toEqual(
      expect.arrayContaining(['fetch', 'origin', remote.first])
    );
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

  it.each(['v1.2.3', 'release/v4'])('accepts normal tag and branch ref %s', async (ref) => {
    const remote = await sourceRepo();
    const home = await temp('ignite-version-home-');
    const { repos } = await approved(home, remote.remote);

    await expect(
      repos.ensureVersion(profileId, remote.remote, remote.first, { ref })
    ).resolves.toMatchObject({ checkout: expect.any(String) });
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
