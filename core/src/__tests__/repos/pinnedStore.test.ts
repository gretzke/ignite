import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { PinnedStore } from '../../repos/PinnedStore.js';
import { RepoService } from '../../repos/RepoService.js';
import { runCommand } from '../../utils/runCommand.js';
import type { ProfileManager } from '../../filesystem/ProfileManager.js';

const dirs: string[] = [];
const profileId = 'profile-1';

async function temp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
async function fixture(): Promise<{ remote: string; first: string; second: string }> {
  const source = await temp('ignite-pinned-source-');
  git(source, ['init', '-q', '-b', 'main']); git(source, ['config', 'user.email', 'test@example.com']); git(source, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(source, 'tracked.txt'), 'one\n'); git(source, ['add', '.']); git(source, ['commit', '-q', '-m', 'one']);
  const first = git(source, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(source, 'tracked.txt'), 'two\n'); git(source, ['commit', '-qam', 'two']);
  const second = git(source, ['rev-parse', 'HEAD']);
  const remote = await temp('ignite-pinned-remote-');
  git(remote, ['init', '-q', '--bare']); git(source, ['remote', 'add', 'origin', `file://${remote}`]); git(source, ['push', '-q', 'origin', 'main']);
  return { remote: `file://${remote}`, first, second };
}
async function service(home: string): Promise<{ store: PinnedStore; repos: RepoService }> {
  FileSystem.resetInstance();
  const fileSystem = FileSystem.getInstance(home);
  return { store: new PinnedStore(fileSystem), repos: new RepoService({ fileSystem, profiles: { getCurrentProfile: () => profileId } as unknown as ProfileManager }) };
}

