// Tests for FileSystem class

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { createTestDirectory, cleanupTestDirectory } from '../setup';
import { FileSystem } from '../../filesystem/FileSystem.js';

describe('FileSystem', () => {
  let fileSystem: FileSystem;
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    fileSystem = new FileSystem(testDir);
  });

  afterEach(async () => {
    await cleanupTestDirectory(testDir);
  });

  describe('Path Management', () => {
    it('should return correct ignite home directory', () => {
      expect(fileSystem.getIgniteHome()).toBe(testDir);
    });

    it('should generate correct profile paths', () => {
      const profilePath = fileSystem.getProfilePath('test-profile');
      expect(profilePath).toBe(path.join(testDir, 'profiles', 'test-profile'));
    });

    it('should generate correct global config path', () => {
      const configPath = fileSystem.getGlobalConfigPath();
      expect(configPath).toBe(path.join(testDir, 'config.json'));
    });

    it('should generate correct trust database path', () => {
      const trustPath = fileSystem.getTrustPath();
      expect(trustPath).toBe(path.join(testDir, 'plugins', 'trust.json'));
    });
  });

  describe('Profile Management', () => {
    it('should create default profile automatically', async () => {
      const config = await fileSystem.getProfileConfig('default');

      expect(config.name).toBe('default');
      expect(config.created).toBeDefined();
      expect(config.lastAccessed).toBeDefined();
      expect(new Date(config.created)).toBeInstanceOf(Date);
    });

    it('should create custom profile successfully', async () => {
      await fileSystem.createProfile('test-profile');

      const config = await fileSystem.getProfileConfig('test-profile');
      expect(config.name).toBe('test-profile');

      // Check that directories were created
      const profilePath = fileSystem.getProfilePath('test-profile');
      const reposPath = fileSystem.getProfileReposPath('test-profile');

      expect(await fileSystem.fileExists(profilePath)).toBe(true);
      expect(await fileSystem.fileExists(reposPath)).toBe(true);
    });

    it('should throw error for non-existent profile', async () => {
      await expect(fileSystem.getProfileConfig('non-existent')).rejects.toThrow(
        "Profile 'non-existent' does not exist"
      );
    });

    it('should list all profiles', async () => {
      // Create default profile
      await fileSystem.getProfileConfig('default');

      // Create additional profiles
      await fileSystem.createProfile('profile1');
      await fileSystem.createProfile('profile2');

      const profiles = await fileSystem.listProfiles();
      expect(profiles).toHaveLength(3);
      expect(profiles).toContain('default');
      expect(profiles).toContain('profile1');
      expect(profiles).toContain('profile2');
    });

    it('should validate profile names correctly', async () => {
      // Valid names should work
      await expect(
        fileSystem.createProfile('valid-name')
      ).resolves.not.toThrow();
      await expect(
        fileSystem.createProfile('valid_name_2')
      ).resolves.not.toThrow();
      await expect(
        fileSystem.createProfile('ValidName123')
      ).resolves.not.toThrow();

      // Invalid names should throw errors
      await expect(fileSystem.createProfile('invalid name')).rejects.toThrow();
      await expect(fileSystem.createProfile('invalid/name')).rejects.toThrow();
      await expect(fileSystem.createProfile('')).rejects.toThrow();
    });
  });

  describe('Configuration File Management', () => {
    it('should create and read global config', async () => {
      const config = await fileSystem.readGlobalConfig();

      expect(config.version).toBe('1.0.0');
      expect(config.currentProfile).toBe('default');
      expect(config.lastStartup).toBeDefined();
    });

    it('should create and read trust database', async () => {
      const trustDb = await fileSystem.readTrustDatabase();

      expect(trustDb).toEqual({});
      expect(typeof trustDb).toBe('object');
    });

    it('should create and read plugin registry', async () => {
      const registry = await fileSystem.readPluginRegistry();

      expect(registry.plugins).toEqual({});
      expect(typeof registry.plugins).toBe('object');
    });

    it('should write and read JSON files correctly', async () => {
      const testData = { test: 'data', number: 42, nested: { key: 'value' } };
      const testPath = path.join(testDir, 'test.json');

      await fileSystem.writeJsonFile(testPath, testData);
      const readData = await fileSystem.readJsonFile(testPath);

      expect(readData).toEqual(testData);
    });
  });

  describe('File Operations', () => {
    it('should correctly check file existence', async () => {
      const testPath = path.join(testDir, 'test-file.txt');

      expect(await fileSystem.fileExists(testPath)).toBe(false);

      // Create file
      await fs.writeFile(testPath, 'test content');

      expect(await fileSystem.fileExists(testPath)).toBe(true);
    });

    it('should handle JSON parsing errors gracefully', async () => {
      const testPath = path.join(testDir, 'invalid.json');
      await fs.writeFile(testPath, 'invalid json content');

      await expect(fileSystem.readJsonFile(testPath)).rejects.toThrow(
        'Failed to read JSON file'
      );
    });
  });
});
