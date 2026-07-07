// Resolves the 32-byte vault master key. Preference order:
//   1. macOS Keychain (generic password, service "ignite-vault") — the key
//      never touches argv/env: reads via `security find-generic-password -w`
//      (value on stdout), writes via `security -i` (command incl. the key fed
//      on stdin).
//   2. A 0600 key file under ~/.ignite/plugins/vault.key (non-macOS, or when
//      the keychain is unavailable).
// First use generates a fresh random key and persists it.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCommand as realRunCommand } from '../../utils/runCommand.js';
import { FileSystem } from '../../filesystem/FileSystem.js';

const KEYCHAIN_SERVICE = 'ignite-vault';
const KEYCHAIN_ACCOUNT = 'master-key';
const KEY_BYTES = 32;

export interface MasterKeyDeps {
  platform: NodeJS.Platform;
  runCommand: typeof realRunCommand;
  fileSystem: Pick<FileSystem, 'getVaultKeyPath'>;
  readKeyFile: (path: string) => Promise<string>; // base64
  writeKeyFile: (path: string, contents: string, mode: number) => Promise<void>;
}

function defaultDeps(): MasterKeyDeps {
  return {
    platform: process.platform,
    runCommand: realRunCommand,
    fileSystem: FileSystem.getInstance(),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path comes from FileSystem.getVaultKeyPath(), not user input
    readKeyFile: (p) => fs.readFile(p, 'utf8'),
    writeKeyFile: async (p, contents, mode) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path comes from FileSystem.getVaultKeyPath(), not user input
      await fs.mkdir(path.dirname(p), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path comes from FileSystem.getVaultKeyPath(), not user input
      await fs.writeFile(p, contents, { mode });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: path comes from FileSystem.getVaultKeyPath(), not user input
      await fs.chmod(p, mode); // umask can strip bits on create; force them
    },
  };
}

export async function getMasterKey(deps?: Partial<MasterKeyDeps>): Promise<Buffer> {
  const d: MasterKeyDeps = { ...defaultDeps(), ...deps };
  if (d.platform === 'darwin') {
    const fromKeychain = await tryKeychain(d);
    if (fromKeychain) return fromKeychain;
  }
  return fromFile(d);
}

async function tryKeychain(d: MasterKeyDeps): Promise<Buffer | null> {
  try {
    const read = await d.runCommand('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ]);
    if (read.code === 0) {
      const key = Buffer.from(read.stdout.trim(), 'base64');
      if (key.length === KEY_BYTES) return key;
    }
    // Not found (or malformed) → create and store.
    const key = randomBytes(KEY_BYTES);
    const b64 = key.toString('base64');
    // `security -i` reads the command from stdin so the key stays off argv.
    const cmd = `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${b64} -U\n`;
    const write = await d.runCommand('security', ['-i'], { input: cmd });
    if (write.code === 0) return key;
    return null; // fall through to file fallback
  } catch {
    return null; // security binary missing / sandboxed → file fallback
  }
}

async function fromFile(d: MasterKeyDeps): Promise<Buffer> {
  const p = d.fileSystem.getVaultKeyPath();
  try {
    const existing = Buffer.from((await d.readKeyFile(p)).trim(), 'base64');
    if (existing.length === KEY_BYTES) return existing;
  } catch {
    // missing/unreadable → create below
  }
  const key = randomBytes(KEY_BYTES);
  await d.writeKeyFile(p, key.toString('base64'), 0o600);
  return key;
}
