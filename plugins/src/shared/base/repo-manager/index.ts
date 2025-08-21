import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import { NoParams, NoResult } from "../index.js";
import type {
  IRepoManagerPlugin,
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
  GitCredentialsParams,
  PathOptionsWithCredentials,
  GitCredentials,
} from "./types.js";
import { execGit } from "../../utils/git.js";

export abstract class RepoManagerPlugin
  extends BasePlugin<PluginType.REPO_MANAGER>
  implements IRepoManagerPlugin
{
  public readonly type = PluginType.REPO_MANAGER as const;

  // Get the repository URL for Git operations
  // - Local repos: return remote URL
  // - Cloned repos: return remote URL (or pathOrUrl during init)
  protected abstract getRepoUrl(): Promise<string | null>;

  // Convert HTTPS URL to SSH format when SSH credentials are available
  private convertToSSH(url: string): string {
    // For HTTPS URLs, convert to SSH format
    const httpsMatch = url.match(
      /^https:\/\/([^\/]+)\/(.+?)(?:\.git)?(?:\/)?$/,
    );
    if (httpsMatch) {
      const [, host, repoPath] = httpsMatch;
      const sshUrl = `git@${host}:${repoPath}.git`;
      console.log(`🔄 Converted HTTPS to SSH: ${url} → ${sshUrl}`);
      return sshUrl;
    }

    // If already SSH format or unrecognized format, return as-is
    return url;
  }

  // Execute a Git operation with credentials if provided
  // Uses temporary SSH files for secure credential handling in containers
  // Automatically converts HTTPS URLs to SSH when SSH credentials are available
  protected async withGitCredentials<T>(
    credentials: GitCredentials | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    // If we have SSH credentials, configure Git to use SSH URLs
    if (credentials && credentials.type === "ssh") {
      const repoUrl = await this.getRepoUrl();
      if (repoUrl && repoUrl.startsWith("https://")) {
        const sshUrl = this.convertToSSH(repoUrl);
        // Set up Git URL rewriting to convert HTTPS to SSH
        await execGit([
          "config",
          "--global",
          `url.${sshUrl}.insteadOf`,
          repoUrl,
        ]);
      }
    }

    if (!credentials) {
      return await operation();
    }

    // Exhaustive type check with compiler error for unhandled types
    // switch (credentials.type) {
    // case "ssh": {
    const sshDir = "/tmp/.ssh";
    const privateKeyPath = `${sshDir}/id_rsa`;
    const publicKeyPath = `${sshDir}/id_rsa.pub`;

    try {
      // Setup SSH credentials
      await this.createSSHDirectory(sshDir);
      await this.writeSSHKeys(
        privateKeyPath,
        publicKeyPath,
        credentials.privateKey,
        credentials.publicKey,
      );
      await this.configureGitSSH(privateKeyPath);

      // Execute the operation with credentials available
      return await operation();
    } finally {
      // Always cleanup credentials and URL rewriting
      await this.cleanupSSHCredentials(sshDir);
    }
    // }
    // default: {
    //   // Exhaustive check - TypeScript will error if we add new credential types
    //   const _exhaustive: never = credentials;
    //   throw new Error(
    //     `Unhandled credential type: ${JSON.stringify(_exhaustive)}`,
    //   );
    // }
    // }
  }

  // Create SSH directory with proper permissions
  private async createSSHDirectory(sshDir: string): Promise<void> {
    const fs = await import("fs/promises");
    await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  }

  // Write SSH keys to temporary files with proper permissions
  private async writeSSHKeys(
    privateKeyPath: string,
    publicKeyPath: string,
    privateKey: string,
    publicKey: string,
  ): Promise<void> {
    const fs = await import("fs/promises");

    // Write private key with restrictive permissions
    await fs.writeFile(privateKeyPath, privateKey, { mode: 0o600 });

    // Write public key with standard permissions
    await fs.writeFile(publicKeyPath, publicKey, { mode: 0o644 });
  }

  // Configure Git to use the temporary SSH key
  private async configureGitSSH(privateKeyPath: string): Promise<void> {
    const sshCommand = `ssh -i ${privateKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

    // Set Git SSH command for this session
    await execGit(["config", "--global", "core.sshCommand", sshCommand]);
  }

  // Clean up SSH credentials and reset Git configuration
  private async cleanupSSHCredentials(sshDir: string): Promise<void> {
    try {
      // Reset Git SSH configuration
      await execGit(["config", "--global", "--unset", "core.sshCommand"]);
    } catch {
      // Ignore errors when unsetting config
    }

    try {
      // Remove SSH directory and all contents
      const fs = await import("fs/promises");
      await fs.rm(sshDir, { recursive: true, force: true });
    } catch {
      // Ignore errors during cleanup
    }
  }

  // Temporary no-op implementations to satisfy executor typing.
  // Concrete plugins will implement real logic in the next step.
  abstract init(
    _options: PathOptionsWithCredentials,
  ): Promise<PluginResponse<NoResult>>;

  abstract checkoutBranch(
    _options: RepoCheckoutBranchOptions,
  ): Promise<PluginResponse<NoResult>>;

  abstract checkoutCommit(
    _options: RepoCheckoutCommitOptions,
  ): Promise<PluginResponse<NoResult>>;

  abstract getBranches(
    _options: NoParams,
  ): Promise<PluginResponse<RepoGetBranchesResult>>;

  abstract pullChanges(
    _options: GitCredentialsParams,
  ): Promise<PluginResponse<NoResult>>;

  abstract getRepoInfo(
    _options: GitCredentialsParams,
  ): Promise<PluginResponse<RepoInfoResult>>;
}

// Re-export types for convenience
export * from "./types.js";
