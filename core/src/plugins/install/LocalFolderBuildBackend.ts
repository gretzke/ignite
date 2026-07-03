import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { getLogger } from '../../utils/logger.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from './types.js';

// Timeout for reading getInfo output from the freshly-built image. A
// misbehaving or hung plugin entrypoint must not wedge the install request
// (or leak the temp container) forever.
const DESCRIBE_TIMEOUT_MS = 30_000;

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
    // Random suffix guards against same-millisecond collisions (e.g. two
    // installs firing in rapid succession in tests or automation).
    const suffix = randomBytes(4).toString('hex');
    const tempTag = `ignite/installing_${Date.now()}_${suffix}:build`;

    getLogger().info(
      `🔨 Building plugin image from ${contextDir} (${dockerfile})`
    );
    await this.dockerBuild(contextDir, dockerfile, tempTag);

    try {
      const metadata = await this.describe(tempTag);
      const imageTag = `ignite/installed_${metadata.id}:${metadata.version}`;
      await this.docker.getImage(tempTag).tag({
        repo: `ignite/installed_${metadata.id}`,
        tag: metadata.version,
      });
      return { imageTag, metadata: { ...metadata, baseImage: imageTag } };
    } finally {
      // Remove the temp build tag whether describe/tag succeeded or threw.
      await this.docker
        .getImage(tempTag)
        .remove({ force: true })
        .catch(() => {});
    }
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
    // No Tty here (unlike PluginExecutionUtils' interactive execs): every
    // installed plugin's CLI entrypoint blocks reading stdin to EOF before
    // running any operation (runPluginCLI's readStdin()). A pty stdin never
    // delivers EOF on its own, so Tty: true made this container — and thus
    // every real plugin install — hang forever. Without Tty, Docker leaves
    // stdin closed (immediate EOF) but multiplexes the log stream, so the
    // output needs the standard 8-byte frame headers stripped.
    const container = await this.docker.createContainer({
      Image: imageTag,
      Cmd: ['node', '/plugin/index.js', 'getInfo'],
      HostConfig: { AutoRemove: false, NetworkMode: 'none' },
    });
    try {
      await container.start();
      const stream = await container.logs({
        stdout: true,
        stderr: false,
        follow: true,
      });
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => chunks.push(c));

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `Timed out waiting for plugin metadata from ${imageTag} ` +
                `(getInfo did not complete within ${DESCRIBE_TIMEOUT_MS}ms)`
            )
          );
        }, DESCRIBE_TIMEOUT_MS);

        this.docker.modem.demuxStream(stream, stdout, new PassThrough());
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
        stream.on('error', (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });

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
    } finally {
      // Force-remove regardless of outcome (including timeout) so a hung or
      // failing getInfo never leaks a container.
      await container.remove({ force: true }).catch(() => {});
    }
  }
}
