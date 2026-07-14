import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('rejects mutating repo verbs for pinned worktrees', async () => {
    const home = await temp('ignite-pinned-home-'); const { store, repos } = await service(home); const remote = await fixture(); await store.approveOrigins(profileId, [remote.remote]);
    const clone = await repos.ensurePinnedClone(profileId, remote.remote, remote.second);
    for (const result of [await repos.checkoutBranch(clone.path, 'main'), await repos.checkoutCommit(clone.path, remote.first), await repos.pullChanges(clone.path), await repos.reset(clone.path)]) {
      expect(result).toMatchObject({ success: false, error: { code: 'PINNED_REPO_READ_ONLY' } });
    }
  });
});
