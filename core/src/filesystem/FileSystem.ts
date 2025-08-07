import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type {
  ProfileConfig,
  TrustDatabase,
  PluginRegistry,
  IgniteConfig,
} from '../types/index.js';
import { FileSystemError, ErrorCodes } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';

// Cross-platform filesystem management
// Handles ~/.ignite directory structure, profile creation, and path handling
export class FileSystem {
  private readonly igniteHome: string;

  constructor(customHome?: string) {
    if (customHome) {
      // used for unit tests
      this.igniteHome = customHome;
    } else {
      // Cross-platform home directory handling
      // Use .ignite_dev in development mode for isolation
      const suffix = process.env.NODE_ENV === 'development' ? '_dev' : '';
      this.igniteHome = path.join(os.homedir(), `.ignite${suffix}`);
    }
  }

  // === Core Path Getters ===

  getIgniteHome(): string {
    return this.igniteHome;
  }

  getPluginsPath(): string {
    return path.join(this.igniteHome, 'plugins');
  }

  getProfilesPath(): string {
    return path.join(this.igniteHome, 'profiles');
  }

  getCachePath(): string {
    return path.join(this.igniteHome, 'cache');
  }

  // === Profile Paths ===

  getProfilePath(profileName: string): string {
    return path.join(this.getProfilesPath(), profileName);
  }

  getProfileConfigPath(profileName: string): string {
    return path.join(this.getProfilePath(profileName), 'config.json');
  }

  getProfileReposPath(profileName: string): string {
    return path.join(this.getProfilePath(profileName), 'repos');
  }

  // === Plugin Paths ===

  getTrustPath(): string {
    return path.join(this.getPluginsPath(), 'trust.json');
  }

  getRegistryPath(): string {
    return path.join(this.getPluginsPath(), 'registry.json');
  }

  getPluginInstallPath(pluginId: string): string {
    return path.join(this.getPluginsPath(), 'installed', pluginId);
  }

  getPluginConfigPath(pluginId: string): string {
    return path.join(this.getPluginInstallPath(pluginId), 'config.json');
  }

  // === Global Config ===

  getGlobalConfigPath(): string {
    return path.join(this.igniteHome, 'config.json');
  }

  // === Directory Creation ===

  // === Profile Management ===

  // Get profile config, auto-create default profile if it doesn't exist
  async getProfileConfig(profileName: string): Promise<ProfileConfig> {
    const configPath = this.getProfileConfigPath(profileName);

    // Try to read existing config
    if (await this.fileExists(configPath)) {
      return this.readJsonFile<ProfileConfig>(configPath);
    }

    // Only auto-create default profile
    if (profileName === 'default') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: hardcoded 'default' profile path
      await fs.mkdir(this.getProfilePath('default'), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: hardcoded 'default' profile path
      await fs.mkdir(this.getProfileReposPath('default'), { recursive: true });

      const defaultConfig: ProfileConfig = {
        name: 'default',
        created: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
      };

      await this.writeJsonFile(configPath, defaultConfig);

      getLogger().info('📁 Created default profile');

      return defaultConfig;
    }

    // Non-default profile doesn't exist
    throw new FileSystemError(
      `Profile '${profileName}' does not exist`,
      ErrorCodes.PROFILE_NOT_FOUND,
      { profileName }
    );
  }

  // Create a new profile
  async createProfile(profileName: string): Promise<void> {
    if (!this.isValidProfileName(profileName)) {
      throw new FileSystemError(
        `Invalid profile name: ${profileName}`,
        ErrorCodes.INVALID_PROFILE_NAME,
        { profileName }
      );
    }

    const profilePath = this.getProfilePath(profileName);

    // Check if profile already exists
    if (await this.fileExists(profilePath)) {
      throw new FileSystemError(
        `Profile '${profileName}' already exists`,
        ErrorCodes.PROFILE_ALREADY_EXISTS,
        { profileName }
      );
    }

    // Create profile directories
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profileName is validated, path is within ~/.ignite
    await fs.mkdir(profilePath, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profileName is validated, path is within ~/.ignite
    await fs.mkdir(this.getProfileReposPath(profileName), { recursive: true });

    // Create profile config
    const config: ProfileConfig = {
      name: profileName,
      created: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
    };

    await this.writeJsonFile(this.getProfileConfigPath(profileName), config);

    getLogger().info(`📁 Created profile: ${profileName}`);
  }

  // List all profiles
  async listProfiles(): Promise<string[]> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: fixed profiles directory path
      const entries = await fs.readdir(this.getProfilesPath());
      const profiles: string[] = [];

      for (const entry of entries) {
        const entryPath = path.join(this.getProfilesPath(), entry);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path constructed from profiles dir + validated entry
        const stats = await fs.stat(entryPath);
        if (stats.isDirectory()) {
          profiles.push(entry);
        }
      }

      return profiles.sort();
    } catch (error) {
      getLogger().error('Failed to list profiles:', error);
      return [];
    }
  }

  // Validate profile name
  private isValidProfileName(name: string): boolean {
    // Basic validation: alphanumeric, hyphens, underscores, no spaces
    return (
      /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 50
    );
  }

  // === Configuration File Management ===

  // Read trust database, create default if doesn't exist
  async readTrustDatabase(): Promise<TrustDatabase> {
    const trustPath = this.getTrustPath();

    if (await this.fileExists(trustPath)) {
      return this.readJsonFile<TrustDatabase>(trustPath);
    }

    // Create default trust database
    const emptyTrustDb: TrustDatabase = {};
    await this.writeJsonFile(trustPath, emptyTrustDb);

    getLogger().info('🔒 Created trust database');

    return emptyTrustDb;
  }

  // Read plugin registry, create default if doesn't exist
  async readPluginRegistry(): Promise<PluginRegistry> {
    const registryPath = this.getRegistryPath();

    if (await this.fileExists(registryPath)) {
      return this.readJsonFile<PluginRegistry>(registryPath);
    }

    // Create default plugin registry
    const emptyRegistry: PluginRegistry = {
      plugins: {},
    };
    await this.writeJsonFile(registryPath, emptyRegistry);

    getLogger().info('📦 Created plugin registry');

    return emptyRegistry;
  }

  // Read global config, create default if doesn't exist
  async readGlobalConfig(): Promise<IgniteConfig> {
    const configPath = this.getGlobalConfigPath();

    if (await this.fileExists(configPath)) {
      return this.readJsonFile<IgniteConfig>(configPath);
    }

    // Create default global config
    const defaultConfig: IgniteConfig = {
      version: '1.0.0', // TODO: pull from package.json at compile time? Is this even needed?
      currentProfile: 'default',
      lastStartup: new Date().toISOString(),
    };
    await this.writeJsonFile(configPath, defaultConfig);

    getLogger().info('⚙️ Created global config');

    return defaultConfig;
  }

  // === File I/O Helpers ===

  // Safely read and parse JSON file
  async readJsonFile<T>(filePath: string): Promise<T> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: paths are constructed within ~/.ignite
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content) as T;
    } catch (error) {
      throw new Error(`Failed to read JSON file ${filePath}: ${error}`);
    }
  }

  // Safely write JSON file
  async writeJsonFile<T>(filePath: string, data: T): Promise<void> {
    try {
      // Ensure parent directory exists
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: paths are constructed within ~/.ignite
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: paths are constructed within ~/.ignite
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      throw new Error(`Failed to write JSON file ${filePath}: ${error}`);
    }
  }

  // Check if file exists
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
