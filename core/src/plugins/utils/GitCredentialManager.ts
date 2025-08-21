import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { getLogger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

// SSH key metadata - no private key content stored
export interface SSHKeyInfo {
  keyPath: string;
  publicKeyPath: string;
  keyType: string; // rsa, ed25519, ecdsa, etc.
  isEncrypted: boolean;
  fingerprint?: string;
}

// Session cache for working SSH keys per repo
export interface SessionKeyCache {
  repoUrl: string; // Full repository URL for specific access
  workingKeyPath: string;
  testedAt: number;
}

// Repository privacy status
export interface RepoPrivacyInfo {
  repoUrl: string;
  isPublic: boolean | null; // null = unknown/error
  checkedAt: number;
  method: 'github_api' | 'git_test' | 'unknown';
}

export class GitCredentialManager {
  private static instance: GitCredentialManager;
  private availableSSHKeys: SSHKeyInfo[] = [];
  private sessionKeyCache: Map<string, SessionKeyCache> = new Map();
  private repoPrivacyCache: Map<string, RepoPrivacyInfo> = new Map();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  private constructor() {}

  static async getInstance(): Promise<GitCredentialManager> {
    if (!GitCredentialManager.instance) {
      GitCredentialManager.instance = new GitCredentialManager();
    }

    // Always ensure initialization is complete before returning
    await GitCredentialManager.instance.ensureInitialized();
    return GitCredentialManager.instance;
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
      this.availableSSHKeys = await this.discoverSSHKeys();

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

  // Discover all SSH keys in ~/.ssh directory
  // Returns metadata only, no private key content
  private async discoverSSHKeys(): Promise<SSHKeyInfo[]> {
    const logger = getLogger();
    const sshDir = path.join(os.homedir(), '.ssh');
    const sshKeys: SSHKeyInfo[] = [];

    try {
      await fs.access(sshDir);
      logger.debug(`🔍 Scanning SSH directory: ${sshDir}`);
    } catch {
      logger.debug('~/.ssh directory not found');
      return [];
    }

    // Read all files in .ssh directory
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sshFiles = await fs.readdir(sshDir);

    // Find all private key files (files that have corresponding .pub files)
    const privateKeyFiles = sshFiles.filter((file) => {
      // Skip .pub files, known_hosts, config, etc.
      if (
        file.includes('.') ||
        file === 'config' ||
        file === 'known_hosts' ||
        file === 'authorized_keys'
      ) {
        return false;
      }

      // Check if corresponding .pub file exists
      return sshFiles.includes(`${file}.pub`);
    });

    for (const keyFile of privateKeyFiles) {
      const keyPath = path.join(sshDir, keyFile);
      const publicKeyPath = `${keyPath}.pub`;

      try {
        // Check if both private and public key are readable
        await fs.access(keyPath, fs.constants.R_OK);
        await fs.access(publicKeyPath, fs.constants.R_OK);

        // Determine key type and encryption status
        const keyType = this.extractKeyType(keyFile);
        const isEncrypted = await this.isKeyEncrypted(keyPath);
        const fingerprint = await this.getKeyFingerprint(publicKeyPath);

        sshKeys.push({
          keyPath,
          publicKeyPath,
          keyType,
          isEncrypted,
          fingerprint,
        });

        logger.debug(`📋 Discovered SSH key: ${keyFile} (${keyType})`);
      } catch (error) {
        logger.debug(
          `❌ SSH key ${keyFile} not accessible: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return sshKeys;
  }

  // Extract key type from filename
  private extractKeyType(keyName: string): string {
    if (keyName.includes('ed25519')) return 'ed25519';
    if (keyName.includes('rsa')) return 'rsa';
    if (keyName.includes('ecdsa')) return 'ecdsa';
    if (keyName.includes('dsa')) return 'dsa';
    return 'unknown';
  }

  // Check if SSH private key is encrypted
  private async isKeyEncrypted(keyPath: string): Promise<boolean> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const keyContent = await fs.readFile(keyPath, 'utf8');
      return keyContent.includes('ENCRYPTED');
    } catch {
      return true; // Assume encrypted if we can't read it
    }
  }

  // Get SSH key fingerprint from public key
  private async getKeyFingerprint(
    publicKeyPath: string
  ): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('ssh-keygen', [
        '-lf',
        publicKeyPath,
      ]);
      return stdout.trim().split(' ')[1]; // Extract fingerprint part
    } catch {
      return undefined; // Fingerprint not available
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

  // Extract base host from repository URL
  private extractBaseHost(repoUrl: string): string | null {
    try {
      // Handle SSH URLs like git@github.com:owner/repo
      if (repoUrl.startsWith('git@')) {
        const match = repoUrl.match(/git@([^:]+):/);
        return match ? match[1] : null;
      }

      // Handle HTTPS URLs
      if (repoUrl.startsWith('http')) {
        const url = new globalThis.URL(repoUrl);
        return url.hostname;
      }

      // Handle other SSH formats like ssh://git@github.com/owner/repo
      if (repoUrl.startsWith('ssh://')) {
        const url = new globalThis.URL(repoUrl);
        return url.hostname;
      }

      return null;
    } catch {
      return null;
    }
  }

  // Test SSH key against a specific repository URL
  private async testSSHKeyAgainstRepo(
    keyPath: string,
    repoUrl: string
  ): Promise<boolean> {
    const logger = getLogger();

    // Convert HTTPS URL to SSH format for testing (Git needs SSH URL to use SSH keys)
    const testUrl = this.convertToSSHForTesting(repoUrl);

    logger.debug(
      `🔍 Testing SSH key ${path.basename(keyPath)} against: ${testUrl}`
    );

    try {
      // Use git ls-remote to test if this key can access the specific repository
      const { stdout } = await execFileAsync(
        'git',
        ['ls-remote', '--heads', testUrl],
        {
          timeout: 10000, // 10 second timeout
          env: {
            ...process.env,
            GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes`,
          },
        }
      );

      // If git ls-remote succeeds, this key has access to the repository
      const hasAccess = stdout.trim().length > 0;
      logger.debug(
        `${hasAccess ? '✅' : '❌'} SSH key test result for ${path.basename(keyPath)}: ${hasAccess ? 'ACCESS_GRANTED' : 'NO_OUTPUT'}`
      );
      return hasAccess;
    } catch (error) {
      const errorMessage =
        (error as { stderr?: string; message?: string }).stderr ||
        (error instanceof Error ? error.message : String(error));

      // Check for specific error types
      if (
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('Authentication failed') ||
        errorMessage.includes('could not read') ||
        errorMessage.includes('Repository not found')
      ) {
        // This key doesn't have access to this specific repository
        logger.debug(
          `❌ SSH key ${path.basename(keyPath)} denied access to ${testUrl}: ${errorMessage}`
        );
        return false;
      }

      if (
        errorMessage.includes('not found') ||
        errorMessage.includes('does not exist')
      ) {
        // Repository doesn't exist
        logger.debug(`❌ Repository not found: ${testUrl}`);
        return false;
      }

      // Other error - assume key doesn't work
      logger.debug(`❌ SSH key test failed for ${testUrl}: ${errorMessage}`);
      return false;
    }
  }

  // Convert URL to SSH format for SSH key testing
  private convertToSSHForTesting(url: string): string {
    // For HTTPS URLs, convert to SSH format for testing
    const httpsMatch = url.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
    if (httpsMatch) {
      const [, host, repoPath] = httpsMatch;
      return `git@${host}:${repoPath}.git`;
    }

    // If already SSH format or unrecognized format, return as-is
    return url;
  }

  // Find working SSH key for a repository URL
  // Tests keys against the specific repository and returns the first working key
  // Uses session cache to avoid retesting keys
  async findWorkingSSHKey(repoUrl: string): Promise<SSHKeyInfo | null> {
    const logger = getLogger();

    // Extract base host for caching purposes
    const baseHost = this.extractBaseHost(repoUrl);
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
        const works = await this.testSSHKeyAgainstRepo(key.keyPath, repoUrl);
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

  // Extract remote URL from local repository path
  private async extractRemoteUrl(localPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['remote', 'get-url', 'origin'],
        {
          cwd: localPath,
          timeout: 5000, // 5 second timeout
        }
      );
      return stdout.trim();
    } catch (error) {
      getLogger().debug(
        `Could not extract remote URL from ${localPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
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
    if (!this.isUrl(pathOrUrl)) {
      logger.debug(`📁 Local repository detected: ${pathOrUrl}`);
      const remoteUrl = await this.extractRemoteUrl(pathOrUrl);

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
    if (!this.isUrl(pathOrUrl)) {
      logger.debug(`📁 Local repository detected: ${pathOrUrl}`);
      const remoteUrl = await this.extractRemoteUrl(pathOrUrl);

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
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const privateKey = await fs.readFile(workingKey.keyPath, 'utf8');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const publicKey = await fs.readFile(workingKey.publicKeyPath, 'utf8');

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
    if (!this.isUrl(pathOrUrl)) {
      const remoteUrl = await this.extractRemoteUrl(pathOrUrl);
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

  // Check if string is a URL (vs local path)
  private isUrl(pathOrUrl: string): boolean {
    return (
      pathOrUrl.startsWith('http') ||
      pathOrUrl.startsWith('git@') ||
      pathOrUrl.includes('://') ||
      pathOrUrl.startsWith('ssh://')
    );
  }

  // Check if a repository is public or private
  // Uses caching to avoid repeated checks
  async isRepoPublic(repoUrl: string): Promise<boolean | null> {
    const normalizedUrl = this.normalizeRepoUrl(repoUrl);

    // Check cache first
    const cached = this.repoPrivacyCache.get(normalizedUrl);
    if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) {
      // 5 minute cache
      return cached.isPublic;
    }

    const logger = getLogger();
    logger.debug(`🔍 Checking repository privacy: ${normalizedUrl}`);

    let privacyInfo: RepoPrivacyInfo;

    // Try GitHub API first (fastest and most reliable for GitHub repos)
    if (this.isGitHubUrl(normalizedUrl)) {
      const githubResult = await this.checkGitHubRepoPrivacy(normalizedUrl);
      privacyInfo = {
        repoUrl: normalizedUrl,
        isPublic: githubResult,
        checkedAt: Date.now(),
        method: 'github_api',
      };
    } else {
      // Fall back to git ls-remote test for non-GitHub repos
      const gitResult = await this.checkRepoPrivacyWithGit(normalizedUrl);
      privacyInfo = {
        repoUrl: normalizedUrl,
        isPublic: gitResult,
        checkedAt: Date.now(),
        method: 'git_test',
      };
    }

    // Cache the result
    this.repoPrivacyCache.set(normalizedUrl, privacyInfo);

    logger.debug(
      `📊 Repository privacy result: ${normalizedUrl} → ${privacyInfo.isPublic === null ? 'unknown' : privacyInfo.isPublic ? 'public' : 'private'} (${privacyInfo.method})`
    );

    return privacyInfo.isPublic;
  }

  // Normalize repository URL for consistent caching
  private normalizeRepoUrl(repoUrl: string): string {
    // Convert SSH to HTTPS format for consistency
    if (repoUrl.startsWith('git@github.com:')) {
      return repoUrl
        .replace('git@github.com:', 'https://github.com/')
        .replace(/\.git$/, '');
    }
    if (repoUrl.startsWith('git@gitlab.com:')) {
      return repoUrl
        .replace('git@gitlab.com:', 'https://gitlab.com/')
        .replace(/\.git$/, '');
    }

    // Remove .git suffix for consistency
    return repoUrl.replace(/\.git$/, '');
  }

  // Check if URL is a GitHub repository
  private isGitHubUrl(repoUrl: string): boolean {
    return repoUrl.includes('github.com');
  }

  // Check GitHub repository privacy using GitHub API
  private async checkGitHubRepoPrivacy(
    repoUrl: string
  ): Promise<boolean | null> {
    const logger = getLogger();

    try {
      const githubRepo = this.parseGitHubUrl(repoUrl);
      if (!githubRepo) {
        logger.debug('Could not parse GitHub URL');
        return null;
      }

      const apiUrl = `https://api.github.com/repos/${githubRepo.owner}/${githubRepo.name}`;

      // Use fetch with timeout
      const controller = new globalThis.AbortController();
      const timeoutId = globalThis.setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await globalThis.fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ignite-cli',
        },
      });

      globalThis.clearTimeout(timeoutId);

      if (response.status === 404) {
        // Could be private repo or doesn't exist
        return false;
      }

      if (response.ok) {
        const data = (await response.json()) as { private: boolean };
        return !data.private; // GitHub API returns "private" field
      }

      logger.debug(`GitHub API returned status: ${response.status}`);
      return null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('GitHub API request timed out');
      } else {
        logger.debug(
          `GitHub API error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  // Parse GitHub URL to extract owner and repo name
  private parseGitHubUrl(url: string): { owner: string; name: string } | null {
    const patterns = [
      /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/,
      /git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return { owner: match[1], name: match[2] };
      }
    }
    return null;
  }

  // Check repository privacy using git ls-remote (works for any Git host)
  private async checkRepoPrivacyWithGit(
    repoUrl: string
  ): Promise<boolean | null> {
    const logger = getLogger();

    try {
      // Try git ls-remote without credentials
      await execFileAsync('git', ['ls-remote', '--heads', repoUrl], {
        timeout: 10000, // 10 second timeout
      });

      // If this succeeds, repo is public
      return true;
    } catch (error) {
      const errorMessage =
        (error as { stderr?: string; message?: string }).stderr ||
        (error instanceof Error ? error.message : String(error));

      if (
        errorMessage.includes('Authentication failed') ||
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('could not read')
      ) {
        // Authentication required = private repo
        return false;
      }

      if (
        errorMessage.includes('not found') ||
        errorMessage.includes('does not exist')
      ) {
        // Repository doesn't exist
        logger.debug(`Repository not found: ${repoUrl}`);
        return null;
      }

      // Other error - unknown status
      logger.debug(`Git ls-remote error: ${errorMessage}`);
      return null;
    }
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