beforeAll(() => { execFileSync('git', ['--version']); });
afterAll(async () => { await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('PinnedStore', () => {
  it('round-trips records, keeps commits separate, and persists origin approvals', async () => {
    const home = await temp('ignite-pinned-home-'); const { store } = await service(home);
    await store.upsert(profileId, { url: 'https://example.test/team/repo.git', commit: 'a'.repeat(40), refLabel: 'v1', refKind: 'tag' });
    await store.upsert(profileId, { url: 'https://example.test/team/repo.git', commit: 'b'.repeat(40) });
    expect(await store.list(profileId)).toHaveLength(2);
    await store.approveOrigins(profileId, ['https://example.test']);
    expect(await store.isOriginApproved(profileId, 'https://example.test/team/repo.git')).toBe(true);
    expect(store.worktreePath(profileId, 'https://example.test/team/repo.git', 'a'.repeat(40))).not.toBe(store.worktreePath(profileId, 'https://example.test/team/repo.git', 'b'.repeat(40)));
  });

  it('does not invoke git before first-contact origin approval', async () => {
    const home = await temp('ignite-pinned-home-'); FileSystem.resetInstance(); const fileSystem = FileSystem.getInstance(home);
    let calls = 0;
    const repos = new RepoService({ fileSystem, profiles: { getCurrentProfile: () => profileId } as unknown as ProfileManager, run: (async (...args: Parameters<typeof runCommand>) => { calls++; return runCommand(...args); }) as typeof runCommand });
    await expect(repos.ensurePinnedClone(profileId, 'file:///no/approval/repo', 'a'.repeat(40))).rejects.toMatchObject({ code: 'PINNED_ORIGIN_UNAPPROVED', origins: ['file://'] });
    expect(calls).toBe(0);
  });

  it('enforces one materialization deadline and removes the temporary worktree on abort', async () => {
    const home = await temp('ignite-pinned-home-'); FileSystem.resetInstance(); const fileSystem = FileSystem.getInstance(home); const store = new PinnedStore(fileSystem);
    const url = 'file:///deadline/repo'; await store.approveOrigins(profileId, [url]);
    const run = vi.fn(async (_cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (args.includes('rev-parse')) return { code: 1, stdout: '', stderr: 'missing' };
      if (args.includes('fetch')) return new Promise<never>((_resolve, reject) => {
        if (opts?.signal?.aborted) reject(opts.signal.reason);
        else opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
      });
      return { code: 0, stdout: '', stderr: '' };
    });
    const repos = new RepoService({ fileSystem, profiles: { getCurrentProfile: () => profileId } as unknown as ProfileManager, run: run as typeof runCommand, materializationTimeoutMs: 5 });
    await expect(repos.ensurePinnedClone(profileId, url, 'a'.repeat(40))).rejects.toThrow(/timed out/i);
    const parent = path.dirname(store.worktreePath(profileId, url, 'a'.repeat(40)));
    const entries = await fs.readdir(parent).catch(() => []);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    expect(run.mock.calls.some((call) => (call[2] as { signal?: AbortSignal } | undefined)?.signal)).toBe(true);
  });

  it('materializes a non-tip commit and auto-resets tracked mutations while keeping untracked output', async () => {
    const home = await temp('ignite-pinned-home-'); const { store, repos } = await service(home); const remote = await fixture();
    await store.approveOrigins(profileId, [remote.remote]);
    const clone = await repos.ensurePinnedClone(profileId, remote.remote, remote.first);
    expect(git(clone.path, ['rev-parse', 'HEAD'])).toBe(remote.first);
    await fs.writeFile(path.join(clone.path, 'tracked.txt'), 'mutated\n'); await fs.writeFile(path.join(clone.path, 'build.out'), 'keep\n');
    await repos.assertPinnedIntegrity(clone.path, remote.first);
    await expect(fs.readFile(path.join(clone.path, 'tracked.txt'), 'utf8')).resolves.toBe('one\n');
    await expect(fs.readFile(path.join(clone.path, 'build.out'), 'utf8')).resolves.toBe('keep\n');
    expect(await store.list(profileId)).toHaveLength(1);
  });

  it('falls back to full fetch when the shallow sha fetch fails', async () => {
    const home = await temp('ignite-pinned-home-'); FileSystem.resetInstance(); const fileSystem = FileSystem.getInstance(home); const store = new PinnedStore(fileSystem); const remote = await fixture(); await store.approveOrigins(profileId, [remote.remote]);
    let rejected = false;
    const repos = new RepoService({ fileSystem, profiles: { getCurrentProfile: () => profileId } as unknown as ProfileManager, run: (async (cmd, args, opts) => {
      if (!rejected && args.includes('fetch') && args.includes('--depth') && args.includes(remote.first)) { rejected = true; return { code: 1, stdout: '', stderr: 'simulated server refusal' }; }
      return runCommand(cmd, args, opts);
    }) as typeof runCommand });
    const clone = await repos.ensurePinnedClone(profileId, remote.remote, remote.first);
    expect(rejected).toBe(true); expect(git(clone.path, ['rev-parse', 'HEAD'])).toBe(remote.first);
  });

  it('fallback fetch includes tag-only commits unreachable from branch heads', async () => {
    const source = await temp('ignite-pinned-tag-source-');
    git(source, ['init', '-q', '-b', 'main']);
    git(source, ['config', 'user.email', 'test@example.com']);
    git(source, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(source, 'main.txt'), 'main\n');
    git(source, ['add', '.']); git(source, ['commit', '-q', '-m', 'main']);
    git(source, ['checkout', '-q', '--orphan', 'tag-side']);
    git(source, ['rm', '-q', '-rf', '.']);
    await fs.writeFile(path.join(source, 'tag-only.txt'), 'tag only\n');
    git(source, ['add', '.']); git(source, ['commit', '-q', '-m', 'tag only']);
    const tagOnlyCommit = git(source, ['rev-parse', 'HEAD']);
    git(source, ['tag', 'v-tag-only']);
    git(source, ['checkout', '-q', 'main']);
    git(source, ['branch', '-D', 'tag-side']);
    const bare = await temp('ignite-pinned-tag-remote-');
    git(bare, ['init', '-q', '--bare']);
    git(source, ['remote', 'add', 'origin', `file://${bare}`]);
    git(source, ['push', '-q', 'origin', 'main']);
    git(source, ['push', '-q', 'origin', 'refs/tags/v-tag-only']);

    const home = await temp('ignite-pinned-home-'); FileSystem.resetInstance();
    const fileSystem = FileSystem.getInstance(home); const store = new PinnedStore(fileSystem);
    const url = `file://${bare}`; await store.approveOrigins(profileId, [url]);
    let rejected = false; let sawTagsFallback = false;
    const repos = new RepoService({ fileSystem, profiles: { getCurrentProfile: () => profileId } as unknown as ProfileManager, run: (async (cmd, args, opts) => {
      if (!rejected && args.includes('fetch') && args.includes('--depth') && args.includes(tagOnlyCommit)) {
        rejected = true; return { code: 1, stdout: '', stderr: 'simulated SHA fetch refusal' };
      }
      if (args.includes('fetch') && args.includes('--tags')) sawTagsFallback = true;
      return runCommand(cmd, args, opts);
    }) as typeof runCommand });
    const clone = await repos.ensurePinnedClone(profileId, url, tagOnlyCommit);
    expect(sawTagsFallback).toBe(true);
    expect(git(clone.path, ['rev-parse', 'HEAD'])).toBe(tagOnlyCommit);
  });

  it('rejects mutating repo verbs for pinned worktrees', async () => {
    const home = await temp('ignite-pinned-home-'); const { store, repos } = await service(home); const remote = await fixture(); await store.approveOrigins(profileId, [remote.remote]);
    const clone = await repos.ensurePinnedClone(profileId, remote.remote, remote.second);
    for (const result of [await repos.checkoutBranch(clone.path, 'main'), await repos.checkoutCommit(clone.path, remote.first), await repos.pullChanges(clone.path), await repos.reset(clone.path)]) {
      expect(result).toMatchObject({ success: false, error: { code: 'PINNED_REPO_READ_ONLY' } });
    }
  });
});
