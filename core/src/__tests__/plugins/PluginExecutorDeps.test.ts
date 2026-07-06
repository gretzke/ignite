import { describe, it, expect, vi } from 'vitest';
import { PluginExecutor } from '../../plugins/containers/PluginExecutor.js';
import { PluginType } from '@ignite/plugin-types/types';

const GRANT_NONE = { trust: 'untrusted', hostWrite: false, net: false };
const GRANT_ALL = { trust: 'native', hostWrite: true, net: true };

function makeExecutor(overrides: Record<string, unknown> = {}) {
  const executeOperation = vi.fn(async () => ({ success: true, data: {} }));
  const deps = {
    registryLoader: {
      getPluginConfig: async () => ({
        metadata: {
          id: 'stub',
          type: PluginType.COMPILER,
          baseImage: 'img:latest',
        },
        requiresRepo: false,
        origin: 'builtin',
      }),
    },
    trust: { getGrant: async () => GRANT_ALL },
    containerOrchestrator: {
      createContainer: vi.fn(async (opts: { name: string }) => opts.name),
      stopContainer: vi.fn(async () => {}),
      getContainer: vi.fn(() => ({
        exec: vi.fn(async () => ({
          start: vi.fn(async () => ({
            on: (ev: string, cb: () => void) => {
              if (ev === 'end') cb();
            },
            resume: () => {},
          })),
        })),
      })),
      cleanup: vi.fn(async () => {}),
      cleanupDetached: vi.fn(),
    },
    executeOperation,
    ...overrides,
  };
  return {
    executor: new PluginExecutor(deps as never),
    deps,
    executeOperation,
  };
}

describe('PluginExecutor with injected deps', () => {
  it('denies a hostWrite operation for an ungranted plugin without touching Docker', async () => {
    const { executor, deps } = makeExecutor({
      trust: { getGrant: async () => GRANT_NONE },
    });
    const result = await executor.execute('stub', 'compile', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_REQUIRED');
    }
    expect(
      deps.containerOrchestrator.createContainer as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
  });

  it('runs an ephemeral plugin and always stops the container', async () => {
    const { executor, deps, executeOperation } = makeExecutor();
    const result = await executor.execute('stub', 'detect', {});
    expect(result.success).toBe(true);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(deps.containerOrchestrator.stopContainer).toHaveBeenCalledTimes(1);
  });

  it('threads opts.onOutput through to the injected executeOperation', async () => {
    const { executor, executeOperation } = makeExecutor();
    const onOutput = vi.fn();

    await executor.execute('stub', 'detect', {}, { onOutput });

    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(executeOperation).toHaveBeenCalledWith(
      PluginType.COMPILER,
      'stub',
      'detect',
      {},
      expect.any(String),
      'builtin',
      onOutput,
      undefined
    );
  });

  it('passes onOutput as undefined when execute is called without opts (zero behavior change)', async () => {
    const { executor, executeOperation } = makeExecutor();

    await executor.execute('stub', 'detect', {});

    expect(executeOperation).toHaveBeenCalledWith(
      PluginType.COMPILER,
      'stub',
      'detect',
      {},
      expect.any(String),
      'builtin',
      undefined,
      undefined
    );
  });

  describe('ephemeral workspace bind-mount (Phase 3)', () => {
    function makeRequiresRepoExecutor(overrides: Record<string, unknown> = {}) {
      return makeExecutor({
        registryLoader: {
          getPluginConfig: async () => ({
            metadata: {
              id: 'stub-compiler',
              type: PluginType.COMPILER,
              baseImage: 'img:latest',
            },
            requiresRepo: true,
            origin: 'builtin',
          }),
        },
        ...overrides,
      });
    }

    it('threads opts.workspacePath into createContainer as workspaceBind', async () => {
      const { executor, deps } = makeRequiresRepoExecutor();

      await executor.execute(
        'stub-compiler',
        'compile',
        { pathOrUrl: '/repo' },
        { workspacePath: '/host/workspace' }
      );

      const createContainer = deps.containerOrchestrator
        .createContainer as ReturnType<typeof vi.fn>;
      expect(createContainer).toHaveBeenCalledTimes(1);
      const call = createContainer.mock.calls[0][0];
      expect(call.workspaceBind).toEqual({ hostPath: '/host/workspace' });
      expect(call.volumesFrom).toBeUndefined();
    });

    it('rejects execute() when requiresRepo is true but no workspacePath is provided', async () => {
      const { executor } = makeRequiresRepoExecutor();

      await expect(
        executor.execute('stub-compiler', 'compile', { pathOrUrl: '/repo' })
      ).rejects.toThrow(/[Ww]orkspace path required/);
    });

    it('sets Linux User/HOME env only on process.platform === "linux"', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        const { executor, deps } = makeRequiresRepoExecutor();
        await executor.execute(
          'stub-compiler',
          'compile',
          { pathOrUrl: '/repo' },
          { workspacePath: '/host/workspace' }
        );
        const createContainer = deps.containerOrchestrator
          .createContainer as ReturnType<typeof vi.fn>;
        const call = createContainer.mock.calls[0][0];
        expect(typeof call.user).toBe('string');
        expect(call.user).toMatch(/^\d+:\d+$/);
        expect(call.env).toContain('HOME=/tmp');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('leaves User unset on non-Linux platforms (e.g. Docker Desktop)', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const { executor, deps } = makeRequiresRepoExecutor();
        await executor.execute(
          'stub-compiler',
          'compile',
          { pathOrUrl: '/repo' },
          { workspacePath: '/host/workspace' }
        );
        const createContainer = deps.containerOrchestrator
          .createContainer as ReturnType<typeof vi.fn>;
        const call = createContainer.mock.calls[0][0];
        expect(call.user).toBeUndefined();
        expect(call.env).not.toContain('HOME=/tmp');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });
});
