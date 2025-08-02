import { FileSystem } from './FileSystem.js';
import type { ProfileConfig, IgniteConfig } from '../types/index.js';
import { ProfileError, ErrorCodes } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';

// Manages profiles within the Ignite ecosystem
// Handles profile switching, configuration, and lifecycle
export class ProfileManager {
  private fileSystem: FileSystem;
  private currentProfile: string = 'default';

  constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
  }

  // Initialize profile manager and load current profile
  async initialize(): Promise<void> {
    try {
      // Load global config (will auto-create if doesn't exist)
      const globalConfig = await this.fileSystem.readGlobalConfig();
      this.currentProfile = globalConfig.currentProfile || 'default';

      // Ensure the current profile exists (will auto-create default if needed)
      await this.fileSystem.getProfileConfig(this.currentProfile);

      // Update last startup time
      await this.updateLastStartup();

      getLogger().info(`📂 Current profile: ${this.currentProfile}`);
    } catch (error) {
      getLogger().error('Failed to initialize profile manager:', error);
      // Fall back to default profile
      this.currentProfile = 'default';
    }
  }

  // Get current profile name
  getCurrentProfile(): string {
    return this.currentProfile;
  }

  // Get current profile configuration
  async getCurrentProfileConfig(): Promise<ProfileConfig> {
    return this.getProfileConfig(this.currentProfile);
  }

  // Get profile configuration by name
  async getProfileConfig(profileName: string): Promise<ProfileConfig> {
    // Use FileSystem's smart getter that auto-creates default profile
    const config = await this.fileSystem.getProfileConfig(profileName);

    // Update last accessed time
    config.lastAccessed = new Date().toISOString();
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getProfileConfigPath(profileName),
      config
    );

    return config;
  }

  // Switch to a different profile
  async switchProfile(profileName: string): Promise<void> {
    // Validate profile exists using FileSystem's smart getter
    // This will throw appropriate error if profile doesn't exist
    await this.fileSystem.getProfileConfig(profileName);

    // Update current profile
    this.currentProfile = profileName;

    // Update global config
    const globalConfig = await this.getGlobalConfig();
    globalConfig.currentProfile = profileName;
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getGlobalConfigPath(),
      globalConfig
    );

    // Update profile's last accessed time
    await this.getProfileConfig(profileName);

    getLogger().info(`🔄 Switched to profile: ${profileName}`);
  }

  // Create a new profile
  async createProfile(profileName: string): Promise<void> {
    await this.fileSystem.createProfile(profileName);
  }

  // List all available profiles
  async listProfiles(): Promise<ProfileConfig[]> {
    const profileNames = await this.fileSystem.listProfiles();
    const profiles: ProfileConfig[] = [];

    for (const name of profileNames) {
      try {
        // Use FileSystem's smart getter
        const config = await this.fileSystem.getProfileConfig(name);
        profiles.push(config);
      } catch (error) {
        getLogger().warn(`Failed to load config for profile '${name}':`, error);
      }
    }

    // Sort by last accessed (most recent first)
    profiles.sort(
      (a, b) =>
        new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
    );

    return profiles;
  }

  // Archive and delete a profile (except default)
  async deleteProfile(profileName: string): Promise<void> {
    if (profileName === 'default') {
      throw new ProfileError(
        'Cannot delete the default profile',
        ErrorCodes.CANNOT_DELETE_DEFAULT_PROFILE,
        { profileName }
      );
    }

    if (profileName === this.currentProfile) {
      throw new ProfileError(
        'Cannot delete the currently active profile',
        ErrorCodes.CANNOT_DELETE_ACTIVE_PROFILE,
        { profileName }
      );
    }

    const profilePath = this.fileSystem.getProfilePath(profileName);

    if (!(await this.fileSystem.fileExists(profilePath))) {
      throw new ProfileError(
        `Profile '${profileName}' does not exist`,
        ErrorCodes.PROFILE_NOT_FOUND,
        { profileName }
      );
    }

    // Archive profile before deletion
    await this.archiveProfile(profileName);

    // TODO: Implement actual profile deletion after archiving
    getLogger().info(
      `🗑️  Profile '${profileName}' archived and marked for deletion`
    );
  }

  // Archive a profile for safe deletion
  private async archiveProfile(profileName: string): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath =
      this.fileSystem.getIgniteHome() + `/archive/${profileName}_${timestamp}`;

    // TODO: Implement profile archiving (copy to archive directory)
    getLogger().info(`📦 Archiving profile '${profileName}' to ${archivePath}`);
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
