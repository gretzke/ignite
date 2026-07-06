// Tests for ProfileManager class

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDirectory,
  cleanupTestDirectory,
  resetFilesystemSingletons,
} from '../setup.js';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { ProfileManager } from '../../filesystem/ProfileManager.js';

describe('ProfileManager', () => {
  let profileManager: ProfileManager;
  let fileSystem: FileSystem;
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    resetFilesystemSingletons();
    fileSystem = FileSystem.getInstance(testDir);
    profileManager = await ProfileManager.getInstance();
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
      expect(config.name).toBe('Default');
      expect(config.color).toBe('#627eeb');
      expect(config.icon).toBe('');
      expect(config.id).toBe('default');
      expect(config.created).toBeDefined();
      expect(config.lastUsed).toBeDefined();
    });
  });

  describe('Profile Operations', () => {
    it('should create new profile successfully', async () => {
      const created = await profileManager.createProfile('test-profile');
      expect(created.id).not.toBe('test-profile'); // ids are generated

      const profiles = await profileManager.listProfiles();
      const profileNames = profiles.map((p) => p.name);

      expect(profileNames).toContain('test-profile');
    });

    it('should switch profiles successfully (by id)', async () => {
      const created = await profileManager.createProfile('new-profile');
      await profileManager.switchProfile(created.id);

      expect(profileManager.getCurrentProfile()).toBe(created.id);

      // Check that global config was updated
      const globalConfig = await fileSystem.readGlobalConfig();
      expect(globalConfig.currentProfile).toBe(created.id);
    });

    it('should list profiles in filesystem id order, not last-used order', async () => {
      // Create profiles with delays to ensure different timestamps
      await profileManager.createProfile('profile1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      await profileManager.createProfile('profile2');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Switch to profile1 to update its lastUsed. This must NOT affect
      // ordering: listProfiles() preserves fileSystem.listProfiles() id
      // order and does not sort by lastUsed (see ProfileManager.listProfiles).
      const profiles1 = await profileManager.listProfiles();
      const p1 = profiles1.find((p) => p.name === 'profile1');
      await profileManager.switchProfile(p1!.id);

      const expectedIds = await fileSystem.listProfiles();
      const profiles = await profileManager.listProfiles();

      expect(profiles.map((p) => p.id)).toEqual(expectedIds);
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

    it('allows duplicate display names (profiles are keyed by generated id)', async () => {
      const first = await profileManager.createProfile('duplicate');
      const second = await profileManager.createProfile('duplicate');

      expect(first.id).not.toBe(second.id);
      expect(first.name).toBe(second.name);
    });
  });

  describe('Profile Deletion', () => {
    // There is no standalone last-profile guard: the last remaining profile
    // is necessarily the active one, so the active-profile guard covers it.
    it('should prevent deleting the last remaining profile (it is active)', async () => {
      // Only default exists at this point
      await expect(profileManager.deleteProfile('default')).rejects.toThrow(
        'Cannot delete the currently active profile'
      );
    });

    it('should prevent deleting currently active profile', async () => {
      const created = await profileManager.createProfile('active-profile');
      await profileManager.switchProfile(created.id);

      await expect(profileManager.deleteProfile(created.id)).rejects.toThrow(
        'Cannot delete the currently active profile'
      );
    });

    it('should prevent deleting non-existent profile', async () => {
      await expect(
        profileManager.deleteProfile('non-existent')
      ).rejects.toThrow("Profile 'non-existent' does not exist");
    });

    it('should mark profile for deletion when valid', async () => {
      const created = await profileManager.createProfile('to-delete');

      // Should not throw (default is active; the new profile is not)
      await expect(
        profileManager.deleteProfile(created.id)
      ).resolves.not.toThrow();
    });
  });

  describe('Configuration Updates', () => {
    it('should update profile last used time on switch', async () => {
      const created = await profileManager.createProfile('test-profile');

      const configBefore = await fileSystem.getProfileConfig(created.id);

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await profileManager.switchProfile(created.id);

      const configAfter = await fileSystem.getProfileConfig(created.id);

      expect(new Date(configAfter.lastUsed).getTime()).toBeGreaterThan(
        new Date(configBefore.lastUsed).getTime()
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
