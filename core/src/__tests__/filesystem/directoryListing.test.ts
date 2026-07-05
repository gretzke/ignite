// Tests for listDirectoryChain
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  listDirectoryChain,
  InvalidPathError,
} from '../../filesystem/directoryListing.js';

describe('listDirectoryChain', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-listing-test-'));
    // Fixture:
    //   repo1/.git/        -> git repo
    //   .hidden/           -> hidden dir
    //   b/c/               -> nested plain dirs
    //   file.txt           -> must never appear in entries
    await fs.mkdir(path.join(testDir, 'repo1', '.git'), { recursive: true });
    await fs.mkdir(path.join(testDir, '.hidden'));
    await fs.mkdir(path.join(testDir, 'b', 'c'), { recursive: true });
    await fs.writeFile(path.join(testDir, 'file.txt'), 'hello');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const lastColumn = (chain: Awaited<ReturnType<typeof listDirectoryChain>>) =>
    chain.columns[chain.columns.length - 1];

  it('lists only directories with git/hidden flags, sorted case-insensitively', async () => {
    const chain = await listDirectoryChain(testDir);
    expect(chain.requestedPathExists).toBe(true);
    expect(chain.resolvedPath).toBe(path.normalize(testDir));
    const entries = lastColumn(chain).entries;
    expect(entries.map((e) => e.name)).toEqual(['.hidden', 'b', 'repo1']);
    expect(entries.find((e) => e.name === 'repo1')).toEqual({
      name: 'repo1',
      isGitRepo: true,
      isHidden: false,
    });
    expect(entries.find((e) => e.name === '.hidden')).toEqual({
      name: '.hidden',
      isGitRepo: false,
      isHidden: true,
    });
    expect(entries.find((e) => e.name === 'b')).toEqual({
      name: 'b',
      isGitRepo: false,
      isHidden: false,
    });
  });

  it('returns one column per level from root to the resolved path', async () => {
    const target = path.join(testDir, 'b', 'c');
    const chain = await listDirectoryChain(target);
    expect(chain.resolvedPath).toBe(target);
    // First column is the filesystem root, last column is the target itself
    expect(chain.columns[0].path).toBe(path.parse(target).root);
    expect(lastColumn(chain).path).toBe(target);
    // Each column's path is the parent of the next column's path
    for (let i = 1; i < chain.columns.length; i++) {
      expect(path.dirname(chain.columns[i].path)).toBe(
        chain.columns[i - 1].path
      );
    }
    // The column for testDir/b lists 'c'
    const bColumn = chain.columns.find(
      (col) => col.path === path.join(testDir, 'b')
    );
    expect(bColumn?.entries.map((e) => e.name)).toEqual(['c']);
  });

  it('falls back to the deepest existing ancestor for nonexistent paths', async () => {
    const chain = await listDirectoryChain(
      path.join(testDir, 'b', 'nope', 'deeper')
    );
    expect(chain.requestedPathExists).toBe(false);
    expect(chain.resolvedPath).toBe(path.join(testDir, 'b'));
    expect(lastColumn(chain).path).toBe(path.join(testDir, 'b'));
  });

  it('treats a file path as nonexistent and resolves to its parent', async () => {
    const chain = await listDirectoryChain(path.join(testDir, 'file.txt'));
    expect(chain.requestedPathExists).toBe(false);
    expect(chain.resolvedPath).toBe(path.normalize(testDir));
  });

  it('normalizes trailing slashes', async () => {
    const chain = await listDirectoryChain(testDir + path.sep);
    expect(chain.requestedPathExists).toBe(true);
    expect(chain.resolvedPath).toBe(path.normalize(testDir));
  });

  it('expands ~ to the home directory', async () => {
    const chain = await listDirectoryChain('~');
    expect(chain.requestedPathExists).toBe(true);
    expect(chain.resolvedPath).toBe(os.homedir());
  });

  it('defaults empty input to the current working directory', async () => {
    const chain = await listDirectoryChain('');
    expect(chain.requestedPathExists).toBe(true);
    expect(chain.resolvedPath).toBe(process.cwd());
  });

  it('rejects relative paths', async () => {
    await expect(listDirectoryChain('some/relative/path')).rejects.toThrow(
      InvalidPathError
    );
  });

  it('returns empty entries for unreadable directories instead of throwing', async () => {
    if (process.getuid?.() === 0) return; // chmod is a no-op for root
    const locked = path.join(testDir, 'locked');
    await fs.mkdir(path.join(locked, 'inner'), { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      const chain = await listDirectoryChain(locked);
      expect(chain.requestedPathExists).toBe(true);
      expect(lastColumn(chain).entries).toEqual([]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
});
