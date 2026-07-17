import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type {
  PluginMetadata,
  PluginPermissionRequest,
} from '@ignite/plugin-types/types';
import { PluginInstaller } from '../../plugins/install/PluginInstaller.js';
import type {
  ConfigPrimitive,
  ConfigValue,
} from '../../plugins/config/PluginConfigStore.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from '../../plugins/install/types.js';

const waffleMeta: PluginMetadata = {
  id: 'waffle',
  types: [PluginType.COMPILER],
  name: 'Waffle',
  version: '1.0.0',
  baseImage: 'ignite/installed_waffle:1.0.0',
  permissions: [
    { id: 'repoWrite', description: 'Write build artifacts to the repo.' },
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
    {
      trust: 'trusted' | 'untrusted';
      repoWrite: boolean;
      net: boolean;
      contractBytecode?: boolean;
      secrets?: string[];
    }
  > = {};
  const vaultDeletedPlugins: string[] = [];
  const configDeletedPlugins: string[] = [];
  const configValues: Record<
    string,
    Record<string, { global?: ConfigValue; perChain?: Record<string, ConfigPrimitive> }>
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
        repoWrite: grants[id]?.repoWrite ?? false,
        net: grants[id]?.net ?? false,
        contractBytecode: grants[id]?.contractBytecode ?? false,
        secrets: grants[id]?.secrets ?? ([] as string[]),
      })),
      setTrust: vi.fn(
        async (
          id: string,
          trust: 'trusted' | 'untrusted',
          permissions: { repoWrite: boolean; net: boolean; contractBytecode?: boolean; secrets: string[] }
        ) => {
          const { contractBytecode, ...legacy } = permissions;
          grants[id] = { trust, ...legacy, ...(contractBytecode ? { contractBytecode } : {}) };
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
    vaultStore: {
      deletePlugin: vi.fn(async (id: string) => {
        vaultDeletedPlugins.push(id);
      }),
    },
    configStore: {
      deletePlugin: vi.fn(async (id: string) => {
        configDeletedPlugins.push(id);
      }),
      getValues: vi.fn(async (id: string) => configValues[id] ?? {}),
    },
    store,
    sources,
    grants,
    vaultDeletedPlugins,
    configDeletedPlugins,
    configValues,
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

  it('revokes an orphaned trust grant before a fresh install can use its id', async () => {
    deps.grants.waffle = {
      trust: 'trusted',
      repoWrite: true,
      net: true,
      secrets: ['api-key'],
    };
    deps.trust.revoke.mockImplementation(async () => {
      delete deps.grants.waffle;
    });
    const installer = new PluginInstaller(backend, deps);

    await installer.install(gitSource);

    expect(deps.trust.revoke).toHaveBeenCalledWith('waffle');
    expect(deps.grants.waffle).toBeUndefined();
    expect(await deps.trust.getGrant('waffle')).toMatchObject({
      trust: 'untrusted',
      repoWrite: false,
      net: false,
      secrets: [],
    });
    // The wipe covers ALL id-scoped state uninstall would clear, not just
    // trust — orphaned vault secrets, config values, and the cache volume
    // must not carry over either.
    expect(deps.vaultDeletedPlugins).toContain('waffle');
    expect(deps.configDeletedPlugins).toContain('waffle');
    expect(deps.removeVolume).toHaveBeenCalledWith(
      'ignite-plugin-cache-waffle'
    );
  });

  it('does not delete a working install\'s image when a same-version reinstall is refused', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install(gitSource);
    expect(deps.store.waffle.baseImage).toBe('ignite/installed_waffle:1.0.0');
    deps.removeImage.mockClear();

    // Reinstalling the same id+version without uninstalling first is refused,
    // but the candidate was already finalized onto the SAME canonical tag the
    // working install owns — cleanup must not remove it.
    await expect(installer.install(gitSource)).rejects.toThrow(
      /already installed/
    );
    expect(deps.removeImage).not.toHaveBeenCalledWith(
      'ignite/installed_waffle:1.0.0'
    );
    expect(deps.store.waffle.baseImage).toBe('ignite/installed_waffle:1.0.0');
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

    // A NEWER candidate of the same id finalizes onto its own version tag —
    // refusing the reinstall must clean that candidate image up (it is not
    // the tag the working install owns).
    const newerInstaller = new PluginInstaller(
      backendReturning({
        imageTag: 'ignite/installed_waffle:2.0.0',
        metadata: { ...waffleMeta, version: '2.0.0' },
      }),
      deps
    );
    await expect(newerInstaller.install(gitSource)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_CONFLICT',
    });
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_waffle:2.0.0'
    );
    // Original registration untouched.
    expect(deps.store.waffle).toEqual(
      expect.objectContaining({ baseImage: 'ignite/installed_waffle:1.0.0' })
    );
  });

  it('rejects installing a repo-manager-typed plugin via generic type validation (PLUGIN_INSTALL_INVALID), removes the image, and does not persist it', async () => {
    const repoManagerBackend = backendReturning({
      imageTag: 'ignite/installed_evilrepo:1.0.0',
      metadata: {
        ...waffleMeta,
        id: 'evilrepo',
        types: ['repo-manager' as unknown as PluginType],
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

  it('rejects installing a frontend-runtime plugin until that runtime is routable', async () => {
    const frontendBackend = backendReturning({
      imageTag: 'ignite/installed_browser:1.0.0',
      metadata: {
        ...waffleMeta,
        id: 'browser-plugin',
        runtime: 'frontend',
      },
    });
    const installer = new PluginInstaller(frontendBackend, deps);
    await expect(installer.install(gitSource)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_INVALID',
    });
    expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
    expect(deps.removeImage).toHaveBeenCalledWith(
      'ignite/installed_browser:1.0.0'
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

    it("normalizes a legacy 'hostWrite' manifest to 'repoWrite' and persists the new id", async () => {
      const legacy = backendReturning({
        imageTag: 'ignite/installed_waffle:1.0.0',
        metadata: {
          ...waffleMeta,
          permissions: [
            { id: 'hostWrite', description: 'Write build artifacts.' },
            { id: 'net', description: 'Download compilers.' },
          ] as unknown as PluginPermissionRequest[],
        },
      });
      const installer = new PluginInstaller(legacy, deps);
      const meta = await installer.install(gitSource);
      expect(meta.permissions).toEqual([
        { id: 'repoWrite', description: 'Write build artifacts.' },
        { id: 'net', description: 'Download compilers.' },
      ]);
      // The persisted registry entry carries the normalized id too.
      expect(deps.store.waffle.permissions?.map((p) => p.id)).toEqual([
        'repoWrite',
        'net',
      ]);
    });

    it("rejects a manifest declaring BOTH 'hostWrite' and 'repoWrite' (duplicate after normalization)", async () => {
      const both = backendReturning({
        imageTag: 'ignite/installed_bad:1.0.0',
        metadata: {
          ...waffleMeta,
          id: 'bad',
          permissions: [
            { id: 'repoWrite', description: 'a' },
            { id: 'hostWrite', description: 'b' },
          ] as unknown as PluginPermissionRequest[],
        },
      });
      const installer = new PluginInstaller(both, deps);
      await expect(installer.install(gitSource)).rejects.toMatchObject({
        code: 'PLUGIN_INSTALL_INVALID',
      });
    });
  });

  describe('update', () => {
    async function installV1(deps: ReturnType<typeof makeDeps>) {
      const installer = new PluginInstaller(backend, deps);
      await installer.install(gitSource);
      // User granted the requested repoWrite permission.
      deps.grants.waffle = { trust: 'trusted', repoWrite: true, net: false };
      return installer;
    }

    it('rebuilds from the stored source, carries grants over, and reports newly requested permissions', async () => {
      await installV1(deps);
      const v2: PluginMetadata = {
        ...waffleMeta,
        version: '2.0.0',
        baseImage: 'ignite/installed_waffle:2.0.0',
        permissions: [
          { id: 'repoWrite', description: 'Write build artifacts.' },
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
      // repoWrite grant carried over, net starts denied.
      expect(deps.grants.waffle).toEqual({
        trust: 'trusted',
        repoWrite: true,
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

    it('clamps a contractBytecode grant when the updated manifest no longer requests it', async () => {
      await installV1(deps);
      deps.grants.waffle = { trust: 'trusted', repoWrite: true, net: false, contractBytecode: true };
      await new PluginInstaller(backendReturning({ imageTag: 'ignite/installed_waffle:2.0.0', metadata: { ...waffleMeta, version: '2.0.0' } }), deps).update('waffle');
      expect(deps.trust.setTrust).toHaveBeenLastCalledWith('waffle', 'trusted', expect.objectContaining({ contractBytecode: false }));
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
        repoWrite: false,
        net: false,
        secrets: [],
      });
    });

    it("carries a repoWrite grant across an update whose new manifest still declares legacy 'hostWrite'", async () => {
      await installV1(deps);
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_waffle:2.0.0',
          metadata: {
            ...waffleMeta,
            version: '2.0.0',
            permissions: [
              { id: 'hostWrite', description: 'Write build artifacts.' },
            ] as unknown as PluginPermissionRequest[],
          },
        }),
        deps
      );
      const result = await updater.update('waffle');
      // Normalized: not reported as a new permission, grant carried over.
      expect(result.newPermissions).toEqual([]);
      expect(deps.grants.waffle).toEqual({
        trust: 'trusted',
        repoWrite: true,
        net: false,
        secrets: [],
      });
      expect(deps.store.waffle.permissions?.map((p) => p.id)).toEqual([
        'repoWrite',
      ]);
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
        repoWrite: true,
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

    it('clamps granted secrets to the new version declared secret fields, dropping ones no longer declared', async () => {
      await installV1(deps);
      // User previously granted two secret-scope keys.
      deps.grants.waffle = {
        trust: 'trusted',
        repoWrite: true,
        net: false,
        secrets: ['apikey', 'legacykey'],
      };
      const v2: PluginMetadata = {
        ...waffleMeta,
        version: '2.0.0',
        // New version keeps `apikey` as a secret field but no longer
        // declares `legacykey` at all.
        configFields: [
          { key: 'apikey', label: 'API Key', type: 'string', secret: true },
        ],
      };
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_waffle:2.0.0',
          metadata: v2,
        }),
        deps
      );

      await updater.update('waffle');

      expect(deps.grants.waffle).toEqual({
        trust: 'trusted',
        repoWrite: true,
        net: false,
        secrets: ['apikey'],
      });
    });

    it('keeps a plugin trusted on update when only secret grants survive (no repoWrite/net)', async () => {
      const installer = new PluginInstaller(backend, deps);
      await installer.install(gitSource);
      deps.grants.waffle = {
        trust: 'trusted',
        repoWrite: false,
        net: false,
        secrets: ['apikey'],
      };
      const v2: PluginMetadata = {
        ...waffleMeta,
        version: '2.0.0',
        permissions: [],
        configFields: [
          { key: 'apikey', label: 'API Key', type: 'string', secret: true },
        ],
      };
      const updater = new PluginInstaller(
        backendReturning({
          imageTag: 'ignite/installed_waffle:2.0.0',
          metadata: v2,
        }),
        deps
      );

      await updater.update('waffle');

      expect(deps.grants.waffle).toEqual({
        trust: 'trusted',
        repoWrite: false,
        net: false,
        secrets: ['apikey'],
      });
    });

    describe('re-consent for changed file-field defaults', () => {
      const v1WithFile: PluginMetadata = {
        ...waffleMeta,
        permissions: [],
        configFields: [
          {
            key: 'configfile',
            label: 'Config File',
            type: 'file',
            default: '~/.waffle.json',
          },
        ],
      };

      async function installV1WithFile(deps: ReturnType<typeof makeDeps>) {
        const installer = new PluginInstaller(
          backendReturning({
            imageTag: 'ignite/installed_waffle:1.0.0',
            metadata: v1WithFile,
          }),
          deps
        );
        await installer.install(gitSource);
        deps.grants.waffle = {
          trust: 'trusted',
          repoWrite: false,
          net: false,
          secrets: ['configfile'],
        };
        return installer;
      }

      it('drops the grant when the file field default changed and the user never configured their own path', async () => {
        await installV1WithFile(deps);
        const v2: PluginMetadata = {
          ...waffleMeta,
          version: '2.0.0',
          permissions: [],
          configFields: [
            {
              key: 'configfile',
              label: 'Config File',
              type: 'file',
              default: '~/.waffle2.json',
            },
          ],
        };
        const updater = new PluginInstaller(
          backendReturning({
            imageTag: 'ignite/installed_waffle:2.0.0',
            metadata: v2,
          }),
          deps
        );

        await updater.update('waffle');

        expect(deps.grants.waffle).toEqual({
          trust: 'untrusted',
          repoWrite: false,
          net: false,
          secrets: [],
        });
      });

      it('keeps the grant when the file field default changed but the user pinned their own path', async () => {
        await installV1WithFile(deps);
        deps.configValues.waffle = {
          configfile: { global: '/home/user/custom-waffle.json' },
        };
        const v2: PluginMetadata = {
          ...waffleMeta,
          version: '2.0.0',
          permissions: [],
          configFields: [
            {
              key: 'configfile',
              label: 'Config File',
              type: 'file',
              default: '~/.waffle2.json',
            },
          ],
        };
        const updater = new PluginInstaller(
          backendReturning({
            imageTag: 'ignite/installed_waffle:2.0.0',
            metadata: v2,
          }),
          deps
        );

        await updater.update('waffle');

        expect(deps.grants.waffle).toEqual({
          trust: 'trusted',
          repoWrite: false,
          net: false,
          secrets: ['configfile'],
        });
      });

      it('keeps the grant when the file field default is unchanged', async () => {
        await installV1WithFile(deps);
        const v2: PluginMetadata = {
          ...waffleMeta,
          version: '2.0.0',
          permissions: [],
          configFields: [
            {
              key: 'configfile',
              label: 'Config File',
              type: 'file',
              default: '~/.waffle.json',
            },
          ],
        };
        const updater = new PluginInstaller(
          backendReturning({
            imageTag: 'ignite/installed_waffle:2.0.0',
            metadata: v2,
          }),
          deps
        );

        await updater.update('waffle');

        expect(deps.grants.waffle).toEqual({
          trust: 'trusted',
          repoWrite: false,
          net: false,
          secrets: ['configfile'],
        });
      });

      it('drops the grant on a secret -> file type transition, even with a user-configured path', async () => {
        const v1WithSecret: PluginMetadata = {
          ...waffleMeta,
          permissions: [],
          configFields: [
            { key: 'apikey', label: 'API Key', type: 'string', secret: true },
          ],
        };
        const installer = new PluginInstaller(
          backendReturning({
            imageTag: 'ignite/installed_waffle:1.0.0',
            metadata: v1WithSecret,
          }),
          deps
        );
        await installer.install(gitSource);
        deps.grants.waffle = {
          trust: 'trusted',
          repoWrite: false,
          net: false,
          secrets: ['apikey'],
        };
        // Even though the user has a configured path under the same key,
        // the type transition alone must re-open consent.
        deps.configValues.waffle = {
          apikey: { global: '/home/user/apikey-as-a-file.json' },
        };
        const v2: PluginMetadata = {
          ...waffleMeta,
          version: '2.0.0',
          permissions: [],
          configFields: [
            {
              key: 'apikey',
              label: 'API Key',
              type: 'file',
              default: '~/.apikey.json',
            },
          ],
        };
        const updater = new PluginInstaller(
          backendReturning({
            imageTag: 'ignite/installed_waffle:2.0.0',
            metadata: v2,
          }),
          deps
        );

        await updater.update('waffle');

        expect(deps.grants.waffle).toEqual({
          trust: 'untrusted',
          repoWrite: false,
          net: false,
          secrets: [],
        });
      });
    });
  });

  it('uninstall removes registry entry, revokes trust, and removes the image, cache volume, vault secrets, and config values', async () => {
    const installer = new PluginInstaller(backend, deps);
    await installer.install(gitSource);
    await installer.uninstall('waffle');
    expect(deps.pluginManager.removePlugin).toHaveBeenCalledWith('waffle');
    expect(deps.trust.revoke).toHaveBeenCalledWith('waffle');
    expect(deps.vaultStore.deletePlugin).toHaveBeenCalledWith('waffle');
    expect(deps.configStore.deletePlugin).toHaveBeenCalledWith('waffle');
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

  describe('rebuildImage', () => {
    const pinnedCommit = 'b'.repeat(40);

    function seedInstalled(source: PluginInstallSource) {
      deps.store.waffle = { ...waffleMeta };
      deps.sources.waffle = source;
    }

    it('rebuilds a git install from the PINNED commit, never the floating ref, and leaves the registry untouched', async () => {
      seedInstalled({
        kind: 'git',
        url: 'https://github.com/acme/waffle',
        ref: 'main',
        track: { mode: 'branch', branch: 'main' },
        commit: pinnedCommit,
      });
      const rebuildBackend = backendReturning({
        imageTag: 'ignite/installed_waffle:1.0.0',
        metadata: waffleMeta,
        commit: pinnedCommit,
      });
      const installer = new PluginInstaller(rebuildBackend, deps);

      const meta = await installer.rebuildImage('waffle');

      expect(rebuildBackend.buildPluginImage).toHaveBeenCalledWith({
        kind: 'git',
        url: 'https://github.com/acme/waffle',
        ref: pinnedCommit,
      });
      expect(meta).toEqual(waffleMeta);
      // Rebuild, not update: neither the registry nor trust are written.
      expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
      expect(deps.trust.setTrust).not.toHaveBeenCalled();
      expect(deps.removeImage).not.toHaveBeenCalled();
    });

    it('fails actionably for a git install without a recorded commit instead of rebuilding a moved ref', async () => {
      seedInstalled({
        kind: 'git',
        url: 'https://github.com/acme/waffle',
        ref: 'main',
      });
      const rebuildBackend = backendReturning({
        imageTag: 'ignite/installed_waffle:1.0.0',
        metadata: waffleMeta,
      });
      const installer = new PluginInstaller(rebuildBackend, deps);

      await expect(installer.rebuildImage('waffle')).rejects.toThrow(
        /waffle.*no pinned commit.*reinstall/is
      );
      expect(rebuildBackend.buildPluginImage).not.toHaveBeenCalled();
    });

    it('fails actionably when a local install source directory no longer exists', async () => {
      seedInstalled({ kind: 'local', contextDir: '/gone/waffle' });
      const rebuildBackend = backendReturning({
        imageTag: 'ignite/installed_waffle:1.0.0',
        metadata: waffleMeta,
      });
      const installer = new PluginInstaller(rebuildBackend, {
        ...deps,
        directoryExists: vi.fn(async () => false),
      });

      await expect(installer.rebuildImage('waffle')).rejects.toThrow(
        /'\/gone\/waffle' no longer exists.*reinstall/is
      );
      expect(rebuildBackend.buildPluginImage).not.toHaveBeenCalled();
    });

    it('rebuilds a local install when the recorded contextDir still exists', async () => {
      seedInstalled({ kind: 'local', contextDir: '/plugins/waffle' });
      const rebuildBackend = backendReturning({
        imageTag: 'ignite/installed_waffle:1.0.0',
        metadata: waffleMeta,
      });
      const installer = new PluginInstaller(rebuildBackend, {
        ...deps,
        directoryExists: vi.fn(async () => true),
      });

      await expect(installer.rebuildImage('waffle')).resolves.toEqual(
        waffleMeta
      );
      expect(rebuildBackend.buildPluginImage).toHaveBeenCalledWith({
        kind: 'local',
        contextDir: '/plugins/waffle',
      });
    });

    it('fails on drifted post-build metadata without touching registry or trust, and removes the drifted image', async () => {
      seedInstalled({ kind: 'local', contextDir: '/plugins/waffle' });
      const drifted = backendReturning({
        imageTag: 'ignite/installed_waffle:2.0.0',
        metadata: { ...waffleMeta, version: '2.0.0' },
      });
      const installer = new PluginInstaller(drifted, {
        ...deps,
        directoryExists: vi.fn(async () => true),
      });

      await expect(installer.rebuildImage('waffle')).rejects.toThrow(
        /drifted.*reinstall/is
      );
      expect(deps.pluginManager.addPlugin).not.toHaveBeenCalled();
      expect(deps.trust.setTrust).not.toHaveBeenCalled();
      expect(deps.removeImage).toHaveBeenCalledWith(
        'ignite/installed_waffle:2.0.0'
      );
    });

    it('refuses to rebuild a built-in plugin', async () => {
      const installer = new PluginInstaller(backend, deps);
      await expect(installer.rebuildImage('foundry')).rejects.toThrow(
        /built-in.*docker:build/is
      );
    });

    it('fails actionably when no install source was recorded', async () => {
      deps.store.waffle = { ...waffleMeta };
      const installer = new PluginInstaller(backend, deps);
      await expect(installer.rebuildImage('waffle')).rejects.toThrow(
        /no recorded install source.*reinstall/is
      );
    });
  });
});
