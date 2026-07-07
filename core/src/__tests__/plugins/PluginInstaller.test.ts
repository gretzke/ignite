import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type {
  PluginMetadata,
  PluginPermissionRequest,
} from '@ignite/plugin-types/types';
import { PluginInstaller } from '../../plugins/install/PluginInstaller.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from '../../plugins/install/types.js';

const waffleMeta: PluginMetadata = {
  id: 'waffle',
  type: PluginType.COMPILER,
  name: 'Waffle',
  version: '1.0.0',
  baseImage: 'ignite/installed_waffle:1.0.0',
  permissions: [
    { id: 'hostWrite', description: 'Write build artifacts to the repo.' },
  ],
};

const gitSource: PluginInstallSource = {
  kind: 'git',
  url: 'https://github.com/acme/waffle',
};

function makeDeps() {
  const store: Record<string, PluginMetadata> = {};
  const sources: Record<string, PluginInstallSource> = {};
  const grants: Record<
    string,
    { trust: 'trusted' | 'untrusted'; hostWrite: boolean; net: boolean }
  > = {};
  return {
    pluginManager: {
      addPlugin: vi.fn(
        async (m: PluginMetadata, source?: PluginInstallSource) => {
          store[m.id] = m;
          if (source) sources[m.id] = source;
        }
      ),
      removePlugin: vi.fn(async (id: string) => {
        delete store[id];
        delete sources[id];
      }),
      hasPlugin: vi.fn(async (id: string) => id in store),
      getPlugin: vi.fn(async (id: string) => store[id]),
      getInstallSource: vi.fn(async (id: string) => sources[id]),
    },
    loader: { isBuiltin: vi.fn(async (id: string) => id === 'foundry') },
    trust: {
      revoke: vi.fn(async () => {}),
      getGrant: vi.fn(async (id: string) => ({
        trust: grants[id]?.trust ?? ('untrusted' as const),
        hostWrite: grants[id]?.hostWrite ?? false,
        net: grants[id]?.net ?? false,
        secrets: [] as string[],
      })),
      setTrust: vi.fn(
        async (
          id: string,
          trust: 'trusted' | 'untrusted',
          permissions: { hostWrite: boolean; net: boolean }
        ) => {
          grants[id] = { trust, ...permissions };
        }
      ),
    },
    removeImage: vi.fn(async () => {}),
    removeVolume: vi.fn(async () => {}),
    inspectRemote: vi.fn(async () => ({
      defaultBranch: 'main',
      branches: ['main'],
      releases: [],
      github: {
        owner: 'acme',
        repo: 'waffle',
        description: 'A waffle compiler',
      },
    })),
    store,
    sources,
    grants,
  };
}

// What enrichGitSource turns the bare gitSource into with makeDeps' remote.
const enrichedGitSource = {
  kind: 'git' as const,
  url: 'https://github.com/acme/waffle',
  track: { mode: 'branch' as const, branch: 'main' },
  description: 'A waffle compiler',
};

