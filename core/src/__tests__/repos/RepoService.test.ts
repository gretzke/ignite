// RepoService: host-side git operations. Every behavior is exercised against
// REAL git repos in temp dirs (git init/commit, file:// remotes for
// clone/fetch/upstream) — no Docker, no network, no mocked git.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RepoService, RepoKind, deriveRepoKind } from '../../repos/RepoService.js';
import { runCommand } from '../../utils/runCommand.js';
import type { FileSystem } from '../../filesystem/FileSystem.js';
import type { ProfileManager } from '../../filesystem/ProfileManager.js';

// === Fixture helpers ===

const tmpDirs: string[] = [];

async function mkTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await writeFile(dir, 'README.md', 'hello\n');
  commitAll(dir, 'init');
}

// A repo with two branches (main, feature) so clone/fetch tests can assert
// remote-tracking refs show up for a branch that isn't the default.
async function initRemoteWithBranches(): Promise<string> {
  const dir = await mkTmp('ignite-remote-');
  await initRepo(dir);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  await writeFile(dir, 'feature.txt', 'feature\n');
  commitAll(dir, 'feature commit');
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

// deriveRepoKind classifies file:// as LOCAL (a local path expressed as a
// URI, not a remote to fetch) — see RepoService.ts, copied verbatim from
// RepoContainerUtils. So a CLONED-kind fixture can't use a literal file://
// pathOrUrl; it needs a form deriveRepoKind classifies as CLONED (scp-like
// git@host:path) whose actual git transport is still file://-local and
// network-free. `url.<target>.insteadOf` rewrites the URL at the git-config
// layer, before any transport is chosen, so the *only* thing that differs
// from production is which transport a fixed URL resolves to — RepoService
// never knows or cares.
function scpLikeCloneSource(remoteDir: string): string {
  return `git@ignite-test-host:ignite-tests/${path.basename(remoteDir)}.git`;
}

async function withFileInsteadOf<T>(
  url: string,
  remoteDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const configDir = await mkTmp('ignite-gitconfig-');
  const configPath = path.join(configDir, 'gitconfig');
  await fs.writeFile(configPath, `[url "file://${remoteDir}"]\n\tinsteadOf = ${url}\n`);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }
}

function fakeFileSystem(reposRoot: string): FileSystem {
  return {
    getReposPath: (profileId: string) => path.join(reposRoot, profileId),
  } as unknown as FileSystem;
}

function fakeProfiles(profileId: string): ProfileManager {
  return { getCurrentProfile: () => profileId } as unknown as ProfileManager;
}

function makeRunSpy(): {
  spy: typeof runCommand;
  calls: { cmd: string; args: string[]; opts: Parameters<typeof runCommand>[2] }[];
} {
  const calls: { cmd: string; args: string[]; opts: Parameters<typeof runCommand>[2] }[] = [];
  const spy = ((cmd: string, args: string[], opts?: Parameters<typeof runCommand>[2]) => {
    calls.push({ cmd, args, opts });
    return runCommand(cmd, args, opts);
  }) as typeof runCommand;
  return { spy, calls };
}

