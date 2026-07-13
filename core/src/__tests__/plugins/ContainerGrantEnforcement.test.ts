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
      grant,
    });
    return createContainerMock.mock.calls[0][0] as {
      HostConfig: {
        NetworkMode?: string;
      };
    };
  }

  it('denies network without permissions', async () => {
    const opts = await createWith(UNTRUSTED_GRANT);
    expect(opts.HostConfig.NetworkMode).toBe('none');
  });

  it('grants bridge network to native plugins', async () => {
    const opts = await createWith(NATIVE_GRANT);
    expect(opts.HostConfig.NetworkMode).toBe('bridge');
  });
});

describe('ContainerOrchestrator workspaceBind grant enforcement (Phase 3)', () => {
  beforeEach(() => {
    vi.resetModules();
    createContainerMock.mockClear();
  });

  async function createWithWorkspaceBind(grant: typeof NATIVE_GRANT) {
    const { ContainerOrchestrator, ContainerLifecycle } = await import(
      '../../plugins/containers/ContainerOrchestrator.js'
    );
    await ContainerOrchestrator.getInstance().createContainer({
      image: 'ignite/test:latest',
      name: 'ignite-workspace-test',
      lifecycle: ContainerLifecycle.EPHEMERAL,
      binds: ['ignite-cache-vol:/cache'],
      workspaceBind: { hostPath: '/host/my-repo' },
      grant,
    });
    return createContainerMock.mock.calls[0][0] as {
      HostConfig: { Binds?: string[] };
    };
  }

  it('mounts the workspace read-only for an untrusted (no repoWrite) grant', async () => {
    const opts = await createWithWorkspaceBind(UNTRUSTED_GRANT);
    expect(opts.HostConfig.Binds).toEqual([
      'ignite-cache-vol:/cache',
      '/host/my-repo:/workspace:ro',
    ]);
  });

  it('mounts the workspace read-write when the grant has repoWrite', async () => {
    const opts = await createWithWorkspaceBind(NATIVE_GRANT);
    expect(opts.HostConfig.Binds).toEqual([
      'ignite-cache-vol:/cache',
      '/host/my-repo:/workspace',
    ]);
  });

  it('omits Binds entirely when neither binds nor workspaceBind is given', async () => {
    const { ContainerOrchestrator, ContainerLifecycle } = await import(
      '../../plugins/containers/ContainerOrchestrator.js'
    );
    await ContainerOrchestrator.getInstance().createContainer({
      image: 'ignite/test:latest',
      name: 'ignite-no-binds-test',
      lifecycle: ContainerLifecycle.EPHEMERAL,
      grant: NATIVE_GRANT,
    });
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { Binds?: string[] };
    };
    expect(opts.HostConfig.Binds).toBeUndefined();
  });
});

describe('missingPermission', () => {
  it('maps compile to repoWrite and verify to net', async () => {
    const { missingPermission } = await import(
      '../../plugins/containers/PluginExecutor.js'
    );
    const metadata = { types: [], operationPermissions: {} } as never;
    expect(missingPermission(metadata, 'compile', UNTRUSTED_GRANT)).toBe('repoWrite');
    expect(missingPermission(metadata, 'verify', UNTRUSTED_GRANT)).toBe('net');
    expect(missingPermission(metadata, 'compile', NATIVE_GRANT)).toBeNull();
    expect(missingPermission(metadata, 'detect', UNTRUSTED_GRANT)).toBeNull();
  });

  it('maps install to repoWrite, matching the runtime write it performs', async () => {
    // Clean compile runs install before compile (forge install / git
    // submodule writes into /workspace). Without this gate an untrusted
    // plugin's install runs, gets a :ro mount, and fails at the container
    // with a generic error instead of surfacing PERMISSION_REQUIRED.
    const { missingPermission } = await import(
      '../../plugins/containers/PluginExecutor.js'
    );
    const metadata = { types: [], operationPermissions: {} } as never;
    expect(missingPermission(metadata, 'install', UNTRUSTED_GRANT)).toBe('repoWrite');
    expect(missingPermission(metadata, 'install', NATIVE_GRANT)).toBeNull();
  });
});
