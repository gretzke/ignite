import { promises as fs } from 'fs';
import path from 'path';
import { getLogger } from '../../utils/logger.js';
import { isGitUrl, extractBaseHost } from '@ignite/plugin-types';
import {
  discoverSSHKeys as discoverSSHKeysImpl,
  type SSHKeyInfo,
} from '../git/sshKeyDiscovery.js';
import {
  testSSHKeyAgainstRepo as testSSHKeyAgainstRepoImpl,
  extractRemoteUrl as extractRemoteUrlImpl,
} from '../git/sshKeyTester.js';
import { RepoPrivacyChecker } from '../git/RepoPrivacyChecker.js';

export type { SSHKeyInfo };

// Session cache for working SSH keys per repo
export interface SessionKeyCache {
  repoUrl: string; // Full repository URL for specific access
  workingKeyPath: string;
  testedAt: number;
}

export interface GitCredentialManagerDeps {
  discoverKeys: () => Promise<SSHKeyInfo[]>;
  testKey: (keyPath: string, repoUrl: string) => Promise<boolean>;
  extractRemoteUrl: (localPath: string) => Promise<string | null>;
  privacy: Pick<RepoPrivacyChecker, 'isRepoPublic'>;
  readFile: (p: string) => Promise<string>;
}

export class GitCredentialManager {
  private static instance: GitCredentialManager;
  private availableSSHKeys: SSHKeyInfo[] = [];
  private sessionKeyCache: Map<string, SessionKeyCache> = new Map();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private deps: GitCredentialManagerDeps;

  private constructor(deps?: Partial<GitCredentialManagerDeps>) {
    this.deps = {
      discoverKeys: deps?.discoverKeys ?? discoverSSHKeysImpl,
      testKey: deps?.testKey ?? testSSHKeyAgainstRepoImpl,
      extractRemoteUrl: deps?.extractRemoteUrl ?? extractRemoteUrlImpl,
      privacy: deps?.privacy ?? new RepoPrivacyChecker(),
      readFile:
        deps?.readFile ??
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        ((p) => fs.readFile(p, 'utf8')),
    };
  }

  static async getInstance(): Promise<GitCredentialManager> {
    if (!GitCredentialManager.instance) {
      GitCredentialManager.instance = new GitCredentialManager();
    }

    // Always ensure initialization is complete before returning
    await GitCredentialManager.instance.ensureInitialized();
    return GitCredentialManager.instance;
  }

  // Creates a non-singleton instance with injected deps, for tests.
  static async createForTest(
    deps?: Partial<GitCredentialManagerDeps>
  ): Promise<GitCredentialManager> {
    const instance = new GitCredentialManager(deps);
    await instance.ensureInitialized();
    return instance;
  }