async function newService(opts?: {
  reposRoot?: string;
  profileId?: string;
  run?: typeof runCommand;
}): Promise<RepoService> {
  const reposRoot = opts?.reposRoot ?? (await mkTmp('ignite-repos-'));
  return new RepoService({
    fileSystem: fakeFileSystem(reposRoot),
    profiles: fakeProfiles(opts?.profileId ?? 'p1'),
    run: opts?.run,
  });
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

// Skip the whole suite if git isn't on PATH (shouldn't happen in CI/dev, but
// fail loudly rather than silently passing with zero assertions).
beforeAll(() => {
  execFileSync('git', ['--version']);
});

describe('deriveRepoKind', () => {
  it('classifies absolute and home-relative paths as LOCAL', () => {
    expect(deriveRepoKind('/Users/me/project')).toBe(RepoKind.LOCAL);
    expect(deriveRepoKind('~/project')).toBe(RepoKind.LOCAL);
  });

  it('classifies https/ssh/git/scp-like URLs as CLONED', () => {
    expect(deriveRepoKind('https://github.com/foo/bar.git')).toBe(RepoKind.CLONED);
    expect(deriveRepoKind('git@github.com:foo/bar.git')).toBe(RepoKind.CLONED);
    expect(deriveRepoKind('ssh://git@host/foo/bar.git')).toBe(RepoKind.CLONED);
  });

  it('classifies file:// URLs as LOCAL', () => {
    expect(deriveRepoKind('file:///tmp/repo')).toBe(RepoKind.LOCAL);
  });

  it('classifies an unknown scheme with :// as CLONED (fallback)', () => {
    expect(deriveRepoKind('ext://evil.example/x')).toBe(RepoKind.CLONED);
  });
});

describe('resolveWorkspacePath', () => {
  it('LOCAL: returns pathOrUrl unchanged (identity)', async () => {
    const svc = await newService();
    const localPath = '/some/local/path';
    await expect(svc.resolveWorkspacePath(localPath)).resolves.toBe(localPath);
  });

  it('CLONED: deterministic under the repos path for a profile', async () => {
    const reposRoot = await mkTmp('ignite-repos-');
    const svc = await newService({ reposRoot, profileId: 'p1' });
    const url = 'https://github.com/foo/bar.git';
    const a = await svc.resolveWorkspacePath(url);
    const b = await svc.resolveWorkspacePath(url);
    expect(a).toBe(b);
    expect(a.startsWith(path.join(reposRoot, 'p1'))).toBe(true);
  });

  it('CLONED: separates workspaces per profile', async () => {
    const reposRoot = await mkTmp('ignite-repos-');
    const url = 'https://github.com/foo/bar.git';
    const svcA = await newService({ reposRoot, profileId: 'profile-a' });
    const svcB = await newService({ reposRoot, profileId: 'profile-b' });
    const a = await svcA.resolveWorkspacePath(url);
    const b = await svcB.resolveWorkspacePath(url);
    expect(a).not.toBe(b);
  });
});

describe('git invocation safety', () => {
  it('every git call disables hooks and sets the protocol allowlist', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const { spy, calls } = makeRunSpy();
    const svc = await newService({ run: spy });

    const result = await svc.getBranches(dir);

    expect(result.success).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.cmd).toBe('git');
      expect(call.args.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/dev/null']);
      expect(call.opts?.env?.GIT_ALLOW_PROTOCOL).toBe('https:git:ssh:file');
    }
  });
});

describe('init', () => {
  it('LOCAL: succeeds when the path is already a git repo', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const svc = await newService();
    await expect(svc.init(dir)).resolves.toEqual({ success: true, data: null });
  });

  it('LOCAL: fails with NOT_GIT_REPO when the path is not a git repo', async () => {
    const dir = await mkTmp('ignite-local-');
    const svc = await newService();
    const result = await svc.init(dir);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_GIT_REPO');
  });

  it('CLONED: rejects a disallowed URL scheme before any git invocation', async () => {
    const { spy, calls } = makeRunSpy();
    const svc = await newService({ run: spy });
    const result = await svc.init('ext://evil.example/x');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('CLONE_FAILED');
    expect(calls.length).toBe(0);
  });

  it('CLONED: clones via file:// and fetches remote heads (second branch visible)', async () => {
    const remoteDir = await initRemoteWithBranches();
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();

      const result = await svc.init(url);
      expect(result).toEqual({ success: true, data: null });

      const workspacePath = await svc.resolveWorkspacePath(url);
      expect((await fs.stat(workspacePath)).isDirectory()).toBe(true);

      const branches = await svc.getBranches(url);
      expect(branches.success).toBe(true);
      if (branches.success) {
        expect(branches.data.branches).toContain('origin/feature');
        expect(branches.data.branches).toContain('origin/main');
      }
    });
  });

  it('CLONED: is idempotent when already cloned', async () => {
    const remoteDir = await initRemoteWithBranches();
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();

      await expect(svc.init(url)).resolves.toEqual({ success: true, data: null });
      const workspacePath = await svc.resolveWorkspacePath(url);
      const infoBefore = await svc.getRepoInfo(url);

      await expect(svc.init(url)).resolves.toEqual({ success: true, data: null });
      const infoAfter = await svc.getRepoInfo(url);

      expect(infoAfter).toEqual(infoBefore);
      expect((await fs.stat(workspacePath)).isDirectory()).toBe(true);
    });
  });
});

