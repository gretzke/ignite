import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystem } from '../filesystem/FileSystem.js';
import { VersionStore } from './VersionStore.js';

// Legacy pinned clones were disposable. Sweep them before recovering jobs so
// every startup sees only the shared version cache; pinnedOrigins.json remains
// the per-profile approval registry for VersionStore.
export async function recoverRepoVersionCache(
  fileSystem: FileSystem = FileSystem.getInstance()
): Promise<void> {
  for (const profileId of await fileSystem.listProfiles()) {
    await fs.rm(path.join(fileSystem.getReposPath(profileId), 'pinned'), {
      recursive: true,
      force: true,
    });
    await fs.rm(
      path.join(fileSystem.getProfileReposPath(profileId), 'pinned.json'),
      { force: true }
    );
  }

  await new VersionStore(fileSystem).reconcile();
}
