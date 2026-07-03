import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from './types.js';
import { finalizeBuiltImage } from './finalizeImage.js';

// Spec A backend: builds a self-contained image from a local plugin folder using
// the host Docker daemon. Acceptable only because Spec A installs our own
// fixture. Spec B's GitSourceBuildBackend replaces this with an isolated builder.
export class LocalFolderBuildBackend implements PluginBuildBackend {
  private docker = new Docker();

  async buildPluginImage(
    source: PluginInstallSource
  ): Promise<PluginBuildResult> {
    if (source.kind !== 'local') {
      throw new Error(
        `LocalFolderBuildBackend cannot handle source kind '${source.kind}'`
      );
    }
    const contextDir = source.contextDir;
    const dockerfile = source.dockerfile ?? 'Dockerfile';
    // Random suffix guards against same-millisecond collisions (e.g. two
    // installs firing in rapid succession in tests or automation).
    const suffix = randomBytes(4).toString('hex');
    const tempTag = `ignite/installing_${Date.now()}_${suffix}:build`;

    getLogger().info(
      `🔨 Building plugin image from ${contextDir} (${dockerfile})`
    );
    await this.dockerBuild(contextDir, dockerfile, tempTag);
    return finalizeBuiltImage(this.docker, tempTag);
  }

  // Build via the `docker` CLI. Chosen over dockerode's tar-stream build
  // (which needs `tar-fs`) because `tar-fs` has no published type
  // declarations and is only a transitive/phantom dependency here via
  // dockerode; shelling out to the CLI keeps this backend dependency-free
  // and type-safe. Spec A only builds our own fixture, so trusting the
  // locally-installed `docker` binary is acceptable.
  private dockerBuild(
    contextDir: string,
    dockerfile: string,
    tag: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        ['build', '-f', dockerfile, '-t', tag, contextDir],
        { cwd: contextDir, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        getLogger().debug(`🔨 docker build: ${chunk.toString('utf8').trim()}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `docker build failed (exit ${code}) for ${contextDir}: ${stderr.trim()}`
            )
          );
        }
      });
    });
  }
}
