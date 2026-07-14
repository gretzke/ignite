import { describe, it, expect, vi } from 'vitest';
import { PluginExecutor } from '../../plugins/containers/PluginExecutor.js';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginError, ErrorCodes } from '../../types/errors.js';

const GRANT_NONE = { trust: 'untrusted', repoWrite: false, net: false };
const DEFAULT_GRANT = { trust: 'native', repoWrite: false, net: true };

function makeExecutor(overrides: Record<string, unknown> = {}) {
  const executeOperation = vi.fn(async () => ({ success: true, data: {} }));
  const deps = {
    registryLoader: {
      getPluginConfig: async () => ({
        metadata: {
          id: 'stub',
          types: [PluginType.COMPILER],
          baseImage: 'img:latest',
        },
        repoRead: false,
        origin: 'builtin',
      }),
    },
    trust: { getGrant: async () => DEFAULT_GRANT },
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
  it('denies a repoWrite operation for an ungranted plugin without touching Docker', async () => {
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

  it('stops the container when an abort terminates a hanging operation', async () => {
    const started = vi.fn();
    const { executor, deps } = makeExecutor({
      executeOperation: vi.fn(async (...args: unknown[]) => {
        const signal = args[7] as AbortSignal;
        started();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }),
    });
    const controller = new AbortController();
    const execution = executor.execute('stub', 'detect', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    controller.abort(new Error('suggestion timed out'));
    await expect(execution).resolves.toMatchObject({ success: false });
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
      undefined,
      false
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
      undefined,
      false
    );
  });

  describe('config resolution and injection (Task 6)', () => {
    it('leaves options unchanged when the plugin declares no configFields (zero behavior change)', async () => {
      const { executor, executeOperation } = makeExecutor();

      const options = { pathOrUrl: '/repo' };
      await executor.execute('stub', 'detect', options);

      expect(executeOperation).toHaveBeenCalledTimes(1);
      const calls = executeOperation.mock.calls[0] as unknown as unknown[];
      const calledOptions = calls[3];
      expect(calledOptions).toBe(options); // same reference: no config key added
      expect(calledOptions).not.toHaveProperty('config');
    });

    it('merges non-secret values and granted secrets, omitting ungranted secrets', async () => {
      const getSecret = vi.fn(async (_pluginId: string, key: string) =>
        key === 'grantedSecret' ? 'top-secret' : 'should-never-surface'
      );
      const listSecretKeys = vi.fn(async () => [
        'stub-with-config::grantedSecret',
        'stub-with-config::ungrantedSecret',
      ]);
      const getValues = vi.fn(async () => ({
        apiUrl: { global: 'https://example.com' },
      }));

      const { executor, executeOperation } = makeExecutor({
        registryLoader: {
          getPluginConfig: async () => ({
            metadata: {
              id: 'stub-with-config',
              types: [PluginType.COMPILER],
              baseImage: 'img:latest',
              configFields: [
                { key: 'apiUrl', label: 'API URL', type: 'string' },
                {
                  key: 'grantedSecret',
                  label: 'Granted Secret',
                  type: 'string',
                  secret: true,
                },
                {
                  key: 'ungrantedSecret',
                  label: 'Ungranted Secret',
                  type: 'string',
                  secret: true,
                },
              ],
            },
            repoRead: false,
            origin: 'builtin',
          }),
        },
        trust: {
          getGrant: async () => ({
            trust: 'trusted',
            repoWrite: false,
            net: false,
            secrets: ['grantedSecret'],
          }),
        },
        pluginConfigStore: { getValues },
        vaultStore: { getSecret, listSecretKeys },
      });

      await executor.execute('stub-with-config', 'detect', {});

      expect(executeOperation).toHaveBeenCalledTimes(1);
      const calls = executeOperation.mock.calls[0] as unknown as unknown[];
      const calledOptions = calls[3] as Record<string, unknown>;
      expect(calledOptions.config).toEqual({
        apiUrl: 'https://example.com',
        grantedSecret: 'top-secret',
      });
      expect(getSecret).toHaveBeenCalledWith(
        'stub-with-config',
        'grantedSecret',
        undefined
      );
      expect(getSecret).not.toHaveBeenCalledWith(
        'stub-with-config',
        'ungrantedSecret',
        undefined
      );
    });

    it('injects file field contents when granted, and omits them (never reading the file) when ungranted', async () => {
      const getFileContents = vi.fn(async (_pluginId: string, path: string) =>
        path.endsWith('.chainz.json') ? 'FILE CONTENTS' : undefined
      );
      const getValues = vi.fn(async () => ({
        'chainz-config': { global: '/home/user/.chainz.json' },
      }));

      const { executor, executeOperation } = makeExecutor({
        registryLoader: {
          getPluginConfig: async () => ({
            metadata: {
              id: 'chainz',
              types: [PluginType.RPC_PROVIDER],
              baseImage: 'img:latest',
              configFields: [
                {
                  key: 'chainz-config',
                  label: 'Chainz Config',
                  type: 'file',
                  default: '~/.chainz.json',
                },
              ],
            },
            repoRead: false,
            origin: 'builtin',
          }),
        },
        trust: {
          getGrant: async () => ({
            trust: 'trusted',
            repoWrite: false,
            net: false,
            secrets: ['chainz-config'],
          }),
        },
        pluginConfigStore: { getValues },
        getFileContents,
      });

      await executor.execute('chainz', 'detect', {});

      expect(executeOperation).toHaveBeenCalledTimes(1);
      const calls = executeOperation.mock.calls[0] as unknown as unknown[];
      const calledOptions = calls[3] as Record<string, unknown>;
      expect(calledOptions.config).toEqual({
        'chainz-config': 'FILE CONTENTS',
      });
      expect(getFileContents).toHaveBeenCalledWith(
        'chainz',
        '/home/user/.chainz.json'
      );
    });

    it('never calls getFileContents for an ungranted file field (security-critical)', async () => {
      const getFileContents = vi.fn(async () => 'this-should-never-be-read');
      const getValues = vi.fn(async () => ({
        'chainz-config': { global: '/home/user/.chainz.json' },
      }));

      const { executor, executeOperation } = makeExecutor({
        registryLoader: {
          getPluginConfig: async () => ({
            metadata: {
              id: 'chainz',
              types: [PluginType.RPC_PROVIDER],
              baseImage: 'img:latest',
              configFields: [
                {
                  key: 'chainz-config',
                  label: 'Chainz Config',
                  type: 'file',
                  default: '~/.chainz.json',
                },
              ],
            },
            repoRead: false,
            origin: 'builtin',
          }),
        },
        trust: {
          getGrant: async () => ({
            trust: 'trusted',
            repoWrite: false,
            net: false,
            secrets: [],
          }),
        },
        pluginConfigStore: { getValues },
        getFileContents,
      });

      await executor.execute('chainz', 'detect', {});

      expect(executeOperation).toHaveBeenCalledTimes(1);
      const calls = executeOperation.mock.calls[0] as unknown as unknown[];
      const calledOptions = calls[3] as Record<string, unknown>;
      expect(calledOptions.config).toEqual({});
      expect(getFileContents).not.toHaveBeenCalled();
    });

    it('rejects without ever creating a container when vault secret resolution fails', async () => {
      const vaultError = new Error('vault locked: master key unavailable');
      const getSecret = vi.fn(async () => {
        throw vaultError;
      });
      const listSecretKeys = vi.fn(async () => [
        'stub-with-config::grantedSecret',
      ]);
      const getValues = vi.fn(async () => ({}));

      const { executor, deps, executeOperation } = makeExecutor({
        registryLoader: {
          getPluginConfig: async () => ({
            metadata: {
              id: 'stub-with-config',
              types: [PluginType.COMPILER],
              baseImage: 'img:latest',
              configFields: [
                {
                  key: 'grantedSecret',
                  label: 'Granted Secret',
                  type: 'string',
                  secret: true,
                },
              ],
            },
            repoRead: false,
            origin: 'builtin',
          }),
        },
        trust: {
          getGrant: async () => ({
            trust: 'trusted',
            repoWrite: false,
            net: false,
            secrets: ['grantedSecret'],
          }),
        },
        pluginConfigStore: { getValues },
        vaultStore: { getSecret, listSecretKeys },
      });

      await expect(
        executor.execute('stub-with-config', 'detect', {})
      ).rejects.toThrow(/vault locked/);

      expect(
        deps.containerOrchestrator.createContainer as ReturnType<typeof vi.fn>
      ).not.toHaveBeenCalled();
      expect(deps.containerOrchestrator.stopContainer).not.toHaveBeenCalled();
      expect(executeOperation).not.toHaveBeenCalled();
    });
  });

  describe('ephemeral workspace bind-mount (Phase 3)', () => {
    function makeRequiresRepoExecutor(overrides: Record<string, unknown> = {}) {
      return makeExecutor({
        registryLoader: {
          getPluginConfig: async () => ({
            metadata: {
              id: 'stub-compiler',
              types: [PluginType.COMPILER],
              baseImage: 'img:latest',
            },
            repoRead: true,
            origin: 'builtin',
          }),
        },
        trust: { getGrant: async () => ({ trust: 'native', repoWrite: true, net: true }) },
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

    it.each([
      { repoRead: false, repoWrite: false, workspace: false, bind: false, writable: false },
      { repoRead: true, repoWrite: false, workspace: false, bind: false, writable: false },
      { repoRead: true, repoWrite: false, workspace: true, bind: true, writable: false },
      { repoRead: false, repoWrite: true, workspace: true, bind: true, writable: true },
    ])('enforces the operation-scoped workspace matrix: $repoRead/$repoWrite/$workspace', async ({ repoRead, repoWrite, workspace, bind, writable }) => {
      const { executor, deps } = makeExecutor({
        registryLoader: { getPluginConfig: async () => ({ metadata: { id: 'hook', types: [PluginType.DEPLOYMENT_HOOK], baseImage: 'img:latest', ...(repoWrite ? { permissions: [{ id: 'repoWrite', description: 'Write workflow outputs' }], operationPermissions: { describeDeploymentHook: 'repoWrite' } } : {}) }, repoRead, origin: 'builtin' }) },
        trust: { getGrant: async () => ({ trust: 'trusted', repoWrite, net: false }) },
      });
      await executor.execute('hook', 'describeDeploymentHook', {}, workspace ? { workspacePath: '/workflow/repo' } : undefined);
      const call = (deps.containerOrchestrator.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(Boolean(call.workspaceBind)).toBe(bind);
      expect(Boolean(call.workspaceBind) && call.grant.repoWrite).toBe(writable);
    });

    it('rejects execute() when repoRead is true but no workspacePath is provided', async () => {
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

  describe('missing installed-plugin image auto-rebuild', () => {
    const imageMissingError = () =>
      new PluginError(
        'Docker image img:latest not found. Run `npm run docker:build` to build plugin images.',
        ErrorCodes.PLUGIN_IMAGE_MISSING,
        { image: 'img:latest' }
      );

    const installedLoader = {
      getPluginConfig: async () => ({
        metadata: {
          id: 'stub',
          types: [PluginType.COMPILER],
          baseImage: 'img:latest',
        },
        repoRead: false,
        origin: 'installed',
      }),
    };

    it('rebuilds the image once and retries container creation on a missing installed image', async () => {
      let imagePresent = false;
      const createContainer = vi.fn(async (opts: { name: string }) => {
        if (!imagePresent) throw imageMissingError();
        return opts.name;
      });
      const rebuildImage = vi.fn(async () => {
        imagePresent = true;
      });
      const { executor } = makeExecutor({
        registryLoader: installedLoader,
        rebuildImage,
        containerOrchestrator: {
          createContainer,
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
      });

      const result = await executor.execute('stub', 'detect', {});

      expect(result.success).toBe(true);
      expect(rebuildImage).toHaveBeenCalledTimes(1);
      expect(rebuildImage).toHaveBeenCalledWith('stub');
      expect(createContainer).toHaveBeenCalledTimes(2);
    });

    it('returns a failure envelope (no second rebuild) when the image is still missing after the rebuild', async () => {
      const createContainer = vi.fn(async () => {
        throw imageMissingError();
      });
      const rebuildImage = vi.fn(async () => {});
      const { executor } = makeExecutor({
        registryLoader: installedLoader,
        rebuildImage,
        containerOrchestrator: {
          createContainer,
          stopContainer: vi.fn(async () => {}),
          getContainer: vi.fn(),
          cleanup: vi.fn(async () => {}),
          cleanupDetached: vi.fn(),
        },
      });

      const result = await executor.execute('stub', 'detect', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCodes.PLUGIN_REBUILD_FAILED);
        expect(result.error.message).toMatch(/img:latest.*stub/s);
      }
      expect(rebuildImage).toHaveBeenCalledTimes(1);
      expect(createContainer).toHaveBeenCalledTimes(2);
    });

    it("surfaces the rebuild's actionable error through the failure envelope when the rebuild itself fails", async () => {
      const createContainer = vi.fn(async () => {
        throw imageMissingError();
      });
      const rebuildImage = vi.fn(async () => {
        throw new PluginError(
          "Cannot rebuild plugin 'stub': its git install recorded no pinned commit. Uninstall and reinstall the plugin instead.",
          ErrorCodes.PLUGIN_REBUILD_FAILED,
          { pluginId: 'stub' }
        );
      });
      const { executor } = makeExecutor({
        registryLoader: installedLoader,
        rebuildImage,
        containerOrchestrator: {
          createContainer,
          stopContainer: vi.fn(async () => {}),
          getContainer: vi.fn(),
          cleanup: vi.fn(async () => {}),
          cleanupDetached: vi.fn(),
        },
      });

      const result = await executor.execute('stub', 'detect', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCodes.PLUGIN_REBUILD_FAILED);
        expect(result.error.message).toMatch(/no pinned commit.*reinstall/is);
      }
      expect(createContainer).toHaveBeenCalledTimes(1); // no retry after a failed rebuild
    });

    it('single-flights the rebuild across concurrent execs of the same plugin', async () => {
      let imagePresent = false;
      const createContainer = vi.fn(async (opts: { name: string }) => {
        if (!imagePresent) throw imageMissingError();
        return opts.name;
      });
      let resolveRebuild!: () => void;
      const rebuildImage = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRebuild = () => {
              imagePresent = true;
              resolve();
            };
          })
      );
      const { executor } = makeExecutor({
        registryLoader: installedLoader,
        rebuildImage,
        containerOrchestrator: {
          createContainer,
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
      });

      const inFlight = Promise.all([
        executor.execute('stub', 'detect', {}),
        executor.execute('stub', 'detect', {}),
      ]);
      // Let both execs hit the missing image and join the shared rebuild.
      await new Promise((resolve) => setImmediate(resolve));
      resolveRebuild();
      const [first, second] = await inFlight;

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(rebuildImage).toHaveBeenCalledTimes(1);
    });

    it('leaves built-in plugins on the existing docker:build error path (no rebuild attempt)', async () => {
      const rebuildImage = vi.fn(async () => {});
      const { executor } = makeExecutor({
        rebuildImage,
        containerOrchestrator: {
          createContainer: vi.fn(async () => {
            throw imageMissingError();
          }),
          stopContainer: vi.fn(async () => {}),
          getContainer: vi.fn(),
          cleanup: vi.fn(async () => {}),
          cleanupDetached: vi.fn(),
        },
      });

      await expect(executor.execute('stub', 'detect', {})).rejects.toThrow(
        /docker:build/
      );
      expect(rebuildImage).not.toHaveBeenCalled();
    });
  });
});
