import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';

// Fake the persisted registry so we don't touch disk.
const listPluginsMock = vi.fn();
vi.mock('../../filesystem/PluginManager.js', () => ({
  PluginManager: {
    getInstance: () => ({ listPlugins: listPluginsMock }),
  },
}));

describe('PluginRegistryLoader union resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    listPluginsMock.mockReset();
  });

  it('marks built-in plugins origin=builtin and installed origin=installed', async () => {
    listPluginsMock.mockResolvedValue({
      waffle: {
        id: 'waffle',
        type: PluginType.COMPILER,
        name: 'Waffle',
        version: '1.0.0',
        baseImage: 'ignite/installed_waffle:1.0.0',
      },
    });
    const { PluginRegistryLoader } = await import(
      '../../assets/PluginRegistryLoader.js'
    );
    const loader = PluginRegistryLoader.getInstance();

    const foundry = await loader.getPluginConfig('foundry');
    expect(foundry.origin).toBe('builtin');

    const waffle = await loader.getPluginConfig('waffle');
    expect(waffle.origin).toBe('installed');
    expect(waffle.metadata.baseImage).toBe('ignite/installed_waffle:1.0.0');

    expect(await loader.isBuiltin('foundry')).toBe(true);
    expect(await loader.isBuiltin('waffle')).toBe(false);
  });

  it('getPluginsByType includes installed plugins of that type', async () => {
    listPluginsMock.mockResolvedValue({
      waffle: {
        id: 'waffle',
        type: PluginType.COMPILER,
        name: 'Waffle',
        version: '1.0.0',
        baseImage: 'ignite/installed_waffle:1.0.0',
      },
    });
    const { PluginRegistryLoader } = await import(
      '../../assets/PluginRegistryLoader.js'
    );
    const ids = (
      await PluginRegistryLoader.getInstance().getPluginsByType(
        PluginType.COMPILER
      )
    ).map((c) => c.metadata.id);
    expect(ids).toContain('foundry');
    expect(ids).toContain('waffle');
  });

  it('built-in wins on id collision and stays origin=builtin', async () => {
    listPluginsMock.mockResolvedValue({
      foundry: {
        id: 'foundry',
        type: PluginType.COMPILER,
        name: 'Evil Foundry',
        version: '9.9.9',
        baseImage: 'evil/foundry:latest',
      },
    });
    const { PluginRegistryLoader } = await import(
      '../../assets/PluginRegistryLoader.js'
    );
    const foundry =
      await PluginRegistryLoader.getInstance().getPluginConfig('foundry');
    expect(foundry.origin).toBe('builtin');
    expect(foundry.metadata.baseImage).toBe('ignite/compiler_foundry:latest');
  });

  it('concurrent getAllPlugins calls all resolve the full built-in set', async () => {
    listPluginsMock.mockResolvedValue({});
    const { PluginRegistryLoader } = await import(
      '../../assets/PluginRegistryLoader.js'
    );
    const loader = PluginRegistryLoader.getInstance();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => loader.getAllPlugins())
    );
    for (const r of results) {
      expect(Object.keys(r)).toContain('foundry');
      expect(Object.keys(r)).toContain('hardhat');
    }
  });
});
