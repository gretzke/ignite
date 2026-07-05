// End-to-end verification of the third-party plugin runtime (Spec A):
// build+install a plugin from a local folder via the real PluginInstaller +
// LocalFolderBuildBackend, then drive execution through PluginExecutor to
// prove the permission gate and (when the environment allows) a real
// self-contained-image compile.
import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileSystem } from '../filesystem/FileSystem.js';
import { PluginInstaller } from '../plugins/install/PluginInstaller.js';
import { LocalFolderBuildBackend } from '../plugins/install/LocalFolderBuildBackend.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { PluginOrchestrator } from '../plugins/containers/PluginOrchestrator.js';
import { TrustManager } from '../plugins/trust/TrustManager.js';
import {
  RepoContainerUtils,
  RepoContainerKind,
} from '../plugins/utils/RepoContainerUtils.js';

const execFileAsync = promisify(execFile);
const docker = new Docker();
const PLUGINS_DIR = path.resolve(__dirname, '../../../plugins');

// Sandbox the ignite home to a temp dir BEFORE any singleton is constructed.
// TrustManager/PluginManager/PluginExecutor capture
// FileSystem.getInstance().getIgniteHome() at construction time, and those
// singletons are first built inside the `it` below — so pinning a custom home
// at module scope guarantees the registry/trust JSON never touch the real
// ~/.ignite. This keeps state (esp. the stub's trusted/hostWrite grant) out
// of the developer's real Ignite install, so an interrupted run that skips
// afterAll can't poison the next run's PERMISSION_REQUIRED assertion. It only
// redirects the JSON stores; Docker containers/images are global, so the real
// compile path (local-repo init → repo container → VolumesFrom) is unaffected.
const IGNITE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-e2e-'));
FileSystem.getInstance(IGNITE_HOME);

async function dockerAndBaseReady(): Promise<boolean> {
  try {
    await docker.ping();
    await docker.getImage('ignite/shared:latest').inspect();
    await docker.getImage('ignite/base_repo-manager:latest').inspect();
    return true;
  } catch {
    return false;
  }
}

const ready = await dockerAndBaseReady();

describe.skipIf(!ready)('third-party plugin runtime (Docker)', () => {
  const installer = new PluginInstaller(new LocalFolderBuildBackend());
  const stubSource = {
    kind: 'local' as const,
    contextDir: PLUGINS_DIR,
    dockerfile: 'examples/stub-compiler/Dockerfile',
  };

  let workspace: string | undefined;
  let repoContainerName: string | undefined;

  afterAll(async () => {
    try {
      await installer.uninstall('stub-compiler');
    } catch {
      /* best effort */
    }
    if (repoContainerName) {
      try {
        await docker.getContainer(repoContainerName).remove({ force: true });
      } catch {
        /* best effort */
      }
    }
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('installs the stub, resolves it non-native, gates compile, then runs after approval', async () => {
    const meta = await installer.install(stubSource);
    expect(meta.id).toBe('stub-compiler');

    // Untrusted by default → compile is denied with PERMISSION_REQUIRED, and
    // no container is created. This is the core guarantee under test.
    const denied = await PluginExecutor.getInstance().execute(
      'stub-compiler',
      'compile',
      { pathOrUrl: os.tmpdir() }
    );
    expect(denied.success).toBe(false);
    if (!denied.success) {
      expect(denied.error.code).toBe('PERMISSION_REQUIRED');
      expect(denied.error.details).toMatchObject({
        pluginId: 'stub-compiler',
        permission: 'hostWrite',
      });
    }

    // Approve hostWrite.
    await TrustManager.getInstance().setTrust('stub-compiler', 'trusted', {
      hostWrite: true,
      net: false,
    });

    // Full path (base_repo-manager is present, so we exercise it rather than
    // falling back to a gate-only assertion): stand up a real repo container
    // via the native `local-repo` plugin's `init` operation — the same
    // operation the frontend triggers when a repo is first opened — so the
    // ephemeral compiler container has a persistent container to
    // VolumesFrom, matching how compiles work in production.
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-ws-'));
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });

    repoContainerName = await RepoContainerUtils.deriveRepoContainerName(
      RepoContainerKind.LOCAL,
      workspace,
      false
    );

    const initResult = await PluginOrchestrator.getInstance().executePlugin(
      'local-repo',
      'init',
      { pathOrUrl: workspace }
    );
    expect(initResult.success).toBe(true);

    // Now the compile runs from the self-contained image, with hostWrite
    // approved, against the real repo container's shared volume.
    const ok = await PluginExecutor.getInstance().execute(
      'stub-compiler',
      'compile',
      { pathOrUrl: workspace }
    );
    expect(ok.success).toBe(true);

    // Prove hostWrite actually happened: the stub's compile() wrote a marker
    // into /workspace, which is bind-mounted from the host workspace dir.
    const marker = await fs.readFile(
      path.join(workspace, '.stub-compiler-ran'),
      'utf8'
    );
    expect(marker.trim().length).toBeGreaterThan(0);

    // The run created the per-plugin cache volume, and the stub bumped its
    // counter in /cache, mirroring the value into the workspace.
    const cacheVolumeName = 'ignite-plugin-cache-stub-compiler';
    await expect(
      docker.getVolume(cacheVolumeName).inspect()
    ).resolves.toBeTruthy();
    const readCount = () =>
      fs.readFile(path.join(workspace!, '.stub-compiler-cache-count'), 'utf8');
    expect((await readCount()).trim()).toBe('1');

    // A second compile runs in a brand-new ephemeral container; the counter
    // reaching 2 proves /cache persisted across containers.
    const again = await PluginExecutor.getInstance().execute(
      'stub-compiler',
      'compile',
      { pathOrUrl: workspace }
    );
    expect(again.success).toBe(true);
    expect((await readCount()).trim()).toBe('2');

    // Uninstall removes the cache volume so a future reinstall of the same id
    // starts from a clean slate (mirrors the no-inherited-trust rule).
    await installer.uninstall('stub-compiler');
    await expect(docker.getVolume(cacheVolumeName).inspect()).rejects.toThrow();
  }, 240_000);
});
