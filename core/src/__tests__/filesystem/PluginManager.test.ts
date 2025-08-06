import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PluginManager,
  PluginType,
  TrustLevel,
} from '../../filesystem/PluginManager';
import { createTestDirectory, cleanupTestDirectory } from '../setup';
import { FileSystem } from '../../filesystem/FileSystem';
import { PluginError, ErrorCodes } from '../../types/errors';

describe('PluginManager', () => {
  let pluginManager: PluginManager;
  let fileSystem: FileSystem;
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    fileSystem = new FileSystem(testDir);
    pluginManager = new PluginManager(fileSystem);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDirectory(testDir);
  });

  describe('Plugin Registry Operations', () => {
    it('should add a new plugin successfully', async () => {
      const pluginId = 'test-plugin';
      const plugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        dockerImage: 'test/plugin:latest',
        type: 'compiler' as PluginType,
        source: 'github.com/test/plugin',
      };

      await pluginManager.addPlugin(pluginId, plugin);

      const retrieved = await pluginManager.getPlugin(pluginId);
      expect(retrieved.name).toBe(plugin.name);
      expect(retrieved.version).toBe(plugin.version);
      expect(retrieved.dockerImage).toBe(plugin.dockerImage);
      expect(retrieved.type).toBe(plugin.type);
      expect(retrieved.installed).toBeDefined();
    });

    it('should prevent adding duplicate plugins', async () => {
      const pluginId = 'duplicate-plugin';
      const plugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        dockerImage: 'test/plugin:latest',
        type: 'compiler' as PluginType,
      };

      await pluginManager.addPlugin(pluginId, plugin);

      await expect(pluginManager.addPlugin(pluginId, plugin)).rejects.toThrow(
        "Plugin 'duplicate-plugin' already exists"
      );
    });

    it('should remove a plugin successfully', async () => {
      const pluginId = 'removable-plugin';
      const plugin = {
        name: 'Removable Plugin',
        version: '1.0.0',
        dockerImage: 'test/removable:latest',
        type: 'signer' as PluginType,
      };

      await pluginManager.addPlugin(pluginId, plugin);
      await pluginManager.removePlugin(pluginId);

      await expect(pluginManager.getPlugin(pluginId)).rejects.toThrow(
        "Plugin 'removable-plugin' does not exist"
      );
    });

    it('should prevent removing non-existent plugins', async () => {
      await expect(pluginManager.removePlugin('non-existent')).rejects.toThrow(
        "Plugin 'non-existent' does not exist"
      );
    });

    it('should list all plugins', async () => {
      const plugin1 = {
        name: 'Plugin 1',
        version: '1.0.0',
        dockerImage: 'test/plugin1:latest',
        type: 'compiler' as PluginType,
      };
      const plugin2 = {
        name: 'Plugin 2',
        version: '2.0.0',
        dockerImage: 'test/plugin2:latest',
        type: 'signer' as PluginType,
      };

      await pluginManager.addPlugin('plugin1', plugin1);
      await pluginManager.addPlugin('plugin2', plugin2);

      const plugins = await pluginManager.listPlugins();
      expect(Object.keys(plugins)).toHaveLength(2);
      expect(plugins['plugin1']).toBeDefined();
      expect(plugins['plugin2']).toBeDefined();
    });

    it('should filter plugins by type', async () => {
      const compilerPlugin = {
        name: 'Compiler Plugin',
        version: '1.0.0',
        dockerImage: 'test/compiler:latest',
        type: 'compiler' as PluginType,
      };
      const signerPlugin = {
        name: 'Signer Plugin',
        version: '1.0.0',
        dockerImage: 'test/signer:latest',
        type: 'signer' as PluginType,
      };

      await pluginManager.addPlugin('compiler1', compilerPlugin);
      await pluginManager.addPlugin('signer1', signerPlugin);

      const compilers = await pluginManager.listPlugins('compiler');
      const signers = await pluginManager.listPlugins('signer');

      expect(Object.keys(compilers)).toHaveLength(1);
      expect(compilers['compiler1']).toBeDefined();
      expect(Object.keys(signers)).toHaveLength(1);
      expect(signers['signer1']).toBeDefined();
    });

    it('should update plugin metadata', async () => {
      const pluginId = 'updatable-plugin';
      const plugin = {
        name: 'Updatable Plugin',
        version: '1.0.0',
        dockerImage: 'test/updatable:v1',
        type: 'compiler' as PluginType,
      };

      await pluginManager.addPlugin(pluginId, plugin);
      await pluginManager.updatePlugin(pluginId, {
        version: '2.0.0',
        dockerImage: 'test/updatable:v2',
      });

      const updated = await pluginManager.getPlugin(pluginId);
      expect(updated.version).toBe('2.0.0');
      expect(updated.dockerImage).toBe('test/updatable:v2');
      expect(updated.name).toBe('Updatable Plugin'); // Should preserve unchanged fields
    });

    it('should mark plugin as used', async () => {
      const pluginId = 'used-plugin';
      const plugin = {
        name: 'Used Plugin',
        version: '1.0.0',
        dockerImage: 'test/used:latest',
        type: 'rpc' as PluginType,
      };

      await pluginManager.addPlugin(pluginId, plugin);

      // Initially should not have lastUsed
      const initial = await pluginManager.getPlugin(pluginId);
      expect(initial.lastUsed).toBeUndefined();

      await pluginManager.markPluginUsed(pluginId);

      const used = await pluginManager.getPlugin(pluginId);
      expect(used.lastUsed).toBeDefined();
    });
  });

  describe('Trust Management', () => {
    beforeEach(async () => {
      // Add a test plugin for trust operations
      await pluginManager.addPlugin('trust-test', {
        name: 'Trust Test Plugin',
        version: '1.0.0',
        dockerImage: 'test/trust:latest',
        type: 'compiler' as PluginType,
      });
    });

    it('should trust a plugin with permissions', async () => {
      const permissions = {
        canReadFiles: true,
        canWriteFiles: false,
        canExecute: true,
        canNetwork: false,
        canAccessBrowserAPI: false,
      };

      await pluginManager.trustPlugin('trust-test', 'trusted', permissions);

      const trust = await pluginManager.getTrust('trust-test');
      expect(trust).toBeDefined();
      expect(trust!.trust).toBe('trusted');
      expect(trust!.permissions).toEqual(permissions);
      expect(trust!.timestamp).toBeDefined();
    });

    it('should check if plugin is trusted', async () => {
      const permissions = {
        canReadFiles: true,
        canWriteFiles: true,
        canExecute: true,
        canNetwork: true,
        canAccessBrowserAPI: false,
      };

      expect(await pluginManager.isPluginTrusted('trust-test')).toBe(false);

      await pluginManager.trustPlugin('trust-test', 'trusted', permissions);
      expect(await pluginManager.isPluginTrusted('trust-test')).toBe(true);

      await pluginManager.untrustPlugin('trust-test');
      expect(await pluginManager.isPluginTrusted('trust-test')).toBe(false);
    });

    it('should untrust a plugin', async () => {
      const permissions = {
        canReadFiles: true,
        canWriteFiles: true,
        canExecute: true,
        canNetwork: true,
        canAccessBrowserAPI: true,
      };

      await pluginManager.trustPlugin('trust-test', 'trusted', permissions);
      await pluginManager.untrustPlugin('trust-test');

      const trust = await pluginManager.getTrust('trust-test');
      expect(trust!.trust).toBe('untrusted');
      expect(trust!.permissions.canReadFiles).toBe(false);
      expect(trust!.permissions.canWriteFiles).toBe(false);
    });

    it('should get plugin permissions', async () => {
      const permissions = {
        canReadFiles: true,
        canWriteFiles: false,
        canExecute: true,
        canNetwork: false,
        canAccessBrowserAPI: true,
      };

      await pluginManager.trustPlugin('trust-test', 'trusted', permissions);

      const retrieved = await pluginManager.getPluginPermissions('trust-test');
      expect(retrieved).toEqual(permissions);
    });

    it('should return null for non-existent trust', async () => {
      const trust = await pluginManager.getTrust('non-existent');
      expect(trust).toBeNull();

      const permissions =
        await pluginManager.getPluginPermissions('non-existent');
      expect(permissions).toBeNull();
    });
  });

  describe('Combined Operations', () => {
    it('should get plugin with trust information', async () => {
      const pluginId = 'combined-test';
      await pluginManager.addPlugin(pluginId, {
        name: 'Combined Test',
        version: '1.0.0',
        dockerImage: 'test/combined:latest',
        type: 'explorer' as PluginType,
      });

      const permissions = {
        canReadFiles: false,
        canWriteFiles: false,
        canExecute: false,
        canNetwork: true,
        canAccessBrowserAPI: false,
      };
      await pluginManager.trustPlugin(pluginId, 'trusted', permissions);

      const combined = await pluginManager.getPluginWithTrust(pluginId);
      expect(combined.plugin.name).toBe('Combined Test');
      expect(combined.trust!.trust).toBe('trusted');
      expect(combined.trust!.permissions.canNetwork).toBe(true);
    });

    it('should list all plugins with trust status', async () => {
      // Add some test plugins
      await pluginManager.addPlugin('test1', {
        name: 'Test 1',
        version: '1.0.0',
        dockerImage: 'test/1:latest',
        type: 'compiler' as PluginType,
      });
      await pluginManager.addPlugin('test2', {
        name: 'Test 2',
        version: '1.0.0',
        dockerImage: 'test/2:latest',
        type: 'signer' as PluginType,
      });

      // Trust one of them
      await pluginManager.trustPlugin('test1', 'trusted', {
        canReadFiles: true,
        canWriteFiles: false,
        canExecute: true,
        canNetwork: false,
        canAccessBrowserAPI: false,
      });

      const allWithTrust = await pluginManager.listPluginsWithTrust();

      expect(allWithTrust['test1'].plugin.name).toBe('Test 1');
      expect(allWithTrust['test1'].trust!.trust).toBe('trusted');
      expect(allWithTrust['test2'].plugin.name).toBe('Test 2');
      expect(allWithTrust['test2'].trust).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should throw PluginError for trust operations on non-existent plugins', async () => {
      await expect(
        pluginManager.trustPlugin('non-existent', 'trusted', {
          canReadFiles: true,
          canWriteFiles: false,
          canExecute: false,
          canNetwork: false,
          canAccessBrowserAPI: false,
        })
      ).rejects.toThrow("Plugin 'non-existent' does not exist");
    });

    it('should throw PluginError with proper error codes', async () => {
      try {
        await pluginManager.getPlugin('missing');
      } catch (error) {
        expect(error).toBeInstanceOf(PluginError);
        expect((error as PluginError).code).toBe(ErrorCodes.PLUGIN_NOT_FOUND);
      }
    });
  });
});