describe('getBranches', () => {
  it('lists local, remote-tracking, and tag refs', async () => {
    const remoteDir = await initRemoteWithBranches();
    const localDir = await mkTmp('ignite-local-');
    git(localDir, ['clone', '-q', remoteDir, '.']);
    git(localDir, ['tag', 'v1.0.0']);
    const svc = await newService();

    const result = await svc.getBranches(localDir);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual(
        expect.arrayContaining(['main', 'origin/feature', 'origin/main', 'v1.0.0'])
      );
    }
  });

  it('fails with NOT_GIT_REPO for a non-repo path', async () => {
    const dir = await mkTmp('ignite-local-');
    const svc = await newService();
    const result = await svc.getBranches(dir);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_GIT_REPO');
  });
});

describe('checkoutBranch', () => {
  it('LOCAL: rejects with DIRTY_REPO when there are uncommitted changes', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    git(dir, ['checkout', '-q', '-b', 'feature']);
    git(dir, ['checkout', '-q', 'main']);
    await writeFile(dir, 'README.md', 'dirty\n');
    const svc = await newService();

    const result = await svc.checkoutBranch(dir, 'feature');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DIRTY_REPO');
  });

  it('LOCAL: checks out an existing local branch by plain name', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    git(dir, ['checkout', '-q', '-b', 'feature']);
    git(dir, ['checkout', '-q', 'main']);
    const svc = await newService();

    const result = await svc.checkoutBranch(dir, 'feature');

    expect(result).toEqual({ success: true, data: null });
    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
  });

  it('LOCAL: origin/foo with no existing local branch creates a new tracking branch', async () => {
    const remoteDir = await initRemoteWithBranches();
    const localDir = await mkTmp('ignite-local-');
    git(localDir, ['clone', '-q', remoteDir, '.']);
    git(localDir, ['config', 'user.email', 'test@example.com']);
    git(localDir, ['config', 'user.name', 'Test']);
    const svc = await newService();

    const result = await svc.checkoutBranch(localDir, 'origin/feature');

    expect(result).toEqual({ success: true, data: null });
    expect(git(localDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
  });

  it('LOCAL: origin/foo reuses an existing local branch of the same name', async () => {
    const remoteDir = await initRemoteWithBranches();
    const localDir = await mkTmp('ignite-local-');
    git(localDir, ['clone', '-q', remoteDir, '.']);
    git(localDir, ['config', 'user.email', 'test@example.com']);
    git(localDir, ['config', 'user.name', 'Test']);
    git(localDir, ['branch', 'feature']); // pre-existing local branch, no upstream
    const svc = await newService();

    const result = await svc.checkoutBranch(localDir, 'origin/feature');

    expect(result).toEqual({ success: true, data: null });
    expect(git(localDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
  });

  it('CLONED: force-resets dirty state instead of rejecting', async () => {
    const remoteDir = await initRemoteWithBranches();
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();
      await svc.init(url);
      const workspacePath = await svc.resolveWorkspacePath(url);
      await fs.writeFile(path.join(workspacePath, 'README.md'), 'dirty\n');

      const result = await svc.checkoutBranch(url, 'origin/feature');

      expect(result).toEqual({ success: true, data: null });
      expect(git(workspacePath, ['status', '--porcelain']).trim()).toBe('');
      expect(git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
    });
  });
});

describe('checkoutCommit', () => {
  it('LOCAL: detaches HEAD at the given commit (branch becomes null)', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const first = git(dir, ['rev-parse', 'HEAD']).trim();
    await writeFile(dir, 'second.txt', 'second\n');
    commitAll(dir, 'second');
    const svc = await newService();

    const result = await svc.checkoutCommit(dir, first);

    expect(result).toEqual({ success: true, data: null });
    expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(first);
    const info = await svc.getRepoInfo(dir);
    expect(info.success).toBe(true);
    if (info.success) expect(info.data.branch).toBeNull();
  });

  it('LOCAL: rejects with DIRTY_REPO on uncommitted changes', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const first = git(dir, ['rev-parse', 'HEAD']).trim();
    await writeFile(dir, 'README.md', 'dirty\n');
    const svc = await newService();

    const result = await svc.checkoutCommit(dir, first);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DIRTY_REPO');
  });

  it('CLONED: force-resets before detaching', async () => {
    const remoteDir = await initRemoteWithBranches();
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();
      await svc.init(url);
      const workspacePath = await svc.resolveWorkspacePath(url);
      const target = git(workspacePath, ['rev-parse', 'HEAD']).trim();
      await fs.writeFile(path.join(workspacePath, 'README.md'), 'dirty\n');

      const result = await svc.checkoutCommit(url, target);

      expect(result).toEqual({ success: true, data: null });
      expect(git(workspacePath, ['status', '--porcelain']).trim()).toBe('');
    });
  });
});

