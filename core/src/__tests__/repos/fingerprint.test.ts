import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statFingerprint } from '../../repos/fingerprint.js';
import { createTestDirectory, cleanupTestDirectory } from '../setup.js';

describe('statFingerprint', () => {
  it('is stable for unchanged trees and changes when a file changes', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      await fs.writeFile(path.join(dir, 'foundry.toml'), '[profile.default]');

      const a = await statFingerprint(dir, ['src', 'foundry.toml']);
      const b = await statFingerprint(dir, ['src', 'foundry.toml']);
      expect(a).toBe(b);

      // Content-equal but touched (mtime bumped) counts as changed — the
      // fingerprint is a stat-walk, not a content hash.
      await fs.utimes(
        path.join(dir, 'src/A.sol'),
        new Date(),
        new Date(Date.now() + 5000)
      );
      const c = await statFingerprint(dir, ['src', 'foundry.toml']);
      expect(c).not.toBe(a);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('changes when a file is added or removed', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/A.sol'), 'contract A {}');
      const before = await statFingerprint(dir, ['src']);

      await fs.writeFile(path.join(dir, 'src/B.sol'), 'contract B {}');
      const withB = await statFingerprint(dir, ['src']);
      expect(withB).not.toBe(before);

      await fs.rm(path.join(dir, 'src/B.sol'));
      // Same file set again; A untouched — back to the original value.
      expect(await statFingerprint(dir, ['src'])).toBe(before);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('treats a missing path as a distinct stable value', async () => {
    const dir = await createTestDirectory();
    try {
      const missing = await statFingerprint(dir, ['out']);
      expect(missing).toBe(await statFingerprint(dir, ['out']));

      await fs.mkdir(path.join(dir, 'out'), { recursive: true });
      await fs.writeFile(path.join(dir, 'out/A.json'), '{}');
      expect(await statFingerprint(dir, ['out'])).not.toBe(missing);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('skips node_modules and .git contents', async () => {
    const dir = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src/node_modules/x'), { recursive: true });
      await fs.mkdir(path.join(dir, 'src/.git'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/node_modules/x/big.js'), 'x');
      const before = await statFingerprint(dir, ['src']);

      await fs.writeFile(path.join(dir, 'src/node_modules/x/big.js'), 'yy');
      await fs.writeFile(path.join(dir, 'src/.git/HEAD'), 'ref: x');
      expect(await statFingerprint(dir, ['src'])).toBe(before);
    } finally {
      await cleanupTestDirectory(dir);
    }
  });

  it('does not follow symlinks out of the workspace', async () => {
    const dir = await createTestDirectory();
    const outside = await createTestDirectory();
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(outside, 'secret.txt'), 'a');
      await fs.symlink(
        path.join(outside, 'secret.txt'),
        path.join(dir, 'src/link')
      );
      const before = await statFingerprint(dir, ['src']);
      // Changing the symlink TARGET's content/size must not change the
      // fingerprint (the link itself is recorded via lstat, not followed).
      await fs.writeFile(path.join(outside, 'secret.txt'), 'a'); // same size, mtime bump
      // A same-size rewrite bumps the target's mtime; lstat of the link is
      // unaffected on macOS/Linux.
      expect(await statFingerprint(dir, ['src'])).toBe(before);
    } finally {
      await cleanupTestDirectory(dir);
      await cleanupTestDirectory(outside);
    }
  });
});
