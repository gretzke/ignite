import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RepoService } from '../../repos/RepoService.js';
import type { FileSystem } from '../../filesystem/FileSystem.js';
import type { ProfileManager } from '../../filesystem/ProfileManager.js';

const dirs: string[] = [];
async function temp(prefix: string): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; }
async function workspace(): Promise<{ root: string; repos: RepoService }> {
  const root = await temp('ignite-write-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const repos = new RepoService({ fileSystem: { getReposPath: () => '/unused' } as unknown as FileSystem, profiles: { getCurrentProfile: () => 'p1' } as unknown as ProfileManager });
  return { root, repos };
}
beforeAll(() => { execFileSync('git', ['--version']); });
afterAll(async () => { await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('writeRepoFile', () => {
  it.each(['../escape', 'a/../escape', '.hidden/file', 'a//file'] as const)('rejects unsafe path %s', async (relPath) => {
    const { root, repos } = await workspace();
    await expect(repos.writeRepoFile(root, relPath, 'no')).resolves.toMatchObject({ success: false, error: { code: expect.stringMatching(/PATH/) } });
  });
  it('creates nested files atomically and overwrites regular files', async () => {
    const { root, repos } = await workspace();
    await expect(repos.writeRepoFile(root, 'ignite/workflows/a.json', '{"a":1}\n')).resolves.toEqual({ success: true, data: null });
    await expect(repos.writeRepoFile(root, 'ignite/workflows/a.json', '{"a":2}\n')).resolves.toEqual({ success: true, data: null });
    await expect(fs.readFile(path.join(root, 'ignite/workflows/a.json'), 'utf8')).resolves.toBe('{"a":2}\n');
  });
  it('rejects symlinked ancestors and leaf targets', async () => {
    const { root, repos } = await workspace(); const outside = await temp('ignite-write-outside-');
    await fs.symlink(outside, path.join(root, 'linked'));
    await expect(repos.writeRepoFile(root, 'linked/escape.txt', 'no')).resolves.toMatchObject({ success: false, error: { code: 'SUSPICIOUS_PATH_PATTERN' } });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret'); await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leaf'));
    await expect(repos.writeRepoFile(root, 'leaf', 'no')).resolves.toMatchObject({ success: false, error: { code: 'SUSPICIOUS_PATH_PATTERN' } });
  });
  it('serializes concurrent writes to one canonical root without temp-file leaks', async () => {
    const { root, repos } = await workspace();
    await Promise.all(Array.from({ length: 20 }, (_, index) => repos.writeRepoFile(root, 'ignite/out.txt', `${index}`)));
    const value = await fs.readFile(path.join(root, 'ignite/out.txt'), 'utf8');
    expect(Number(value)).toBeGreaterThanOrEqual(0); expect(Number(value)).toBeLessThan(20);
    const entries = await fs.readdir(path.join(root, 'ignite'));
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });
});
