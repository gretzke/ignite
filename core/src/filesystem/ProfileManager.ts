import fs from 'fs/promises';
import path from 'path';
import { FileSystem } from './FileSystem.js';
import type { ProfileConfig, IgniteConfig } from '../types/index.js';
import { ProfileError, ErrorCodes } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';

// Manages profiles within the Ignite ecosystem
// Handles profile switching, configuration, and lifecycle
export class ProfileManager {
  private static instance: ProfileManager;
  private fileSystem: FileSystem;
  private currentProfile: string = 'default'; // stores profile id

  private constructor() {
    this.fileSystem = FileSystem.getInstance();
  }

  static async getInstance(): Promise<ProfileManager> {
    if (!ProfileManager.instance) {
      ProfileManager.instance = new ProfileManager();
      await this.instance.initialize();
    }
    return ProfileManager.instance;
  }

  // Initialize profile manager and load current profile
  private async initialize(): Promise<void> {
    try {
      // Load global config (will auto-create if doesn't exist)
      const globalConfig = await this.fileSystem.readGlobalConfig();
      this.currentProfile = globalConfig.currentProfile || 'default';

      // Ensure the current profile exists; if not, create default
      try {
        await this.fileSystem.getProfileConfig(this.currentProfile);
      } catch {
        // create default profile
        await this.fileSystem.getProfileConfig('default');
        this.currentProfile = 'default';
      }

      // Update last startup time
      await this.updateLastStartup();

      getLogger().info(`📂 Current profile: ${this.currentProfile}`);
    } catch (error) {
      getLogger().error('Failed to initialize profile manager:', error);
      // Fall back to default profile
      this.currentProfile = 'default';
    }
  }

  // Get current profile id
  getCurrentProfile(): string {
    return this.currentProfile;
  }

  // Get current profile configuration
  async getCurrentProfileConfig(): Promise<ProfileConfig> {
    return this.getProfileConfig(this.currentProfile);
  }

  // Get profile configuration by id
  async getProfileConfig(profileId: string): Promise<ProfileConfig> {
    // Use FileSystem's smart getter that auto-creates default profile
    const config = await this.fileSystem.getProfileConfig(profileId);
    return config;
  }

  // Switch to a different profile
  async switchProfile(profileId: string): Promise<void> {
    // Validate profile exists using FileSystem's smart getter
    // This will throw appropriate error if profile doesn't exist
    await this.fileSystem.getProfileConfig(profileId);

    // Update current profile
    this.currentProfile = profileId;

    // Update global config
    const globalConfig = await this.getGlobalConfig();
    globalConfig.currentProfile = profileId;
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getGlobalConfigPath(),
      globalConfig
    );

