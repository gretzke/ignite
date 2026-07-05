// Host-side directory chain listing for the frontend DirectoryPicker.
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export class InvalidPathError extends Error {}

export interface DirectoryEntry {
  name: string;
  isGitRepo: boolean;
  isHidden: boolean;
}

export interface DirectoryColumn {
  path: string;
  entries: DirectoryEntry[];
}

export interface DirectoryChain {
  resolvedPath: string;
  requestedPathExists: boolean;
  columns: DirectoryColumn[];
}

function expandPath(requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (trimmed === '') return process.cwd();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: listing on behalf of the machine owner via authenticated local API
    const stats = await fs.stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function listEntries(dirPath: string): Promise<DirectoryEntry[]> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: listing on behalf of the machine owner via authenticated local API
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const entries: DirectoryEntry[] = [];
    for (const dirent of dirents) {
      // Follow symlinks so linked project dirs are navigable
      const isDir = dirent.isDirectory()
        ? true
        : dirent.isSymbolicLink() &&
          (await isDirectory(path.join(dirPath, dirent.name)));
      if (!isDir) continue;
      entries.push({
        name: dirent.name,
        isGitRepo: await isDirectory(path.join(dirPath, dirent.name, '.git')),
        isHidden: dirent.name.startsWith('.'),
      });
    }
    return entries.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  } catch {
    // EACCES/ENOENT etc. -> empty column rather than an error
    return [];
  }
}

export async function listDirectoryChain(
  requestedPath: string
): Promise<DirectoryChain> {
  const expanded = expandPath(requestedPath);
  if (!path.isAbsolute(expanded)) {
    throw new InvalidPathError(`Path must be absolute (got: ${requestedPath})`);
  }

  let normalized = path.normalize(expanded);
  const root = path.parse(normalized).root;
  // path.normalize preserves trailing separators; strip them (except at root)
  while (normalized !== root && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }

  // Walk up to the deepest existing directory
  let resolvedPath = normalized;
  while (resolvedPath !== root && !(await isDirectory(resolvedPath))) {
    resolvedPath = path.dirname(resolvedPath);
  }
  const requestedPathExists =
    resolvedPath === normalized && (await isDirectory(resolvedPath));

  // Build the chain root -> resolvedPath
  const chainPaths: string[] = [];
  for (let current = resolvedPath; ; current = path.dirname(current)) {
    chainPaths.unshift(current);
    if (current === root) break;
  }

  const columns: DirectoryColumn[] = await Promise.all(
    chainPaths.map(async (chainPath) => ({
      path: chainPath,
      entries: await listEntries(chainPath),
    }))
  );

  return { resolvedPath, requestedPathExists, columns };
}