describe('pullChanges', () => {
  it('LOCAL: rejects when dirty', async () => {
    const remoteDir = await mkTmp('ignite-remote-');
    await initRepo(remoteDir);
    const localDir = await mkTmp('ignite-local-');
    git(localDir, ['clone', '-q', remoteDir, '.']);
    git(localDir, ['config', 'user.email', 'test@example.com']);
    git(localDir, ['config', 'user.name', 'Test']);
    await writeFile(localDir, 'README.md', 'dirty\n');
    const svc = await newService();

    const result = await svc.pullChanges(localDir);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DIRTY_REPO');
  });

  it('LOCAL: fast-forwards to the upstream commit', async () => {
    const remoteDir = await mkTmp('ignite-remote-');
    await initRepo(remoteDir);
    const localDir = await mkTmp('ignite-local-');
    git(localDir, ['clone', '-q', remoteDir, '.']);
    git(localDir, ['config', 'user.email', 'test@example.com']);
    git(localDir, ['config', 'user.name', 'Test']);
    await writeFile(remoteDir, 'more.txt', 'more\n');
    commitAll(remoteDir, 'more commit');
    const svc = await newService();

    const result = await svc.pullChanges(localDir);

    expect(result).toEqual({ success: true, data: null });
    expect(git(localDir, ['rev-parse', 'HEAD']).trim()).toBe(
      git(remoteDir, ['rev-parse', 'HEAD']).trim()
    );
  });

  it('CLONED: discards untracked byproducts before pulling', async () => {
    const remoteDir = await mkTmp('ignite-remote-');
    await initRepo(remoteDir);
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();
      await svc.init(url);
      const workspacePath = await svc.resolveWorkspacePath(url);
      await fs.writeFile(path.join(workspacePath, 'byproduct.lock'), 'stray\n');
      await writeFile(remoteDir, 'more.txt', 'more\n');
      commitAll(remoteDir, 'more commit');

      const result = await svc.pullChanges(url);

      expect(result).toEqual({ success: true, data: null });
      expect(git(workspacePath, ['rev-parse', 'HEAD']).trim()).toBe(
        git(remoteDir, ['rev-parse', 'HEAD']).trim()
      );
      await expect(fs.stat(path.join(workspacePath, 'byproduct.lock'))).rejects.toThrow();
    });
  });
});

describe('reset', () => {
  it('discards uncommitted changes and removes untracked files (LOCAL)', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    await writeFile(dir, 'README.md', 'dirty\n');
    await writeFile(dir, 'untracked.txt', 'stray\n');
    const svc = await newService();

    const result = await svc.reset(dir);

    expect(result).toEqual({ success: true, data: null });
    expect(git(dir, ['status', '--porcelain']).trim()).toBe('');
    await expect(fs.stat(path.join(dir, 'untracked.txt'))).rejects.toThrow();
  });

  it('fails with NOT_GIT_REPO for a non-repo path', async () => {
    const dir = await mkTmp('ignite-local-');
    const svc = await newService();
    const result = await svc.reset(dir);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_GIT_REPO');
  });
});

