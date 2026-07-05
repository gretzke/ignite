import { describe, it, expect, vi } from 'vitest';
import { PluginExecutor } from '../../plugins/containers/PluginExecutor.js';
import { RepoContainerUtils } from '../../plugins/utils/RepoContainerUtils.js';
import { PluginLifecycle } from '../../assets/PluginRegistryLoader.js';
import { PluginType } from '@ignite/plugin-types/types';

const GRANT_ALL = { trust: 'native', hostWrite: true, net: true };

function makePersistentExecutor(orchOverrides: Record<string, unknown> = {}) {
  const containerOrchestrator = {
    createContainer: vi.fn(async (opts: { name: string }) => opts.name),
    startContainer: vi.fn(async (name: string) => name),
    stopContainer: vi.fn(async () => {}),
    containerExists: vi.fn(async () => false),
    getContainer: vi.fn(),
    cleanup: vi.fn(async () => {}),
    cleanupDetached: vi.fn(),
    ...orchOverrides,
  };
  const executor = new PluginExecutor({
    containerOrchestrator: containerOrchestrator as never,
    registryLoader: {
      getPluginConfig: async () => ({
        metadata: {
          id: 'local-repo',
          type: PluginType.COMPILER, // NOT repo-manager: skips credential path
          baseImage: 'img:latest',
        },
        lifecycle: PluginLifecycle.PERSISTENT,
        requiresRepo: true,
        origin: 'builtin',
      }),
    } as never,
    trust: { getGrant: async () => GRANT_ALL } as never,
    getSSHCredentialsForContainer: async () => null,
    executeOperation: vi.fn(async () => ({ success: true, data: {} })) as never,
  });
  return { executor, containerOrchestrator };
}

describe('repo-container resolution', () => {
  it('reuses an existing persistent container instead of creating', async () => {
    const persistentName = await RepoContainerUtils.deriveRepoContainerName(
      RepoContainerUtils.deriveRepoKind('/some/repo'),
      '/some/repo',
      false
    );
    const { executor, containerOrchestrator } = makePersistentExecutor({
      containerExists: vi.fn(async (name: string) => name === persistentName),
    });
    await executor.execute('local-repo', 'info', { pathOrUrl: '/some/repo' });
    expect(containerOrchestrator.startContainer).toHaveBeenCalledWith(
      persistentName
    );
    expect(containerOrchestrator.createContainer).not.toHaveBeenCalled();
  });

  it('recovers when a concurrent request wins the create race (409)', async () => {
    const { executor, containerOrchestrator } = makePersistentExecutor({
      createContainer: vi.fn(async () => {
        const err = new Error('conflict') as Error & { statusCode: number };
        err.statusCode = 409;
        throw err;
      }),
    });
    const result = await executor.execute('local-repo', 'info', {
      pathOrUrl: '/some/repo',
    });
    expect(result.success).toBe(true);
    expect(containerOrchestrator.startContainer).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent resolution for the same repo path', async () => {
    let creations = 0;
    const created = new Set<string>();
    const { executor } = makePersistentExecutor({
      containerExists: vi.fn(async (name: string) => created.has(name)),
      createContainer: vi.fn(async (opts: { name: string }) => {
        creations += 1;
        await new Promise((r) => setImmediate(r));
        created.add(opts.name);
        return opts.name;
      }),
    });
    await Promise.all([
      executor.execute('local-repo', 'info', { pathOrUrl: '/same/repo' }),
      executor.execute('local-repo', 'info', { pathOrUrl: '/same/repo' }),
    ]);
    expect(creations).toBe(1);
  });
});
