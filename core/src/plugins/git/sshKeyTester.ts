import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getLogger } from '../../utils/logger.js';
import { convertHttpsToSsh } from '@ignite/plugin-types';

const execFileAsync = promisify(execFile);

// Test SSH key against a specific repository URL
export async function testSSHKeyAgainstRepo(
  keyPath: string,
  repoUrl: string
): Promise<boolean> {
  const logger = getLogger();

  // Convert HTTPS URL to SSH format for testing (Git needs SSH URL to use SSH keys)
  const testUrl = convertHttpsToSsh(repoUrl);

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

// Extract remote URL from local repository path
export async function extractRemoteUrl(
  localPath: string
): Promise<string | null> {
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
