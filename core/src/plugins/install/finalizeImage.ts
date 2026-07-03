import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { PluginBuildResult } from './types.js';

// A misbehaving/hung plugin entrypoint must not wedge the install (or leak the
// temp container) forever.
const DESCRIBE_TIMEOUT_MS = 30_000;

// Pure: extract and validate the metadata JSON emitted by the image's getInfo
// operation. Accepts a bare metadata object or a { data: metadata } envelope.
export function parsePluginMetadata(logText: string): PluginMetadata {
  const match = logText.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Could not read plugin metadata from image output');
  }
  const parsed = JSON.parse(match[0]);
  const meta = parsed.data ?? parsed;
  if (!meta?.id || !meta?.type) {
    throw new Error('Plugin metadata missing id/type in image output');
  }
  return meta as PluginMetadata;
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
    await docker.getImage(tempTag).remove({ force: true }).catch(() => {});
  }
}
