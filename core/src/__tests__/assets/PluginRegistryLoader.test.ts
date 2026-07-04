import { describe, it, expect, beforeEach, vi } from 'vitest';

// Simulates plugins/dist being rebuilt: the registry file is missing first
// (mid `rm -rf dist`), then present once the build finishes.
const state = vi.hoisted(() => ({
  exists: true,
  text: JSON.stringify({
    foundry: {
      id: 'foundry',
      type: 'compiler',
      name: 'Foundry',
      version: '1.0.0',
      baseImage: 'ignite/compiler_foundry:latest',
    },
  }),
}));

vi.mock('../../assets/AssetManager.js', () => ({
  AssetManager: {
    getInstance: () => ({
      exists: () => state.exists,
      getAssetText: () => state.text,
    }),
  },
}));

vi.mock('../../filesystem/PluginManager.js', () => ({
  PluginManager: {
    getInstance: () => ({
      listPlugins: async () => ({}),
    }),
  },
}));

import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';

function freshLoader(): PluginRegistryLoader {
  (
    PluginRegistryLoader as unknown as { instance?: PluginRegistryLoader }
  ).instance = undefined;
  return PluginRegistryLoader.getInstance();
}

describe('PluginRegistryLoader', () => {
  beforeEach(() => {
    state.exists = true;
  });

  it('loads the built-in catalog from the registry file', async () => {
    const loader = freshLoader();
    const plugins = await loader.getAllPlugins();
    expect(Object.keys(plugins)).toContain('foundry');
  });

  it('retries the built-in catalog after a transient load failure', async () => {
    const loader = freshLoader();

    state.exists = false;
    expect(await loader.getAllPlugins()).toEqual({});

    // Registry file reappears (plugins build finished) — the next call must
    // pick it up instead of serving a permanently cached empty catalog.
    state.exists = true;
    const plugins = await loader.getAllPlugins();
    expect(Object.keys(plugins)).toContain('foundry');
    await expect(loader.getPluginConfig('foundry')).resolves.toBeDefined();
  });
});
