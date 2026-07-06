// Factory reset: wipe every piece of Ignite state — jobs, profiles, repos,
// clones, trust grants, installed plugins — plus the Docker resources that
// back them, then re-bootstrap in place so the running server comes back as
// a fresh installation. Built-in plugin images (ignite/shared,
// ignite/compiler_*) are build artifacts, not state, and are kept.
//
// Deliberately NOT a migration mechanism: pre-release dev environments are
// reset, not migrated. Version-to-version migrations arrive with GA.
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { JobManager } from '../jobs/JobManager.js';
import { RepoLifecycle } from '../repos/RepoLifecycle.js';
import { runCommand } from '../utils/runCommand.js';
import { getLogger } from '../utils/logger.js';

const DOCKER_TIMEOUT_MS = 15_000;

// Remove Docker resources that hold Ignite state. Best-effort and bounded:
// a wedged Docker daemon must not turn a reset into a hang.
async function cleanDockerState(): Promise<void> {
  const run = async (args: string[]): Promise<string[]> => {
    try {
      const result = await runCommand('docker', args, {
        timeoutMs: DOCKER_TIMEOUT_MS,
      });
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      getLogger().warn(`Factory reset: docker ${args[0]} failed: ${error}`);
      return [];
    }
  };

  // In-flight ephemeral containers (cancelled jobs may leave one mid-stop)
  const containers = await run([
    'ps',
    '-aq',
    '--filter',
    'name=ignite-ephemeral-',
  ]);
  if (containers.length > 0) {
    await run(['rm', '-f', ...containers]);
  }

  // Per-plugin cache volumes
  const volumes = await run([
    'volume',
    'ls',
    '-q',
    '--filter',
    'name=ignite-plugin-cache-',
  ]);
  if (volumes.length > 0) {
    await run(['volume', 'rm', '-f', ...volumes]);
  }

  // Installed third-party plugin images (ignite/installed_<id>:<version>)
  const images = await run([
    'images',
    '--format',
    '{{.Repository}}:{{.Tag}}',
    'ignite/installed_*',
  ]);
  if (images.length > 0) {
    await run(['rmi', '-f', ...images]);
  }
}

export async function factoryReset(): Promise<void> {
  getLogger().warn('🧨 Factory reset requested — wiping all Ignite state');

  // 1. Stop work: cancel every active job (abort signals kill container
  //    execs and git processes) and drop the in-memory job map so nothing
  //    re-persists into the wiped directory.
  JobManager.getInstance().cancelAllAndClear();

  // 2. Docker state.
  await cleanDockerState();

  // 3. Wipe the ignite home CONTENTS (not the directory itself — every
  //    singleton holds paths under it, and they stay valid).
  const igniteHome = FileSystem.getInstance().getIgniteHome();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: fixed ignite home dir
  const entries = await fs.readdir(igniteHome).catch(() => [] as string[]);
  for (const entry of entries) {
    await fs
      .rm(path.join(igniteHome, entry), { recursive: true, force: true })
      .catch((error) => {
        getLogger().warn(`Factory reset: failed to remove ${entry}: ${error}`);
      });
  }

  // 4. Re-bootstrap in place: a fresh ProfileManager initialization
  //    recreates config.json and the default profile; the lifecycle
  //    forgets swept profiles/session state so the next trigger sweeps
  //    like a first run.
  ProfileManager.resetInstance();
  await ProfileManager.getInstance();
  RepoLifecycle.getInstance().resetState();

  getLogger().warn('🧨 Factory reset complete — fresh installation state');
}