describe('getRepoInfo', () => {
  it('LOCAL: reports branch, commit, dirty=false, upToDate=true for a clean local-only repo', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const svc = await newService();

    const result = await svc.getRepoInfo(dir);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch).toBe('main');
      expect(result.data.commit).toBe(git(dir, ['rev-parse', 'HEAD']).trim());
      expect(result.data.dirty).toBe(false);
      expect(result.data.upToDate).toBe(true);
    }
  });

  it('LOCAL: dirty=true when there are uncommitted changes', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    await writeFile(dir, 'README.md', 'dirty\n');
    const svc = await newService();

    const result = await svc.getRepoInfo(dir);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.dirty).toBe(true);
  });

  it('LOCAL: branch is null when HEAD is detached', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const commit = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '--detach', commit]);
    const svc = await newService();

    const result = await svc.getRepoInfo(dir);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch).toBeNull();
      expect(result.data.commit).toBe(commit);
      expect(result.data.upToDate).toBe(true); // detached: nothing to compare, treated as up to date
    }
  });

  it('LOCAL: upToDate=false when the upstream remote has commits HEAD lacks', async () => {
    const remoteDir = await mkTmp('ignite-remote-');
    await initRepo(remoteDir);
    const localDir = await mkTmp('ignite-local-');
    git(localDir, ['clone', '-q', remoteDir, '.']);
    await writeFile(remoteDir, 'more.txt', 'more\n');
    commitAll(remoteDir, 'more commit');
    const svc = await newService();

    const result = await svc.getRepoInfo(localDir);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch).toBe('main');
      expect(result.data.upToDate).toBe(false);
    }
  });

  it('CLONED: dirty is always false, even with uncommitted changes on disk', async () => {
    const remoteDir = await initRemoteWithBranches();
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();
      await svc.init(url);
      const workspacePath = await svc.resolveWorkspacePath(url);
      await fs.writeFile(path.join(workspacePath, 'README.md'), 'dirty\n');

      const result = await svc.getRepoInfo(url);

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.dirty).toBe(false);
    });
  });
});

describe('getFile', () => {
  async function makeWorkspace(): Promise<{ dir: string; svc: RepoService }> {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    await writeFile(dir, 'nested/dir/file.txt', 'content\n');
    commitAll(dir, 'nested file');
    const svc = await newService();
    return { dir, svc };
  }

  it('reads a valid nested path', async () => {
    const { dir, svc } = await makeWorkspace();
    const result = await svc.getFile(dir, 'nested/dir/file.txt');
    expect(result).toEqual({ success: true, data: { content: 'content\n' } });
  });

  it.each([
    ['../x', 'INVALID_PATH'],
    ['.hidden/x', 'INVALID_PATH'],
    ['a//b', 'INVALID_PATH'],
    ['a/../b', 'INVALID_PATH'],
  ] as const)('rejects %s -> %s', async (badPath, expectedCode) => {
    const { dir, svc } = await makeWorkspace();
    const result = await svc.getFile(dir, badPath);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(expectedCode);
  });

  it('returns FILE_NOT_FOUND for a missing file', async () => {
    const { dir, svc } = await makeWorkspace();
    const result = await svc.getFile(dir, 'does/not/exist.txt');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('FILE_NOT_FOUND');
  });

  it('returns FILE_NOT_FOUND for a path that is a directory', async () => {
    const { dir, svc } = await makeWorkspace();
    const result = await svc.getFile(dir, 'nested');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('FILE_NOT_FOUND');
  });

  it('treats a leading slash as workspace-relative, not an absolute escape', async () => {
    const { dir, svc } = await makeWorkspace();
    // A naive path.resolve(cwd, filePath) would let '/etc/passwd' override
    // cwd entirely and read the real host file; path.join must not.
    await writeFile(dir, 'etc/passwd', 'workspace-local, not the real /etc/passwd\n');
    const result = await svc.getFile(dir, '/etc/passwd');
    expect(result).toEqual({
      success: true,
      data: { content: 'workspace-local, not the real /etc/passwd\n' },
    });
  });
});

describe('removeClone', () => {
  it('LOCAL is a no-op', async () => {
    const dir = await mkTmp('ignite-local-');
    await initRepo(dir);
    const svc = await newService();

    await svc.removeClone(dir);

    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it('CLONED deletes the workspace directory', async () => {
    const remoteDir = await initRemoteWithBranches();
    const url = scpLikeCloneSource(remoteDir);

    await withFileInsteadOf(url, remoteDir, async () => {
      const svc = await newService();
      await svc.init(url);
      const workspacePath = await svc.resolveWorkspacePath(url);
      await expect(fs.stat(workspacePath)).resolves.toBeDefined();

      await svc.removeClone(url);

      await expect(fs.stat(workspacePath)).rejects.toThrow();
    });
  });
});
