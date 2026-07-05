// Git URL parsing/conversion helpers shared by core (host) and plugin
// containers. Pure functions only — no I/O.

// Convert an HTTPS remote to SSH form; SSH/local inputs pass through.
export function convertHttpsToSsh(url: string): string {
  const httpsMatch = url.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
  if (httpsMatch) {
    const [, host, repoPath] = httpsMatch;
    return `git@${host}:${repoPath}.git`;
  }
  return url;
}

// True for remote git URLs (https, ssh, scp-style), false for local paths.
export function isGitUrl(pathOrUrl: string): boolean {
  return (
    pathOrUrl.startsWith('http') ||
    pathOrUrl.startsWith('git@') ||
    pathOrUrl.includes('://') ||
    pathOrUrl.startsWith('ssh://')
  );
}

export function extractBaseHost(repoUrl: string): string | null {
  try {
    if (repoUrl.startsWith('git@')) {
      const match = repoUrl.match(/git@([^:]+):/);
      return match ? match[1] : null;
    }
    if (repoUrl.startsWith('http') || repoUrl.startsWith('ssh://')) {
      return new globalThis.URL(repoUrl).hostname;
    }
    return null;
  } catch {
    return null;
  }
}

// Canonical HTTPS-without-.git form, used as a cache key.
export function normalizeRepoUrl(repoUrl: string): string {
  if (repoUrl.startsWith('git@github.com:')) {
    return repoUrl
      .replace('git@github.com:', 'https://github.com/')
      .replace(/\.git$/, '');
  }
  if (repoUrl.startsWith('git@gitlab.com:')) {
    return repoUrl
      .replace('git@gitlab.com:', 'https://gitlab.com/')
      .replace(/\.git$/, '');
  }
  return repoUrl.replace(/\.git$/, '');
}

export function isGitHubUrl(repoUrl: string): boolean {
  return repoUrl.includes('github.com');
}

export function parseGitHubUrl(
  url: string
): { owner: string; name: string } | null {
  const patterns = [
    /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/,
    /git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], name: match[2] };
    }
  }
  return null;
}
