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

// Discover all SSH keys in ~/.ssh directory
// Returns metadata only, no private key content
export async function discoverSSHKeys(
  sshDir: string = path.join(os.homedir(), '.ssh')
): Promise<SSHKeyInfo[]> {
  const logger = getLogger();
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
      const keyType = extractKeyType(keyFile);
      const isEncrypted = await isKeyEncrypted(keyPath);
      const fingerprint = await getKeyFingerprint(publicKeyPath);

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
function extractKeyType(keyName: string): string {
  if (keyName.includes('ed25519')) return 'ed25519';
  if (keyName.includes('rsa')) return 'rsa';
  if (keyName.includes('ecdsa')) return 'ecdsa';
  if (keyName.includes('dsa')) return 'dsa';
  return 'unknown';
}

// Check if SSH private key is encrypted
async function isKeyEncrypted(keyPath: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const keyContent = await fs.readFile(keyPath, 'utf8');
    return keyContent.includes('ENCRYPTED');
  } catch {
    return true; // Assume encrypted if we can't read it
  }
}

// Get SSH key fingerprint from public key
async function getKeyFingerprint(
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
