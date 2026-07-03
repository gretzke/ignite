import { spawn } from 'node:child_process';
import Docker from 'dockerode';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from './types.js';

// Spec A backend: builds a self-contained image from a local plugin folder using
// the host Docker daemon. Acceptable only because Spec A installs our own
// fixture. Spec B replaces this with an isolated builder (same interface).
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
    const tempTag = `ignite/installing_${Date.now()}:build`;

    getLogger().info(
      `🔨 Building plugin image from ${contextDir} (${dockerfile})`
    );
    await this.dockerBuild(contextDir, dockerfile, tempTag);

    const metadata = await this.describe(tempTag);
    const imageTag = `ignite/installed_${metadata.id}:${metadata.version}`;
    await this.docker.getImage(tempTag).tag({
      repo: `ignite/installed_${metadata.id}`,
      tag: metadata.version,
    });
    await this.docker
      .getImage(tempTag)
      .remove({ force: true })
      .catch(() => {});

    return { imageTag, metadata: { ...metadata, baseImage: imageTag } };
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

  // Extract metadata by running the built image's `getInfo` operation.
  private async describe(imageTag: string): Promise<PluginMetadata> {
    // Tty: true makes Docker run the container with a pseudo-TTY, which means
    // the log stream is NOT multiplexed — there are no 8-byte stdout/stderr
    // frame headers to strip, so the raw output is clean UTF-8 and the JSON
    // regex parse below is reliable regardless of how many chunks arrive.
    const container = await this.docker.createContainer({
      Image: imageTag,
      Cmd: ['node', '/plugin/index.js', 'getInfo'],
      Tty: true,
      HostConfig: { AutoRemove: false, NetworkMode: 'none' },
    });
    await container.start();
    const stream = await container.logs({
      stdout: true,
      stderr: false,
      follow: true,
    });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve());
    });
    await container.remove({ force: true }).catch(() => {});
    // With Tty: true the output is unframed, so parse the JSON object directly.
    const text = Buffer.concat(chunks).toString('utf8');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Could not read plugin metadata from ${imageTag}`);
    }
    const parsed = JSON.parse(match[0]);
    const meta = parsed.data ?? parsed;
    if (!meta?.id || !meta?.type) {
      throw new Error(`Plugin metadata missing id/type from ${imageTag}`);
    }
    return meta as PluginMetadata;
  }
}
