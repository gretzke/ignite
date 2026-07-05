import { describe, it, expect, vi } from 'vitest';
import { PluginExecutor } from '../../plugins/containers/PluginExecutor.js';
import { PluginLifecycle } from '../../assets/PluginRegistryLoader.js';
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
        lifecycle: PluginLifecycle.EPHEMERAL,
        requiresRepo: false,
        origin: 'builtin',
      }),
    },
    trust: { getGrant: async () => GRANT_ALL },
    containerOrchestrator: {
      createContainer: vi.fn(async (opts: { name: string }) => opts.name),
      startContainer: vi.fn(async (name: string) => name),
      stopContainer: vi.fn(async () => {}),
      containerExists: vi.fn(async () => false),
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
    getSSHCredentialsForContainer: vi.fn(async () => null),
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

  it('never injects git credentials for non-builtin plugins', async () => {
    const { executor, deps } = makeExecutor({
      registryLoader: {
        getPluginConfig: async () => ({
          metadata: {
            id: 'thirdparty',
            type: PluginType.REPO_MANAGER,
            baseImage: 'img:latest',
          },
          lifecycle: PluginLifecycle.PERSISTENT,
          requiresRepo: true,
          origin: 'installed',
        }),
      },
    });
    await executor
      .execute('thirdparty', 'info', { pathOrUrl: '/repo' })
      .catch(() => {});
    expect(deps.getSSHCredentialsForContainer).not.toHaveBeenCalled();
  });
});
