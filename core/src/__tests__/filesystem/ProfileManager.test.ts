// Tests for ProfileManager class

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDirectory, cleanupTestDirectory } from '../setup';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { ProfileManager } from '../../filesystem/ProfileManager.js';

describe('ProfileManager', () => {
  let profileManager: ProfileManager;
  let fileSystem: FileSystem;
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    fileSystem = new FileSystem(testDir);
    profileManager = new ProfileManager(fileSystem);

    // Initialize the profile manager
    await profileManager.initialize();
  });

  afterEach(async () => {
    await cleanupTestDirectory(testDir);
  });

  describe('Initialization', () => {
    it('should initialize with default profile', () => {
      expect(profileManager.getCurrentProfile()).toBe('default');
    });

    it('should create default profile on initialization', async () => {
      const config = await profileManager.getCurrentProfileConfig();
      expect(config.name).toBe('default');
      expect(config.created).toBeDefined();
      expect(config.lastAccessed).toBeDefined();
    });
  });

  describe('Profile Operations', () => {
    it('should create new profile successfully', async () => {
      await profileManager.createProfile('test-profile');

      const profiles = await profileManager.listProfiles();
      const profileNames = profiles.map((p) => p.name);

      expect(profileNames).toContain('test-profile');
    });

    it('should switch profiles successfully', async () => {
      await profileManager.createProfile('new-profile');
      await profileManager.switchProfile('new-profile');

      expect(profileManager.getCurrentProfile()).toBe('new-profile');

      // Check that global config was updated
      const globalConfig = await fileSystem.readGlobalConfig();
      expect(globalConfig.currentProfile).toBe('new-profile');
    });

    it('should list profiles in last accessed order', async () => {
      // Create profiles with delays to ensure different timestamps
      await profileManager.createProfile('profile1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      await profileManager.createProfile('profile2');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Switch to profile1 to update its lastAccessed
      await profileManager.switchProfile('profile1');

      const profiles = await profileManager.listProfiles();

      // profile1 should be first (most recent), then profile2, then default
      expect(profiles[0].name).toBe('profile1');
      expect(profiles[1].name).toBe('profile2');
      expect(profiles[2].name).toBe('default');
    });

    it('should get current profile paths', () => {
      const paths = profileManager.getCurrentProfilePaths();

      expect(paths.root).toBe(fileSystem.getProfilePath('default'));
      expect(paths.repos).toBe(fileSystem.getProfileReposPath('default'));
      expect(paths.config).toBe(fileSystem.getProfileConfigPath('default'));
    });
  });

  describe('Profile Validation', () => {
    it('should prevent switching to non-existent profile', async () => {
      await expect(
        profileManager.switchProfile('non-existent')
      ).rejects.toThrow("Profile 'non-existent' does not exist");
    });

    it('should prevent creating profile with invalid name', async () => {
      await expect(
        profileManager.createProfile('invalid name')
      ).rejects.toThrow('Invalid profile name: invalid name');
    });

    it('should prevent creating duplicate profile', async () => {
      await profileManager.createProfile('duplicate');

      await expect(profileManager.createProfile('duplicate')).rejects.toThrow(
        "Profile 'duplicate' already exists"
      );
    });
  });

  describe('Profile Deletion', () => {
    it('should prevent deleting default profile', async () => {
      await expect(profileManager.deleteProfile('default')).rejects.toThrow(
        'Cannot delete the default profile'
      );
    });

    it('should prevent deleting currently active profile', async () => {
      await profileManager.createProfile('active-profile');
      await profileManager.switchProfile('active-profile');

      await expect(
        profileManager.deleteProfile('active-profile')
      ).rejects.toThrow('Cannot delete the currently active profile');
    });

    it('should prevent deleting non-existent profile', async () => {
      await expect(
        profileManager.deleteProfile('non-existent')
      ).rejects.toThrow("Profile 'non-existent' does not exist");
    });

    it('should mark profile for deletion when valid', async () => {
      await profileManager.createProfile('to-delete');

      // Should not throw
      await expect(
        profileManager.deleteProfile('to-delete')
      ).resolves.not.toThrow();
    });
  });

  describe('Configuration Updates', () => {
    it('should update profile last accessed time on switch', async () => {
      await profileManager.createProfile('test-profile');

      const configBefore = await fileSystem.getProfileConfig('test-profile');

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await profileManager.switchProfile('test-profile');

      const configAfter = await fileSystem.getProfileConfig('test-profile');

      expect(new Date(configAfter.lastAccessed).getTime()).toBeGreaterThan(
        new Date(configBefore.lastAccessed).getTime()
      );
    });

    it('should update last startup time', async () => {
      const configBefore = await fileSystem.readGlobalConfig();

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await profileManager.updateLastStartup();

      const configAfter = await fileSystem.readGlobalConfig();

      expect(new Date(configAfter.lastStartup).getTime()).toBeGreaterThan(
        new Date(configBefore.lastStartup).getTime()
      );
    });
  });
});