    // Update profile's last used time
    const config = await this.fileSystem.getProfileConfig(profileId);
    const updated: ProfileConfig = {
      ...config,
      lastUsed: new Date().toISOString(),
    };
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getProfileConfigPath(profileId),
      updated
    );

    getLogger().info(`🔄 Switched to profile: ${profileId}`);
  }

  // Create a new profile
  async createProfile(
    profileName: string,
    options?: { color?: string; icon?: string }
  ): Promise<ProfileConfig> {
    return await this.fileSystem.createProfile(profileName, options);
  }

  // List all available profiles
  async listProfiles(): Promise<ProfileConfig[]> {
    const profileIds = await this.fileSystem.listProfiles();
    const profiles: ProfileConfig[] = [];

    for (const id of profileIds) {
      try {
        // Use FileSystem's smart getter
        const config = await this.fileSystem.getProfileConfig(id);
        profiles.push(config);
      } catch (error) {
        getLogger().warn(`Failed to load config for profile '${id}':`, error);
      }
    }

    // No sorting: the wire contract preserves fileSystem.listProfiles() id
    // order (the old /profiles handler never sorted).
    return profiles;
  }

  // List config of every archived profile; unreadable entries are skipped.
  async listArchivedProfiles(): Promise<ProfileConfig[]> {
    const archivedRoot = this.fileSystem.getArchivedProfilesPath();
    const profiles: ProfileConfig[] = [];
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: derived from ~/.ignite
      const entries = await fs.readdir(archivedRoot);
      for (const id of entries) {
        const p = path.join(archivedRoot, id);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: derived from ~/.ignite
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          const cfgPath = path.join(p, 'config.json');
          profiles.push(await this.fileSystem.readJsonFile<ProfileConfig>(cfgPath));
        }
      }
    } catch {
      return [];
    }
    return profiles;
  }

  // Merge partial updates onto the stored config and persist via editProfile.
  async updateProfile(
    id: string,
    updates: { name?: string; color?: string; icon?: string }
  ): Promise<ProfileConfig> {
    const current = await this.getProfileConfig(id);
    const updated: ProfileConfig = {
      ...current,
      name: updates.name ?? current.name,
      color: updates.color ?? current.color,
      icon: updates.icon ?? current.icon,
    };
    await this.editProfile(id, updated);
    return updated;
  }

  // Archive and delete a profile
  async deleteProfile(profileId: string): Promise<void> {
    // If archived profile with this id exists, delete it
    const archivedPath = this.fileSystem.getArchivedProfilePath(profileId);
    if (await this.fileSystem.fileExists(archivedPath)) {
      await this.fileSystem.deleteDirectory(archivedPath);
      getLogger().info(`🗑️  Deleted archived profile '${profileId}'`);
      return;
    }

    // Otherwise, handle live profile
    if (profileId === this.currentProfile) {
      throw new ProfileError(
        'Cannot delete the currently active profile',
        ErrorCodes.CANNOT_DELETE_ACTIVE_PROFILE,
        { profileId }
      );
    }

    const profilePath = this.fileSystem.getProfilePath(profileId);
    if (!(await this.fileSystem.fileExists(profilePath))) {
      throw new ProfileError(
        `Profile '${profileId}' does not exist`,
        ErrorCodes.PROFILE_NOT_FOUND,
        { profileId }
      );
    }

    // Archive then permanently delete archived directory
    const config = await this.fileSystem.getProfileConfig(profileId);
    await this.archiveProfile(profileId);
    const archivedPathAfter = this.fileSystem.getArchivedProfilePath(config.id);
    await this.fileSystem.deleteDirectory(archivedPathAfter);
    getLogger().info(`🗑️  Profile '${profileId}' deleted`);
  }

  // Archive a profile for safe deletion. Permissive by design (matches the
  // old handler's inline behavior): callers that need to protect the active
  // profile (e.g. deleteProfile) enforce that guard themselves before calling.
  async archiveProfile(profileId: string): Promise<void> {
    // Move dir to archive using profile id to prevent name collisions
    const config = await this.fileSystem.getProfileConfig(profileId);
    const srcPath = this.fileSystem.getProfilePath(profileId);
    const destPath = this.fileSystem.getArchivedProfilePath(config.id);
    await this.fileSystem.moveDirectory(srcPath, destPath);
    getLogger().info(`📦 Archived profile '${profileId}' (${config.id})`);
  }

  // Restore an archived profile by id (no renaming here)
  async restoreProfile(profileId: string): Promise<void> {
    const archivedPath = this.fileSystem.getArchivedProfilePath(profileId);
    if (!(await this.fileSystem.fileExists(archivedPath))) {
      throw new ProfileError(
        `Archived profile '${profileId}' does not exist`,
        ErrorCodes.PROFILE_NOT_FOUND,
        { profileId }
      );
    }
    // Ensure no live profile with this id exists already
    if (
      await this.fileSystem.fileExists(
        this.fileSystem.getProfilePath(profileId)
      )
    ) {
      throw new ProfileError(
        `Profile '${profileId}' already exists`,
        ErrorCodes.PROFILE_ALREADY_EXISTS,
        { profileId }
      );
    }
    // Move archived dir back to live by id
    const livePath = FileSystem.getInstance().getProfilePath(profileId);
    await FileSystem.getInstance().moveDirectory(archivedPath, livePath);
    getLogger().info(`♻️  Restored profile '${profileId}'`);
  }

  // Edit any live profile by id: overwrite config with provided data (id is enforced)
  async editProfile(
    profileId: string,
    newConfig: ProfileConfig
  ): Promise<void> {
    const configPath = this.fileSystem.getProfileConfigPath(profileId);
    if (!(await this.fileSystem.fileExists(configPath))) {
      throw new ProfileError(
        `Profile '${profileId}' does not exist`,
        ErrorCodes.PROFILE_NOT_FOUND,
        { profileId }
      );
    }
    const sanitized: ProfileConfig = { ...newConfig, id: profileId };
    await this.fileSystem.writeJsonFile(configPath, sanitized);
    getLogger().info(`✏️  Edited profile '${profileId}'`);
  }

  // Get global configuration
  private async getGlobalConfig(): Promise<IgniteConfig> {
    // Use FileSystem's smart getter that auto-creates if needed
    return this.fileSystem.readGlobalConfig();
  }

  // Update last startup time
  async updateLastStartup(): Promise<void> {
    const globalConfig = await this.getGlobalConfig();
    globalConfig.lastStartup = new Date().toISOString();
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getGlobalConfigPath(),
      globalConfig
    );
  }

  // Get profile paths for current profile
  getCurrentProfilePaths() {
    return {
      root: this.fileSystem.getProfilePath(this.currentProfile),
      config: this.fileSystem.getProfileConfigPath(this.currentProfile),
      repos: this.fileSystem.getProfileReposPath(this.currentProfile),
    };
  }
}