  // Ensure initialization is complete (can be called multiple times safely)
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // If initialization is already in progress, wait for it
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    // Start initialization
    this.initializationPromise = this.initializeCredentials();
    await this.initializationPromise;
  }

  // Initialize credentials - discover SSH key paths only
  // Called automatically when instance is created
  private async initializeCredentials(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const logger = getLogger();
    logger.info('🔑 Discovering SSH keys...');

    try {
      this.availableSSHKeys = await this.deps.discoverKeys();

      const totalKeys = this.availableSSHKeys.length;
      const availableKeys = this.availableSSHKeys.filter(
        (key) => !key.isEncrypted
      ).length;
      const encryptedKeys = this.availableSSHKeys.filter(
        (key) => key.isEncrypted
      ).length;

      logger.info(
        `✅ Found ${totalKeys} SSH keys (${availableKeys} available, ${encryptedKeys} encrypted)`
      );

      // Log discovered keys (paths only, no sensitive data)
      for (const key of this.availableSSHKeys) {
        const status = key.isEncrypted
          ? '🔒 encrypted (skipped)'
          : '🔓 available';
        logger.info(
          `  ${path.basename(key.keyPath)} (${key.keyType}) ${status}`
        );
      }

      // Provide user guidance if we have encrypted keys
      if (encryptedKeys > 0) {
        logger.info(
          `ℹ️ Found ${encryptedKeys} encrypted SSH key(s). To use encrypted keys:`
        );
        logger.info('  1. Add keys to SSH agent: ssh-add ~/.ssh/id_rsa');
        logger.info('  2. Or use unencrypted keys for container access');
        logger.info('  3. Or configure GitHub token authentication');
      }

      // Warn if no available keys
      if (availableKeys === 0) {
        if (encryptedKeys > 0) {
          logger.warn(
            '⚠️ No unencrypted SSH keys available. Private repositories may not be accessible.'
          );
        } else {
          logger.warn(
            '⚠️ No SSH keys found. Only public repositories will be accessible.'
          );
        }
      }

      this.initialized = true;
    } catch (error) {
      logger.warn(
        `⚠️ Failed to discover SSH keys: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      // Clear the initialization promise
      this.initializationPromise = null;
    }
  }

  // Get available SSH keys (non-encrypted only for now)
  getAvailableSSHKeys(): SSHKeyInfo[] {
    return this.availableSSHKeys.filter((key) => !key.isEncrypted);
  }

  // Get encrypted SSH keys that are being skipped
  getEncryptedSSHKeys(): SSHKeyInfo[] {
    return this.availableSSHKeys.filter((key) => key.isEncrypted);
  }

  // Get detailed information about key availability for a specific operation
  getKeyAvailabilityInfo(): {
    total: number;
    available: number;
    encrypted: number;
    encryptedKeys: Array<{ name: string; type: string; path: string }>;
    hasUsableKeys: boolean;
    recommendations: string[];
  } {
    const availableKeys = this.getAvailableSSHKeys();
    const encryptedKeys = this.getEncryptedSSHKeys();

    const recommendations: string[] = [];

    if (encryptedKeys.length > 0) {
      recommendations.push(
        'Add encrypted keys to SSH agent: ssh-add ~/.ssh/id_rsa'
      );
      recommendations.push('Use unencrypted keys for Docker container access');
      recommendations.push(
        'Configure GitHub Personal Access Token authentication'
      );
    }

    if (availableKeys.length === 0 && encryptedKeys.length === 0) {
      recommendations.push(
        'Generate SSH keys: ssh-keygen -t ed25519 -C "your-email@example.com"'
      );
      recommendations.push('Add public key to your Git hosting service');
    }

    return {
      total: this.availableSSHKeys.length,
      available: availableKeys.length,
      encrypted: encryptedKeys.length,
      encryptedKeys: encryptedKeys.map((key) => ({
        name: path.basename(key.keyPath),
        type: key.keyType,
        path: key.keyPath,
      })),
      hasUsableKeys: availableKeys.length > 0,
      recommendations,
    };
  }

  // Find working SSH key for a repository URL
  // Tests keys against the specific repository and returns the first working key
  // Uses session cache to avoid retesting keys
  async findWorkingSSHKey(repoUrl: string): Promise<SSHKeyInfo | null> {
    const logger = getLogger();

    // Extract base host for caching purposes
    const baseHost = extractBaseHost(repoUrl);
    if (!baseHost) {
      logger.debug(`Could not extract base host from URL: ${repoUrl}`);
      return null;
    }

    // Check session cache first (cache by repository URL for specificity)
    const cachedKey = this.getSessionCachedKey(repoUrl);
    if (cachedKey) {
      logger.debug(
        `📋 Using cached SSH key for ${repoUrl}: ${path.basename(cachedKey.keyPath)}`
      );
      return cachedKey;
    }

    logger.debug(`🔍 Testing SSH keys against repository: ${repoUrl}`);

    // Get available (non-encrypted) SSH keys
    const availableKeys = this.getAvailableSSHKeys();
    const totalKeys = this.availableSSHKeys.length;
    const encryptedKeys = this.availableSSHKeys.filter(
      (key) => key.isEncrypted
    ).length;

    if (availableKeys.length === 0) {
      if (encryptedKeys > 0) {
        logger.warn(
          `❌ No unencrypted SSH keys available for ${repoUrl} (${encryptedKeys} encrypted keys skipped)`
        );
        logger.info(
          '💡 To use encrypted keys, add them to SSH agent or use unencrypted keys'
        );
      } else if (totalKeys > 0) {
        logger.debug(
          `No usable SSH keys found for ${repoUrl} (all ${totalKeys} keys are encrypted)`
        );
      } else {
        logger.debug(`No SSH keys discovered for testing against ${repoUrl}`);
      }
      return null;
    }

    // Test each key against the specific repository
    for (const key of availableKeys) {
      logger.debug(`🔑 Testing key: ${path.basename(key.keyPath)}`);

      try {
        const works = await this.deps.testKey(key.keyPath, repoUrl);
        if (works) {
          logger.info(
            `✅ Found working SSH key for ${repoUrl}: ${path.basename(key.keyPath)}`
          );

          // Cache the working key for this session (by repository URL)
          this.cacheSessionKey(repoUrl, key);

          return key;
        } else {
          logger.debug(
            `❌ SSH key ${path.basename(key.keyPath)} doesn't have access to ${repoUrl}`
          );
        }
      } catch (error) {
        logger.debug(
          `❌ Error testing SSH key ${path.basename(key.keyPath)}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }

    logger.debug(`❌ No working SSH keys found for ${repoUrl}`);

    // TODO: implement fallback to other methods here
    // - GitHub Personal Access Tokens
    // - Git credential helpers
    // - Environment variables (GITHUB_TOKEN, etc.)

    return null;
  }

  // Cache working SSH key for a repository during this session
  private cacheSessionKey(repoUrl: string, workingKey: SSHKeyInfo): void {
    const cacheEntry: SessionKeyCache = {
      repoUrl: repoUrl,
      workingKeyPath: workingKey.keyPath,
      testedAt: Date.now(),
    };

    this.sessionKeyCache.set(repoUrl, cacheEntry);

    getLogger().debug(
      `💾 Cached SSH key for ${repoUrl}: ${path.basename(workingKey.keyPath)}`
    );
  }

  // Get cached SSH key for a repository if available and still valid
  private getSessionCachedKey(repoUrl: string): SSHKeyInfo | null {
    const cached = this.sessionKeyCache.get(repoUrl);
    if (!cached) {
      return null;
    }

    // Find the SSH key info for the cached key path
    const keyInfo = this.availableSSHKeys.find(
      (key) => key.keyPath === cached.workingKeyPath
    );
    if (!keyInfo) {
      // Key no longer available, remove from cache
      this.sessionKeyCache.delete(repoUrl);
      return null;
    }

    // Check if key is still available (not encrypted)
    if (keyInfo.isEncrypted) {
      // Key became encrypted, remove from cache
      this.sessionKeyCache.delete(repoUrl);
      return null;
    }

    return keyInfo;
  }

  // Clear session cache (useful for testing or when SSH keys change)
  clearSessionCache(): void {
    const cacheSize = this.sessionKeyCache.size;
    this.sessionKeyCache.clear();
    getLogger().debug(`🗑️ Cleared session key cache (${cacheSize} entries)`);
  }

  // Clear cached key for a specific repository (useful when a cached key fails)
  clearCachedKeyForRepo(repoUrl: string): void {
    if (this.sessionKeyCache.has(repoUrl)) {
      const cached = this.sessionKeyCache.get(repoUrl);
      this.sessionKeyCache.delete(repoUrl);
      getLogger().debug(
        `🗑️ Cleared cached key for ${repoUrl}: ${cached ? path.basename(cached.workingKeyPath) : 'unknown'}`
      );
    }
  }

  // Find working SSH key for repository (handles both URLs and local paths)
  // For local repositories, extracts remote URL first
  async findWorkingSSHKeyForRepo(
    pathOrUrl: string
  ): Promise<SSHKeyInfo | null> {
    const logger = getLogger();
    let targetUrl = pathOrUrl;

    // If it's a local path, extract the remote URL
    if (!isGitUrl(pathOrUrl)) {
      logger.debug(`📁 Local repository detected: ${pathOrUrl}`);
      const remoteUrl = await this.deps.extractRemoteUrl(pathOrUrl);

      if (!remoteUrl) {
        logger.debug(
          `❌ No remote URL found for local repository: ${pathOrUrl}`
        );
        return null;
      }

      targetUrl = remoteUrl;
      logger.debug(`📡 Using remote URL: ${remoteUrl}`);
    }

    return await this.findWorkingSSHKey(targetUrl);
  }

  // Get SSH credentials for Docker container injection
  // Returns key content for a specific repository/path
  // Only tests SSH keys if the repository is actually private
  async getSSHCredentialsForContainer(
    pathOrUrl: string
  ): Promise<{ privateKey: string; publicKey: string } | null> {
    const logger = getLogger();

    // First, determine the target URL (handle local repos)
    let targetUrl = pathOrUrl;
    if (!isGitUrl(pathOrUrl)) {
      logger.debug(`📁 Local repository detected: ${pathOrUrl}`);
      const remoteUrl = await this.deps.extractRemoteUrl(pathOrUrl);

      if (!remoteUrl) {
        logger.debug(
          `❌ No remote URL found for local repository: ${pathOrUrl}`
        );
        return null;
      }

      targetUrl = remoteUrl;
      logger.debug(`📡 Using remote URL: ${remoteUrl}`);
    }

    // Check if repository is public - if so, no credentials needed
    const isPublic = await this.isRepoPublic(targetUrl);
    if (isPublic === true) {
      logger.debug(
        `📖 Repository is public, no SSH credentials needed: ${targetUrl}`
      );
      return null;
    }

    if (isPublic === null) {
      logger.debug(
        `❓ Could not determine repository privacy for: ${targetUrl}, attempting SSH key lookup anyway`
      );
    } else {
      logger.debug(
        `🔒 Repository is private, finding SSH credentials: ${targetUrl}`
      );
    }

    // Find working SSH key for this repository
    const workingKey = await this.findWorkingSSHKey(targetUrl);
    if (!workingKey) {
      if (isPublic === false) {
        logger.warn(
          `❌ Private repository requires SSH credentials but none found: ${targetUrl}`
        );
      } else {
        logger.debug(`No working SSH key found for: ${targetUrl}`);
      }
      return null;
    }

    try {
      // Read the actual key content for Docker container use
      const privateKey = await this.deps.readFile(workingKey.keyPath);
      const publicKey = await this.deps.readFile(workingKey.publicKeyPath);

      logger.debug(
        `📤 Providing SSH credentials for container: ${path.basename(workingKey.keyPath)}`
      );

      return {
        privateKey,
        publicKey,
      };
    } catch (error) {
      logger.error(
        `Failed to read SSH key content: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Check if SSH credentials are available for a repository
   * Useful for determining if private repo operations will work
   * Only tests SSH keys if the repository is actually private
   */
  async hasSSHCredentialsForRepo(pathOrUrl: string): Promise<boolean> {
    // First, determine the target URL (handle local repos)
    let targetUrl = pathOrUrl;
    if (!isGitUrl(pathOrUrl)) {
      const remoteUrl = await this.deps.extractRemoteUrl(pathOrUrl);
      if (!remoteUrl) {
        return false;
      }
      targetUrl = remoteUrl;
    }

    // Check if repository is public - if so, no credentials needed
    const isPublic = await this.isRepoPublic(targetUrl);
    if (isPublic === true) {
      return true; // Public repos don't need credentials - access is available
    }

    // For private repos (or unknown), check if we have working SSH keys
    const workingKey = await this.findWorkingSSHKey(targetUrl);
    return workingKey !== null;
  }

  // Check if a repository is public or private
  // Delegates to the injected RepoPrivacyChecker (which handles caching).
  async isRepoPublic(repoUrl: string): Promise<boolean | null> {
    return this.deps.privacy.isRepoPublic(repoUrl);
  }

  // Get debug information about discovered SSH keys and session cache
  getSSHKeyInfo(): {
    initialized: boolean;
    totalKeys: number;
    availableKeys: number;
    encryptedKeys: number;
    sessionCache: {
      size: number;
      entries: Array<{ repoUrl: string; keyName: string; testedAt: number }>;
    };
  } {
    const encryptedKeys = this.availableSSHKeys.filter(
      (key) => key.isEncrypted
    ).length;
    const availableKeys = this.availableSSHKeys.filter(
      (key) => !key.isEncrypted
    ).length;

    // Build session cache info
    const cacheEntries = Array.from(this.sessionKeyCache.entries()).map(
      ([repoUrl, cache]) => ({
        repoUrl,
        keyName: path.basename(cache.workingKeyPath),
        testedAt: cache.testedAt,
      })
    );

    return {
      initialized: this.initialized,
      totalKeys: this.availableSSHKeys.length,
      availableKeys,
      encryptedKeys,
      sessionCache: {
        size: this.sessionKeyCache.size,
        entries: cacheEntries,
      },
    };
  }
}
