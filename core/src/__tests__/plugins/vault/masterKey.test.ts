import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getMasterKey } from '../../../plugins/vault/masterKey.js';

const KEYCHAIN_SERVICE = 'ignite-vault';

function macDeps(store: { key?: string }) {
  return {
    platform: 'darwin' as const,
    fileSystem: { getVaultKeyPath: () => '/x/vault.key' },
    readKeyFile: vi.fn(async () => {
      throw new Error('no file');
    }),
    writeKeyFile: vi.fn(async () => {}),
    runCommand: vi.fn(async (_cmd: string, args: string[]) => {
      // find-generic-password -w  → prints key or exits non-zero
      if (args.includes('find-generic-password')) {
        if (store.key) return { stdout: store.key + '\n', stderr: '', code: 0 };
        return { stdout: '', stderr: 'not found', code: 44 };
      }
      // add-generic-password (via -i stdin) → capture the created key
      if (args.includes('-i') || args.includes('add-generic-password')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }),
  };
}

describe('getMasterKey (macOS keychain)', () => {
  it('returns the existing keychain key when present', async () => {
    const existing = randomBytes(32).toString('base64');
    const deps = macDeps({ key: existing });
    const key = await getMasterKey(deps);
    expect(key).toHaveLength(32);
    expect(key.toString('base64')).toBe(existing);
    expect(deps.writeKeyFile).not.toHaveBeenCalled();
  });

  it('creates + stores a new keychain key on first use', async () => {
    const store: { key?: string } = {};
    const deps = macDeps(store);
    // simulate add persisting into the store for a follow-up read if impl re-reads
    deps.runCommand = vi.fn(async (_c: string, args: string[], opts?: { input?: string }) => {
      if (args.includes('find-generic-password')) {
        return store.key
          ? { stdout: store.key + '\n', stderr: '', code: 0 }
          : { stdout: '', stderr: 'nf', code: 44 };
      }
      // the create path passes the key via stdin (security -i), never argv
      if (opts?.input) {
        const m = /-w\s+(\S+)/.exec(opts.input);
        if (m) store.key = m[1];
      }
      return { stdout: '', stderr: '', code: 0 };
    });
    const key = await getMasterKey(deps);
    expect(key).toHaveLength(32);
    // the created key must not have been passed on argv
    const argvCalls = (deps.runCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of argvCalls) {
      const args = call[1] as string[];
      expect(args.join(' ')).not.toContain(store.key ?? 'UNSET');
    }
  });
});

describe('getMasterKey (file fallback)', () => {
  it('reads an existing key file on non-macOS', async () => {
    const existing = randomBytes(32);
    const deps = {
      platform: 'linux' as const,
      fileSystem: { getVaultKeyPath: () => '/x/vault.key' },
      readKeyFile: vi.fn(async () => existing.toString('base64')),
      writeKeyFile: vi.fn(async () => {}),
      runCommand: vi.fn(),
    };
    const key = await getMasterKey(deps);
    expect(key.equals(existing)).toBe(true);
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('creates a 0600 key file when none exists (non-macOS)', async () => {
    let written: { path: string; contents: string; mode: number } | null = null;
    const deps = {
      platform: 'linux' as const,
      fileSystem: { getVaultKeyPath: () => '/x/vault.key' },
      readKeyFile: vi.fn(async () => {
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      }),
      writeKeyFile: vi.fn(async (p: string, c: string, mode: number) => {
        written = { path: p, contents: c, mode };
      }),
      runCommand: vi.fn(),
    };
    const key = await getMasterKey(deps);
    expect(key).toHaveLength(32);
    expect(written).not.toBeNull();
    expect(written!.mode).toBe(0o600);
    expect(Buffer.from(written!.contents, 'base64')).toHaveLength(32);
  });

  it('falls back to the file when keychain read AND write fail on macOS', async () => {
    const deps = {
      platform: 'darwin' as const,
      fileSystem: { getVaultKeyPath: () => '/x/vault.key' },
      readKeyFile: vi.fn(async () => {
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      }),
      writeKeyFile: vi.fn(async () => {}),
      runCommand: vi.fn(async () => {
        throw new Error('security missing');
      }),
    };
    const key = await getMasterKey(deps);
    expect(key).toHaveLength(32);
    expect(deps.writeKeyFile).toHaveBeenCalled(); // file fallback used
  });
});
