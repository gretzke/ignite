// Cheap change-detection fingerprint: a stat-walk (path|size|mtimeMs) hashed
// with sha256. Deliberately NOT content hashing — "did anything change since
// the last compile" needs speed on large repos, not cryptographic precision.
// Used by the repo lifecycle to decide whether a repo needs an incremental
// recompile; the paths to walk come from each compiler plugin's
// getWatchPaths operation (source/artifact dirs are framework-configurable).
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['node_modules', '.git']);

async function walk(
  rootDir: string,
  rel: string,
  lines: string[]
): Promise<void> {
  const abs = path.join(rootDir, rel);
  let st;
  try {
    // lstat: a workspace symlink must never pull host files outside the
    // workspace into the walk — record the link itself, don't follow it.
    st = await fs.lstat(abs);
  } catch {
    lines.push(`${rel}|missing`);
    return;
  }
  if (st.isDirectory()) {
    let entries: string[] = [];
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: rooted at the repo workspace, callers pass registry-derived paths
      entries = await fs.readdir(abs);
    } catch {
      lines.push(`${rel}|unreadable`);
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      await walk(rootDir, path.join(rel, entry), lines);
    }
    return;
  }
  lines.push(`${rel}|${st.size}|${Math.floor(st.mtimeMs)}`);
}

export async function statFingerprint(
  rootDir: string,
  relPaths: string[]
): Promise<string> {
  const lines: string[] = [];
  for (const rel of relPaths) {
    await walk(rootDir, rel, lines);
  }
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}
