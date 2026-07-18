import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { recoverRepoVersionCache } from '../../repos/startupMaintenance.js';
import { VersionStore } from '../../repos/VersionStore.js';

const homes: string[] = [];
const commit = 'a'.repeat(40);
const url = 'https://example.test/acme/repo.git';

async function home(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-startup-'));
  homes.push(value);
  FileSystem.resetInstance();
  return value;
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
  FileSystem.resetInstance();
});

describe('repository startup maintenance', () => {
  it('removes legacy pinned data for every profile, preserves approvals, and reconciles the version cache', async () => {
    const fileSystem = FileSystem.getInstance(await home());
    const profiles = ['profile-a', 'profile-b'];
    for (const profileId of profiles) {
      await fs.mkdir(
        path.join(
          fileSystem.getReposPath(profileId),
          'pinned',
          'legacy-checkout'
        ),
        { recursive: true }
      );
      await fs.mkdir(fileSystem.getProfileReposPath(profileId), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(fileSystem.getProfileReposPath(profileId), 'pinned.json'),
        JSON.stringify({ pinned: [] })
      );
      await fs.writeFile(
        fileSystem.getPinnedOriginsPath(profileId),
        JSON.stringify({
          origins: [
            {
              origin: 'https://example.test',
              approvedAt: '2026-07-18T00:00:00.000Z',
            },
          ],
        })
      );
    }

    const versions = new VersionStore(fileSystem);
    await versions.upsert({
      url,
      commit,
      createdAt: '2026-07-18T00:00:00.000Z',
      lastUsedAt: '2026-07-18T00:00:00.000Z',
    });
    const interrupted = path.join(versions.groupDir(url), 'tmp-interrupted');
    await fs.mkdir(interrupted, { recursive: true });

    await recoverRepoVersionCache(fileSystem);

    for (const profileId of profiles) {
      await expect(
        fs.access(path.join(fileSystem.getReposPath(profileId), 'pinned'))
      ).rejects.toThrow();
      await expect(
        fs.access(
          path.join(fileSystem.getProfileReposPath(profileId), 'pinned.json')
        )
      ).rejects.toThrow();
      await expect(
        fs.readFile(fileSystem.getPinnedOriginsPath(profileId), 'utf8')
      ).resolves.toContain('https://example.test');
    }
    expect(await versions.list()).toEqual([]);
    await expect(fs.access(interrupted)).rejects.toThrow();
  });
});
