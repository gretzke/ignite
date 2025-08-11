import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginManager, PluginType } from '../../filesystem/PluginManager';
import { PluginType as PluginTypeEnum } from '@ignite/plugin-types/types';
import { createTestDirectory, cleanupTestDirectory } from '../setup';
import { FileSystem } from '../../filesystem/FileSystem';
import { PluginError, ErrorCodes } from '../../types/errors';

describe('PluginManager', () => {
  let pluginManager: PluginManager;
  let fileSystem: FileSystem;
  let testDir: string;

  beforeEach(async () => {
    // Create isolated test environment
    testDir = await createTestDirectory();
    fileSystem = new FileSystem(testDir);
    pluginManager = new PluginManager(fileSystem);

    // Mock logger to avoid console output during tests
    vi.mock('../../utils/logger', () => ({
      getLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }));
  });

  afterEach(async () => {
    await cleanupTestDirectory(testDir);
  });

  describe('Plugin Registry Operations', () => {
    it('should get plugin from registry', async () => {
      // First, manually add a plugin to the registry for testing
      const registry = {
        plugins: {
          'test-plugin': {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            baseImage: 'test/plugin:latest',
            type: PluginTypeEnum.COMPILER,
          },
        },
      };

      await fileSystem.writeJsonFile(fileSystem.getRegistryPath(), registry);

      const plugin = await pluginManager.getPlugin('test-plugin');
      expect(plugin.name).toBe('Test Plugin');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.baseImage).toBe('test/plugin:latest');
      expect(plugin.type).toBe(PluginTypeEnum.COMPILER);
      expect(plugin.id).toBe('test-plugin');
    });

    it('should throw error when getting non-existent plugin', async () => {
      await expect(pluginManager.getPlugin('non-existent')).rejects.toThrow(
        PluginError
      );
    });

    it('should list all plugins', async () => {
      const registry = {
        plugins: {
          plugin1: {
            id: 'plugin1',
            name: 'Plugin 1',
            version: '1.0.0',
            baseImage: 'test/plugin1:latest',
            type: PluginTypeEnum.COMPILER,
          },
          plugin2: {
            id: 'plugin2',
            name: 'Plugin 2',
            version: '2.0.0',
            baseImage: 'test/plugin2:latest',
            type: 'signer' as PluginType,
          },
        },
      };

      await fileSystem.writeJsonFile(fileSystem.getRegistryPath(), registry);

      const allPlugins = await pluginManager.listPlugins();
      expect(Object.keys(allPlugins)).toHaveLength(2);
      expect(allPlugins['plugin1']).toBeDefined();
      expect(allPlugins['plugin2']).toBeDefined();
    });

    it('should filter plugins by type', async () => {
      const registry = {
        plugins: {
          compiler1: {
            id: 'compiler1',
            name: 'Compiler Plugin',
            version: '1.0.0',
            baseImage: 'test/compiler:latest',
            type: PluginTypeEnum.COMPILER,
          },
          signer1: {
            id: 'signer1',
            name: 'Signer Plugin',
            version: '1.0.0',
            baseImage: 'test/signer:latest',
            type: 'signer' as PluginType,
          },
        },
      };

      await fileSystem.writeJsonFile(fileSystem.getRegistryPath(), registry);

      const compilers = await pluginManager.listPlugins(
        PluginTypeEnum.COMPILER
      );
      const signers = await pluginManager.listPlugins('signer' as PluginType);

      expect(Object.keys(compilers)).toHaveLength(1);
      expect(compilers['compiler1']).toBeDefined();
      expect(Object.keys(signers)).toHaveLength(1);
      expect(signers['signer1']).toBeDefined();
    });
  });
});
