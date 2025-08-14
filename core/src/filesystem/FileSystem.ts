import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import type { ProfileConfig, IgniteConfig } from '../types/index.js';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { FileSystemError, ErrorCodes } from '../types/errors.js';

import { getLogger } from '../utils/logger.js';

// Plugin registry type
export interface PluginRegistry {
  plugins: {
    [pluginId: string]: PluginMetadata;
  };
}

// Cross-platform filesystem management
// Handles ~/.ignite directory structure, profile creation, and path handling
export class FileSystem {
  private static instance: FileSystem;
  private readonly igniteHome: string;

  private constructor(customHome?: string) {
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

  static getInstance(customHome?: string): FileSystem {
    if (!FileSystem.instance) {
      FileSystem.instance = new FileSystem(customHome);
    }
    return FileSystem.instance;
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

  // === Profile Paths (keyed by immutable profile id) ===

  getProfilePath(profileId: string): string {
    return path.join(this.getProfilesPath(), profileId);
  }

  getProfileConfigPath(profileId: string): string {
    return path.join(this.getProfilePath(profileId), 'config.json');
  }

  getProfileReposPath(profileId: string): string {
    return path.join(this.getProfilePath(profileId), 'repos');
  }

  // === Archive Paths ===

  getArchivedProfilesPath(): string {
    return path.join(this.igniteHome, 'archive', 'profiles');
  }

  getArchivedProfilePath(profileId: string): string {
    return path.join(this.getArchivedProfilesPath(), profileId);
  }

  // === Plugin Paths ===

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

  // Get profile config (throws if it doesn't exist). Key by profile id
  async getProfileConfig(profileId: string): Promise<ProfileConfig> {
    const configPath = this.getProfileConfigPath(profileId);
    if (await this.fileExists(configPath)) {
      return this.readJsonFile<ProfileConfig>(configPath);
    }
    throw new FileSystemError(
      `Profile '${profileId}' does not exist`,
      ErrorCodes.PROFILE_NOT_FOUND,
      { profileId }
    );
  }

  // Create and persist a profile config (ensures directories exist)
  async createProfileConfig(
    profileId: string,
    config: ProfileConfig
  ): Promise<void> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profileId path within ~/.ignite
    await fs.mkdir(this.getProfilePath(profileId), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profileId path within ~/.ignite
    await fs.mkdir(this.getProfileReposPath(profileId), { recursive: true });
    await this.writeJsonFile(this.getProfileConfigPath(profileId), config);
  }

  // Create a new profile
  async createProfile(
    profileName: string,
    options?: { color?: string; icon?: string }
  ): Promise<ProfileConfig> {
    if (!this.isValidProfileName(profileName)) {
      throw new FileSystemError(
        `Invalid profile name: ${profileName}`,
        ErrorCodes.INVALID_PROFILE_NAME,
        { profileName }
      );
    }

    const profileId = crypto.randomUUID().slice(0, 8);
    const profilePath = this.getProfilePath(profileId);

    // Check if profile already exists
    if (await this.fileExists(profilePath)) {
      throw new FileSystemError(
        `Profile with ID '${profileId}' already exists`,
        ErrorCodes.PROFILE_ALREADY_EXISTS,
        { profileId }
      );
    }

    // Create profile directories using the UUID
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profileId is UUID, path is within ~/.ignite
    await fs.mkdir(profilePath, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profileId is UUID, path is within ~/.ignite
    await fs.mkdir(this.getProfileReposPath(profileId), { recursive: true });

    // Create profile config
    const nowIso = new Date().toISOString();
    const config: ProfileConfig = {
      id: profileId,
      name: profileName,
      color: options?.color ?? '#627eeb',
      icon: options?.icon ?? '',
      created: nowIso,
      lastUsed: nowIso,
    };

    await this.createProfileConfig(profileId, config);

    getLogger().info(`📁 Created profile: ${profileName} (ID: ${profileId})`);
    return config;
  }

  // List all profiles (ids)
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

    // Ensure default profile exists at first run
    const nowIso = new Date().toISOString();
    await this.createProfileConfig('default', {
      id: 'default',
      name: 'Default',
      color: '#627eeb',
      icon: '',
      created: nowIso,
      lastUsed: nowIso,
    });

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

  // Move a directory (rename)
  async moveDirectory(srcPath: string, destPath: string): Promise<void> {
    // Ensure destination parent exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: paths are constructed within ~/.ignite
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: paths are constructed within ~/.ignite
    await fs.rename(srcPath, destPath);
  }

  // Recursively delete a directory
  async deleteDirectory(dirPath: string): Promise<void> {
    await fs.rm(dirPath, { recursive: true, force: true });
  }
}
