import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { getLogger } from '../../utils/logger.js';
import type { GitCredentialsData } from '@ignite/api';

const execFileAsync = promisify(execFile);

export interface GitCredentials {
  type: 'ssh' | 'https';
  username?: string;
  token?: string;
  sshKeyPath?: string;
  sshAgent?: boolean;
  // For Docker container use - actual key content
  privateKey?: string;
  publicKey?: string;
}

export class GitCredentialManager {
  private static instance: GitCredentialManager;
  private credentials: Map<string, GitCredentials> = new Map();
  private initialized = false;

  private constructor() {}

  static getInstance(): GitCredentialManager {
    if (!GitCredentialManager.instance) {
      GitCredentialManager.instance = new GitCredentialManager();
    }
    return GitCredentialManager.instance;
  }

  /**
   * Initialize credentials on CLI startup - extracts SSH keys and checks SSH agent
   */
  async initializeCredentials(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const logger = getLogger();
    logger.info('🔑 Initializing Git credentials...');

    try {
      // Extract SSH credentials
      const sshCredentials = await this.extractSSHCredentials();
      if (sshCredentials) {
        this.credentials.set('ssh', sshCredentials);
        logger.info('✅ SSH credentials found and configured');
      } else {
        logger.info('ℹ️ No SSH credentials found');
      }

      this.initialized = true;
    } catch (error) {
      logger.warn(
        `⚠️ Failed to initialize Git credentials: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get credentials for a specific repository URL
   */
  getCredentialsForRepo(repoUrl: string): GitCredentials | null {
    if (!this.initialized) {
      getLogger().warn('GitCredentialManager not initialized');
      return null;
    }

    // Determine if SSH or HTTPS based on URL format
    if (this.isSSHUrl(repoUrl)) {
      return this.credentials.get('ssh') || null;
    }

    // For HTTPS URLs, we'll implement token extraction later
    return this.credentials.get('https') || null;
  }

  /**
   * Check if a repository URL uses SSH
   */
  private isSSHUrl(repoUrl: string): boolean {
    return (
      repoUrl.startsWith('git@') ||
      repoUrl.startsWith('ssh://') ||
      /^[^@]+@[^:]+:/.test(repoUrl)
    ); // user@host:path format
  }

  /**
   * Extract SSH credentials from the host system
   */
  private async extractSSHCredentials(): Promise<GitCredentials | null> {
    const logger = getLogger();

    try {
      // Always try to find SSH key files first since we need the actual key content for Docker
      // SSH agent can't be reliably forwarded to containers
      const sshKeyCredentials = await this.findSSHKeys();
      if (sshKeyCredentials) {
        logger.info('✅ Found SSH key files for Docker container use');
        return sshKeyCredentials;
      }

      // If no key files found, check SSH agent as backup info
      const sshAgentCredentials = await this.checkSSHAgent();
      if (sshAgentCredentials) {
        logger.warn(
          '⚠️ SSH agent detected but no key files found - Docker containers may not have Git access'
        );
        return sshAgentCredentials;
      }

      return null;
    } catch (error) {
      logger.warn(
        `Failed to extract SSH credentials: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Check if SSH agent is running and has GitHub keys loaded
   */
  private async checkSSHAgent(): Promise<GitCredentials | null> {
    const logger = getLogger();

    try {
      // Check if SSH_AUTH_SOCK is set
      if (!process.env.SSH_AUTH_SOCK) {
        logger.debug('SSH_AUTH_SOCK not set');
        return null;
      }

      // List keys in SSH agent
      const { stdout } = await execFileAsync('ssh-add', ['-l']);

      if (!stdout.trim()) {
        logger.debug('No keys found in SSH agent');
        return null;
      }

      logger.debug(`SSH agent keys: ${stdout.trim()}`);

      // Test GitHub connectivity with SSH agent
      const githubTest = await this.testGitHubSSH();
      if (githubTest) {
        logger.info('✅ SSH agent has working GitHub access');
        return {
          type: 'ssh',
          sshAgent: true,
        };
      }

      return null;
    } catch (error) {
      logger.debug(
        `SSH agent check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Find SSH keys in ~/.ssh directory
   */
  private async findSSHKeys(): Promise<GitCredentials | null> {
    const logger = getLogger();
    const sshDir = path.join(os.homedir(), '.ssh');

    try {
      // Check if .ssh directory exists
      await fs.access(sshDir);
    } catch {
      logger.debug('~/.ssh directory not found');
      return null;
    }

    // Common SSH key names to check (in order of preference)
    const keyNames = [
      'id_ed25519',
      'id_rsa',
      'id_ecdsa',
      'id_dsa',
      'github_rsa',
      'github_ed25519',
    ];

    for (const keyName of keyNames) {
      const keyPath = path.join(sshDir, keyName);

      try {
        // Check if private key exists and is readable
        await fs.access(keyPath, fs.constants.R_OK);

        // Check if public key exists
        const pubKeyPath = `${keyPath}.pub`;
        await fs.access(pubKeyPath, fs.constants.R_OK);

        logger.debug(`Found SSH key pair: ${keyName}`);

        // Test if this key works with GitHub
        const githubTest = await this.testGitHubSSHWithKey(keyPath);
        if (githubTest) {
          logger.info(`✅ SSH key ${keyName} has GitHub access`);

          // Read the actual key content for Docker container use
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          const privateKey = await fs.readFile(keyPath, 'utf8');
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          const publicKey = await fs.readFile(pubKeyPath, 'utf8');

          return {
            type: 'ssh',
            sshKeyPath: keyPath,
            sshAgent: false,
            privateKey,
            publicKey,
          };
        }
      } catch (error) {
        logger.debug(
          `SSH key ${keyName} not usable: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }

    logger.debug('No working SSH keys found');
    return null;
  }

  /**
   * Test GitHub SSH connectivity using SSH agent
   */
  private async testGitHubSSH(): Promise<boolean> {
    try {
      // Test SSH connection to GitHub
      const { stderr } = await execFileAsync('ssh', [
        '-T',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'ConnectTimeout=5',
        'git@github.com',
      ]);

      // GitHub SSH returns success message in stderr
      return stderr.includes('successfully authenticated');
    } catch (error) {
      // SSH command returns exit code 1 for successful auth, so we check stderr
      if (error instanceof Error && 'stderr' in error) {
        const stderr = (error as { stderr: string }).stderr;
        return stderr.includes('successfully authenticated');
      }
      return false;
    }
  }

  /**
   * Test GitHub SSH connectivity using a specific key
   */
  private async testGitHubSSHWithKey(keyPath: string): Promise<boolean> {
    try {
      const { stderr } = await execFileAsync('ssh', [
        '-T',
        '-i',
        keyPath,
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'ConnectTimeout=5',
        'git@github.com',
      ]);

      return stderr.includes('successfully authenticated');
    } catch (error) {
      if (error instanceof Error && 'stderr' in error) {
        const stderr = (error as { stderr: string }).stderr;
        return stderr.includes('successfully authenticated');
      }
      return false;
    }
  }

  /**
   * Get SSH key content for Docker container injection
   * Returns null if no usable SSH key content is available
   */
  getSSHKeyForContainer(
    repoUrl: string
  ): { privateKey: string; publicKey: string } | null {
    if (!this.isSSHUrl(repoUrl)) {
      return null;
    }

    const sshCreds = this.credentials.get('ssh');
    if (!sshCreds || !sshCreds.privateKey || !sshCreds.publicKey) {
      getLogger().warn(
        'SSH credentials available but no key content for container use'
      );
      return null;
    }

    return {
      privateKey: sshCreds.privateKey,
      publicKey: sshCreds.publicKey,
    };
  }

  /**
   * Get debug information about available credentials
   */
  getCredentialInfo(): GitCredentialsData {
    const info: GitCredentialsData = {
      initialized: this.initialized,
      credentialTypes: Array.from(this.credentials.keys()),
    };

    const sshCreds = this.credentials.get('ssh');
    if (sshCreds) {
      info.ssh = {
        hasAgent: sshCreds.sshAgent || false,
        hasKeyPath: !!sshCreds.sshKeyPath,
        keyPath: sshCreds.sshKeyPath
          ? path.basename(sshCreds.sshKeyPath)
          : undefined,
      };
    }

    return info;
  }
}
