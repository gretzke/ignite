import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { PluginBuildResult } from './types.js';
import { INSTALLED_PLUGIN_ENTRYPOINT } from './types.js';
import { parsePluginOutput } from '../utils/pluginTransport.js';
import { ownerLabels } from '../../system/orphanSweep.js';
import { normalizeLegacyType } from '../utils/permissionCompat.js';

// A misbehaving/hung plugin entrypoint must not wedge the install (or leak the
// temp container) forever.
const DESCRIBE_TIMEOUT_MS = 30_000;

// Pure: extract and validate the metadata JSON emitted by the image's getInfo
// operation via the shared sentinel-only parser. Accepts a bare metadata
// object or a { data: metadata } envelope; a { success: false } envelope
// surfaces the plugin's own error instead of a generic missing-id complaint.
export function parsePluginMetadata(logText: string): PluginMetadata {
  let parsed: unknown;
  try {
    parsed = parsePluginOutput(logText, '');
  } catch (error) {
    throw new Error(
      `Could not read plugin metadata from image output: ${error}`
    );
  }
  const envelope = parsed as {
    success?: boolean;
    data?: unknown;
    error?: { message?: string };
  } | null;
  if (envelope?.success === false) {
    throw new Error(
      `Plugin getInfo reported an error: ${envelope.error?.message ?? 'unknown error'}`
    );
  }
  const meta = (envelope?.data ?? parsed) as Partial<PluginMetadata> | null;
  if (
    !meta?.id ||
    (!Array.isArray(meta.types) &&
      !(meta as Partial<PluginMetadata> & { type?: unknown }).type)
  ) {
    throw new Error('Plugin metadata missing id/types in image output');
  }
  return normalizeLegacyType(meta as PluginMetadata & { type?: never });
}

// Run the built image's getInfo op and return its metadata. No Tty: installed
// plugin CLIs block reading stdin to EOF (runPluginCLI.readStdin); a pty stdin
// never delivers EOF, so Tty:true would hang forever. Without Tty the log
// stream is multiplexed, so demux it. NetworkMode 'none' — metadata read needs
// no network.
export async function describeImage(
  docker: Docker,
  imageTag: string,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS
): Promise<PluginMetadata> {
  const container = await docker.createContainer({
    Image: imageTag,
    // Labels were previously absent here, leaving a crashed-mid-describe
    // container invisible to the orphan sweep.
    Labels: ownerLabels('install'),
    Cmd: ['node', INSTALLED_PLUGIN_ENTRYPOINT, 'getInfo'],
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
              `(getInfo did not complete within ${timeoutMs}ms)`
          )
        );
      }, timeoutMs);
      docker.modem.demuxStream(stream, stdout, new PassThrough());
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

    return parsePluginMetadata(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

// Describe a freshly-built temp-tagged image, retag it to the canonical
// ignite/installed_<id>:<version>, and return the build result. Removes the
// temp tag in finally regardless of outcome.
export async function finalizeBuiltImage(
  docker: Docker,
  tempTag: string
): Promise<PluginBuildResult> {
  try {
    const metadata = await describeImage(docker, tempTag);
    const imageTag = `ignite/installed_${metadata.id}:${metadata.version}`;
    await docker
      .getImage(tempTag)
      .tag({ repo: `ignite/installed_${metadata.id}`, tag: metadata.version });
    return { imageTag, metadata: { ...metadata, baseImage: imageTag } };
  } finally {
    await docker
      .getImage(tempTag)
      .remove({ force: true })
      .catch(() => {});
  }
}
