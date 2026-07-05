import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { PluginInstaller } from '../../plugins/install/PluginInstaller.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
} from '../../plugins/install/types.js';

const waffleMeta: PluginMetadata = {
  id: 'waffle',
  type: PluginType.COMPILER,
  name: 'Waffle',
  version: '1.0.0',
  baseImage: 'ignite/installed_waffle:1.0.0',
};

function makeDeps() {
  const store: Record<string, PluginMetadata> = {};
  return {
    pluginManager: {
      addPlugin: vi.fn(async (m: PluginMetadata) => {
        store[m.id] = m;
      }),
      removePlugin: vi.fn(async (id: string) => {
        delete store[id];
      }),
      hasPlugin: vi.fn(async (id: string) => id in store),
      getPlugin: vi.fn(async (id: string) => store[id]),
    },
    loader: { isBuiltin: vi.fn(async (id: string) => id === 'foundry') },
    trust: { revoke: vi.fn(async () => {}) },
    removeImage: vi.fn(async () => {}),
    removeVolume: vi.fn(async () => {}),
    store,
  };
}

describe('PluginInstaller', () => {
  let deps: ReturnType<typeof makeDeps>;
  const backend: PluginBuildBackend = {
    buildPluginImage: vi.fn(async (): Promise<PluginBuildResult> => ({
      imageTag: 'ignite/installed_waffle:1.0.0',
      metadata: waffleMeta,
    })),
  };

  beforeEach(() => {
    deps = makeDeps();
    vi.clearAllMocks();
  });

  it('builds, then registers the plugin with baseImage set to the built tag', async () => {
    const installer = new PluginInstaller(backend, deps);
    const meta = await installer.install({
      kind: 'local',
      contextDir: '/src/waffle',
    });
    expect(backend.buildPluginImage).toHaveBeenCalledWith({
      kind: 'local',
      contextDir: '/src/waffle',
    });
    expect(meta.baseImage).toBe('ignite/installed_waffle:1.0.0');
    expect(deps.pluginManager.addPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'waffle',
        baseImage: 'ignite/installed_waffle:1.0.0',
      })
    );
  });

  it('refuses to install over a built-in id, and removes the built image', async () => {
    const clash: PluginBuildBackend = {
      buildPluginImage: async () => ({
        imageTag: 'x',
        metadata: { ...waffleMeta, id: 'foundry' },
      }),
    };
    const installer = new PluginInstaller(clash, deps);
    await expect(
      installer.install({ kind: 'local', contextDir: '/src/foundry' })
    ).rejects.toThrow(/built-in/i);
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith('x');
  });

  it('refuses to reinstall over an already-installed id, and removes the built image (no inherited trust grant)', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install({ kind: 'local', contextDir: '/src/waffle' });
    deps.removeImage.mockClear();

    await expect(
      installer.install({ kind: 'local', contextDir: '/src/waffle' })
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_CONFLICT' });
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_waffle:1.0.0'
    );
    // Original registration untouched.
    expect(deps.store.waffle).toEqual(
      expect.objectContaining({ baseImage: 'ignite/installed_waffle:1.0.0' })
    );
  });

  it('rejects installing a repo-manager-typed plugin (PLUGIN_INSTALL_INVALID), removes the image, and does not persist it', async () => {
    const repoManagerBackend: PluginBuildBackend = {
      buildPluginImage: async () => ({
        imageTag: 'ignite/installed_evilrepo:1.0.0',
        metadata: {
          ...waffleMeta,
          id: 'evilrepo',
          type: PluginType.REPO_MANAGER,
        },
      }),
    };
    const installer = new PluginInstaller(repoManagerBackend, deps);
    await expect(
      installer.install({ kind: 'local', contextDir: '/src/evilrepo' })
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_INVALID' });
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_evilrepo:1.0.0'
    );
  });

  it('rejects installing metadata with an invalid id (PLUGIN_INSTALL_INVALID)', async () => {
    const badIdBackend: PluginBuildBackend = {
      buildPluginImage: async () => ({
        imageTag: 'ignite/installed_bad:1.0.0',
        metadata: { ...waffleMeta, id: 'Foo/Bar' },
      }),
    };
    const installer = new PluginInstaller(badIdBackend, deps);
    await expect(
      installer.install({ kind: 'local', contextDir: '/src/bad' })
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_INVALID' });
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith('ignite/installed_bad:1.0.0');
  });

  it('uninstall removes registry entry, revokes trust, and removes the image and cache volume', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install({ kind: 'local', contextDir: '/src/waffle' });
    await installer.uninstall('waffle');
    expect(deps.pluginManager.removePlugin).toHaveBeenCalledWith('waffle');
    expect(deps.trust.revoke).toHaveBeenCalledWith('waffle');
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_waffle:1.0.0'
    );
    expect(deps.removeVolume).toHaveBeenCalledWith(
      'ignite-plugin-cache-waffle'
    );
  });

  it('uninstall revokes trust before removing the registry entry (fail-closed ordering)', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install({ kind: 'local', contextDir: '/src/waffle' });
    await installer.uninstall('waffle');

    const revokeOrder = deps.trust.revoke.mock.invocationCallOrder[0];
    const removePluginOrder =
      deps.pluginManager.removePlugin.mock.invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(removePluginOrder);
  });

  it('refuses to uninstall a built-in id', async () => {
    const installer = new PluginInstaller(backend, deps);
    await expect(installer.uninstall('foundry')).rejects.toThrow(/built-in/i);
  });
});
