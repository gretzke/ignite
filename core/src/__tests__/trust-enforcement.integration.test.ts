import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import {
  ContainerOrchestrator,
  ContainerLifecycle,
} from '../plugins/containers/ContainerOrchestrator.js';
import {
  NATIVE_GRANT,
  UNTRUSTED_GRANT,
} from '../plugins/trust/TrustManager.js';

const docker = new Docker();
const IMAGE = 'alpine:3.20';

async function dockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

const available = await dockerAvailable();
if (available) {
  // One small pull, reused by both tests.
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (doneErr: Error | null) =>
        doneErr ? reject(doneErr) : resolve()
      );
    });
  });
}

describe.skipIf(!available)('trust enforcement (Docker)', () => {
  const created: string[] = [];

  afterAll(async () => {
    for (const name of created) {
      try {
        const c = docker.getContainer(name);
        await c.remove({ force: true });
      } catch {
        // Ephemeral containers auto-remove; ignore.
      }
    }
  });

  async function createAndInspect(grant: typeof NATIVE_GRANT, name: string) {
    created.push(name);
    await ContainerOrchestrator.getInstance().createContainer({
      image: IMAGE,
      name,
      lifecycle: ContainerLifecycle.PERSISTENT,
      cmd: ['sleep', '30'],
      grant,
    });
    return docker.getContainer(name).inspect();
  }

  it('untrusted grant produces NetworkMode none', async () => {
    const info = await createAndInspect(
      UNTRUSTED_GRANT,
      'ignite-test-untrusted'
    );
    expect(info.HostConfig.NetworkMode).toBe('none');
    // The container genuinely has no interfaces beyond loopback.
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual(['none']);
  }, 60_000);

  it('native grant produces bridge networking', async () => {
    const info = await createAndInspect(NATIVE_GRANT, 'ignite-test-native');
    expect(info.HostConfig.NetworkMode).toBe('bridge');
  }, 60_000);
});