function backendReturning(result: PluginBuildResult): PluginBuildBackend {
  return { buildPluginImage: vi.fn(async () => result) };
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

  it('builds, then registers the plugin with baseImage set to the built tag and the enriched install source recorded', async () => {
    const installer = new PluginInstaller(backend, deps);
    const meta = await installer.install(gitSource);
    // The build receives the enriched source (derived track + description).
    expect(backend.buildPluginImage).toHaveBeenCalledWith(enrichedGitSource);
    expect(meta.baseImage).toBe('ignite/installed_waffle:1.0.0');
    expect(deps.pluginManager.addPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'waffle',
        baseImage: 'ignite/installed_waffle:1.0.0',
      }),
      enrichedGitSource
    );
    expect(deps.sources.waffle).toEqual(enrichedGitSource);
  });

  it('records the built commit sha when the backend reports one', async () => {
    const shaBackend = backendReturning({
      imageTag: 'ignite/installed_waffle:1.0.0',
      metadata: waffleMeta,
      commit: 'a'.repeat(40),
    });
    const installer = new PluginInstaller(shaBackend, deps);
    await installer.install(gitSource);
    expect(deps.sources.waffle).toEqual({
      ...enrichedGitSource,
      commit: 'a'.repeat(40),
    });
  });

  it('refuses to install over a built-in id, and removes the built image', async () => {
    const clash = backendReturning({
      imageTag: 'x',
      metadata: { ...waffleMeta, id: 'foundry' },
    });
    const installer = new PluginInstaller(clash, deps);
    await expect(installer.install(gitSource)).rejects.toThrow(/built-in/i);
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith('x');
  });

  it('refuses to reinstall over an already-installed id, and removes the built image (no inherited trust grant)', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install(gitSource);
    deps.removeImage.mockClear();

    await expect(installer.install(gitSource)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_CONFLICT',
    });
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_waffle:1.0.0'
    );
    // Original registration untouched.
    expect(deps.store.waffle).toEqual(
      expect.objectContaining({ baseImage: 'ignite/installed_waffle:1.0.0' })
    );
  });

  it('rejects installing a repo-manager-typed plugin (PLUGIN_INSTALL_INVALID), removes the image, and does not persist it', async () => {
    const repoManagerBackend = backendReturning({
      imageTag: 'ignite/installed_evilrepo:1.0.0',
      metadata: {
        ...waffleMeta,
        id: 'evilrepo',
        type: PluginType.REPO_MANAGER,
      },
    });
    const installer = new PluginInstaller(repoManagerBackend, deps);
    await expect(installer.install(gitSource)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_INVALID',
    });
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_evilrepo:1.0.0'
    );
  });

  it('rejects installing metadata with an invalid id (PLUGIN_INSTALL_INVALID)', async () => {
    const badIdBackend = backendReturning({
      imageTag: 'ignite/installed_bad:1.0.0',
      metadata: { ...waffleMeta, id: 'Foo/Bar' },
    });
    const installer = new PluginInstaller(badIdBackend, deps);
    await expect(installer.install(gitSource)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_INVALID',
    });
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith('ignite/installed_bad:1.0.0');
  });

  describe('permission manifest validation', () => {
    const cases: Array<[string, unknown]> = [
      ['unknown permission id', [{ id: 'sudo', description: 'take over' }]],
      [
        'duplicate permission',
        [
          { id: 'net', description: 'a' },
          { id: 'net', description: 'b' },
        ],
      ],
      ['empty description', [{ id: 'net', description: '   ' }]],
      ['overlong description', [{ id: 'net', description: 'x'.repeat(281) }]],
      [
        'control characters in description',
        [{ id: 'net', description: `evil${String.fromCharCode(7)}text` }],
      ],
      ['non-object entry', ['net']],
      ['non-array manifest', { net: 'description' }],
    ];
    for (const [name, permissions] of cases) {
      it(`rejects ${name}`, async () => {
        const bad = backendReturning({
          imageTag: 'ignite/installed_bad:1.0.0',
          metadata: {
            ...waffleMeta,
            id: 'bad',
            permissions: permissions as PluginPermissionRequest[],
          },
        });
        const installer = new PluginInstaller(bad, deps);
        await expect(installer.install(gitSource)).rejects.toMatchObject({
          code: 'PLUGIN_INSTALL_INVALID',
        });
        expect(deps.removeImage).toHaveBeenCalledWith(
          'ignite/installed_bad:1.0.0'
        );
      });
    }

    it('accepts a plugin with no permissions field at all', async () => {
      const { permissions: _permissions, ...bare } = waffleMeta;
      const noPerms = backendReturning({
        imageTag: 'ignite/installed_waffle:1.0.0',
        metadata: bare as PluginMetadata,
      });
      const installer = new PluginInstaller(noPerms, deps);
      await expect(installer.install(gitSource)).resolves.toMatchObject({
        id: 'waffle',
      });
    });
  });

  describe('update', () => {
    async function installV1(deps: ReturnType<typeof makeDeps>) {
      const installer = new PluginInstaller(backend, deps);
      await installer.install(gitSource);
      // User granted the requested hostWrite permission.
      deps.grants.waffle = { trust: 'trusted', hostWrite: true, net: false };
      return installer;
    }

    it('rebuilds from the stored source, carries grants over, and reports newly requested permissions', async () => {
      await installV1(deps);
      const v2: PluginMetadata = {
        ...waffleMeta,
        version: '2.0.0',
        baseImage: 'ignite/installed_waffle:2.0.0',
        permissions: [
          { id: 'hostWrite', description: 'Write build artifacts.' },
          { id: 'net', description: 'Download compilers.' },
        ],
      };
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_waffle:2.0.0',
          metadata: v2,
        }),
        deps
      );

      const result = await updater.update('waffle');

      expect(result.plugin.version).toBe('2.0.0');
      expect(result.newPermissions).toEqual([
        { id: 'net', description: 'Download compilers.' },
      ]);
      // hostWrite grant carried over, net starts denied.
      expect(deps.grants.waffle).toEqual({
        trust: 'trusted',
        hostWrite: true,
        net: false,
        secrets: [],
      });
      // Old image removed, registry now points at the new tag, source kept.
      expect(deps.removeImage).toHaveBeenCalledWith(
        'ignite/installed_waffle:1.0.0'
      );
      expect(deps.store.waffle.baseImage).toBe('ignite/installed_waffle:2.0.0');
      expect(deps.sources.waffle).toEqual(enrichedGitSource);
    });

    it('revokes a grant whose permission the new version no longer requests', async () => {
      await installV1(deps);
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_waffle:2.0.0',
          metadata: {
            ...waffleMeta,
            version: '2.0.0',
            permissions: [],
          },
        }),
        deps
      );
      const result = await updater.update('waffle');
      expect(result.newPermissions).toEqual([]);
      expect(deps.grants.waffle).toEqual({
        trust: 'untrusted',
        hostWrite: false,
        net: false,
        secrets: [],
      });
    });

    it('accepts a same-repo source with a different ref, but rejects a different repo', async () => {
      await installV1(deps);
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_waffle:2.0.0',
          metadata: { ...waffleMeta, version: '2.0.0' },
        }),
        deps
      );
      await expect(
        updater.update('waffle', {
          kind: 'git',
          url: 'https://github.com/evil/waffle',
        })
      ).rejects.toMatchObject({ code: 'PLUGIN_UPDATE_INVALID' });

      await expect(
        updater.update('waffle', {
          kind: 'git',
          url: 'https://github.com/acme/waffle.git',
          ref: 'v2.0.0',
        })
      ).resolves.toMatchObject({ plugin: { version: '2.0.0' } });
    });

    it('rejects an update whose build declares a different id, and removes the new image', async () => {
      await installV1(deps);
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_imposter:1.0.0',
          metadata: { ...waffleMeta, id: 'imposter' },
        }),
        deps
      );
      await expect(updater.update('waffle')).rejects.toMatchObject({
        code: 'PLUGIN_UPDATE_INVALID',
      });
      expect(deps.removeImage).toHaveBeenCalledWith(
        'ignite/installed_imposter:1.0.0'
      );
      // Existing install untouched.
      expect(deps.store.waffle.baseImage).toBe('ignite/installed_waffle:1.0.0');
      expect(deps.grants.waffle).toEqual({
        trust: 'trusted',
        hostWrite: true,
        net: false,
      });
    });

    it('refuses to update a plugin with no recorded install source', async () => {
      const installer = new PluginInstaller(backend, deps);
      // Simulate a legacy registry entry: metadata without a source.
      deps.store.waffle = waffleMeta;
      await expect(installer.update('waffle')).rejects.toMatchObject({
        code: 'PLUGIN_UPDATE_INVALID',
      });
    });

    it('refuses to update built-ins and unknown plugins', async () => {
      const installer = new PluginInstaller(backend, deps);
      await expect(installer.update('foundry')).rejects.toMatchObject({
        code: 'PLUGIN_UPDATE_INVALID',
      });
      await expect(installer.update('ghost')).rejects.toMatchObject({
        code: 'PLUGIN_NOT_FOUND',
      });
    });
  });

  it('uninstall removes registry entry, revokes trust, and removes the image and cache volume', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install(gitSource);
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
    await installer.install(gitSource);
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
