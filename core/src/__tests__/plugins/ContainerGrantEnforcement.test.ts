import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NATIVE_GRANT,
  UNTRUSTED_GRANT,
} from '../../plugins/trust/TrustManager.js';

// Capture the options dockerode receives; the container itself is faked.
const createContainerMock = vi.fn(async (_options?: unknown) => ({
  start: vi.fn(),
}));
vi.mock('dockerode', () => ({
  default: vi.fn(() => ({ createContainer: createContainerMock })),
}));

describe('ContainerOrchestrator grant enforcement', () => {
  beforeEach(() => {
    vi.resetModules();
    createContainerMock.mockClear();
  });

  async function createWith(grant: typeof NATIVE_GRANT) {
    const { ContainerOrchestrator, ContainerLifecycle } = await import(
      '../../plugins/containers/ContainerOrchestrator.js'
    );
    await ContainerOrchestrator.getInstance().createContainer({
      image: 'ignite/test:latest',
      name: 'ignite-test',
      lifecycle: ContainerLifecycle.EPHEMERAL,
      volumesFrom: ['ignite-repo-abc'],
      grant,
    });
    return createContainerMock.mock.calls[0][0] as {
      HostConfig: {
        NetworkMode?: string;
        VolumesFrom?: string[];
      };
    };
  }

  it('denies network and downgrades volumes to read-only without permissions', async () => {
    const opts = await createWith(UNTRUSTED_GRANT);
    expect(opts.HostConfig.NetworkMode).toBe('none');
    expect(opts.HostConfig.VolumesFrom).toEqual(['ignite-repo-abc:ro']);
  });

  it('grants bridge network and read-write volumes to native plugins', async () => {
    const opts = await createWith(NATIVE_GRANT);
    expect(opts.HostConfig.NetworkMode).toBe('bridge');
    expect(opts.HostConfig.VolumesFrom).toEqual(['ignite-repo-abc']);
  });
});

describe('missingPermission', () => {
  it('maps compile to hostWrite and verify to net', async () => {
    const { missingPermission } = await import(
      '../../plugins/containers/PluginExecutor.js'
    );
    expect(missingPermission('compile', UNTRUSTED_GRANT)).toBe('hostWrite');
    expect(missingPermission('verify', UNTRUSTED_GRANT)).toBe('net');
    expect(missingPermission('compile', NATIVE_GRANT)).toBeNull();
    expect(missingPermission('detect', UNTRUSTED_GRANT)).toBeNull();
  });
});
