// Host-side git remote inspection: default branch, branches, semver tags —
// via `git ls-remote` (works for any git host, no API tokens, no rate
// limits) — plus optional GitHub enrichment (repo description, release
// notes). Powers the install modal, update checks, and the plugin store.
//
// This runs in the core process on the host; it is never subject to plugin
// permissions (the plugin container isn't involved).
import { parseGitHubUrl } from '@ignite/plugin-types';
import type { InspectGitRemoteData, GitReleaseData } from '@ignite/api';
import { runCommand } from '../../utils/runCommand.js';
import { getLogger } from '../../utils/logger.js';

const LS_REMOTE_TIMEOUT_MS = 20_000;
const LS_REMOTE_CACHE_TTL_MS = 60_000;
const GITHUB_CACHE_TTL_MS = 5 * 60_000;
const GITHUB_TIMEOUT_MS = 8_000;

// Same allowlist as GitSourceBuildBackend: never hand ls-remote a transport
// that can execute host commands (ext::, fd::).
const ALLOWED_URL_SCHEMES = ['https://', 'git://', 'ssh://', 'file://'];

export function assertAllowedGitUrl(url: string): void {
  const lower = url.toLowerCase();
  if (!ALLOWED_URL_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    throw new Error(
      `Unsupported git URL scheme in '${url}'. Only ${ALLOWED_URL_SCHEMES.join(', ')} are allowed.`
    );
  }
}

export interface RemoteRefs {
  defaultBranch: string | null;
  branches: Record<string, string>; // name -> sha
  tags: Record<string, string>; // name -> sha (peeled when annotated)
}

interface CacheEntry<T> {
  ts: number;
  value: Promise<T>;
}

const lsRemoteCache = new Map<string, CacheEntry<RemoteRefs>>();
const githubCache = new Map<string, CacheEntry<GithubInfo | null>>();

function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttl: number,
  compute: () => Promise<T>
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.value;
  const value = compute();
  cache.set(key, { ts: Date.now(), value });
  // A failed lookup must not be cached as a poisoned entry for the full TTL.
  value.catch(() => cache.delete(key));
  return value;
}

// Test-only: reset module caches.
export function clearGitRemoteCaches(): void {
  lsRemoteCache.clear();
  githubCache.clear();
}

export function fetchRemoteRefs(url: string): Promise<RemoteRefs> {
  assertAllowedGitUrl(url);
  return cached(lsRemoteCache, url, LS_REMOTE_CACHE_TTL_MS, async () => {
    const result = await runCommand('git', ['ls-remote', '--symref', url], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'https:git:ssh:file',
      },
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(
        `git ls-remote failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`
      );
    }
    return parseLsRemote(result.stdout);
  });
}

// Pure parser, exported for tests.
export function parseLsRemote(stdout: string): RemoteRefs {
  const refs: RemoteRefs = { defaultBranch: null, branches: {}, tags: {} };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [left, ref] = line.split('\t');
    if (!ref) continue;
    if (left.startsWith('ref: refs/heads/') && ref === 'HEAD') {
      refs.defaultBranch = left.slice('ref: refs/heads/'.length);
      continue;
    }
    if (ref.startsWith('refs/heads/')) {
      refs.branches[ref.slice('refs/heads/'.length)] = left;
      continue;
    }
    if (ref.startsWith('refs/tags/')) {
      const name = ref.slice('refs/tags/'.length);
      if (name.endsWith('^{}')) {
        // Peeled annotated tag: this is the commit sha — prefer it.
        refs.tags[name.slice(0, -3)] = left;
      } else if (!(name in refs.tags)) {
        refs.tags[name] = left;
      }
    }
  }
  return refs;
}

// --- semver ---

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export function parseSemverTag(tag: string): Semver | null {
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

// Standard semver ordering; a prerelease sorts below its release.
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease && b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease);
  }
  return 0;
}

export function compareVersionStrings(a: string, b: string): number | null {
  const pa = parseSemverTag(a);
  const pb = parseSemverTag(b);
  if (!pa || !pb) return null;
  return compareSemver(pa, pb);
}

function normalizeVersion(tag: string): string {
  return tag.replace(/^v/, '');
}

// Semver tags from the remote, newest first.
export function releasesFromTags(
  tags: Record<string, string>
): GitReleaseData[] {
  return Object.entries(tags)
    .map(([tag, sha]) => ({ tag, sha, parsed: parseSemverTag(tag) }))
    .filter(
      (e): e is { tag: string; sha: string; parsed: Semver } =>
        e.parsed !== null
    )
    .sort((a, b) => compareSemver(b.parsed, a.parsed))
    .map(({ tag, sha, parsed }) => ({
      tag,
      version: normalizeVersion(tag),
      sha,
      ...(parsed.prerelease ? { prerelease: true } : {}),
    }));
}

// --- GitHub enrichment (best-effort) ---

interface GithubInfo {
  owner: string;
  repo: string;
  description?: string;
  releases: Array<{
    tag: string;
    name?: string;
    notes?: string;
    publishedAt?: string;
    prerelease?: boolean;
  }>;
}

async function githubGet(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        'User-Agent': 'ignite',
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${path} -> ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function fetchGithubInfo(url: string): Promise<GithubInfo | null> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return Promise.resolve(null);
  const key = `${parsed.owner}/${parsed.name}`;
  return cached(githubCache, key, GITHUB_CACHE_TTL_MS, async () => {
    try {
      const [repo, releases] = await Promise.all([
        githubGet(`/repos/${key}`) as Promise<{ description?: string | null }>,
        githubGet(`/repos/${key}/releases?per_page=20`) as Promise<
          Array<{
            tag_name: string;
            name?: string | null;
            body?: string | null;
            published_at?: string | null;
            prerelease?: boolean;
          }>
        >,
      ]);
      return {
        owner: parsed.owner,
        repo: parsed.name,
        ...(repo.description ? { description: repo.description } : {}),
        releases: releases.map((release) => ({
          tag: release.tag_name,
          ...(release.name ? { name: release.name } : {}),
          ...(release.body ? { notes: release.body } : {}),
          ...(release.published_at
            ? { publishedAt: release.published_at }
            : {}),
          ...(release.prerelease ? { prerelease: true } : {}),
        })),
      };
    } catch (error) {
      // Rate-limited or offline: everything still works from ls-remote, we
      // just lose descriptions and release notes.
      getLogger().debug(`GitHub enrichment failed for ${key}: ${error}`);
      return null;
    }
  });
}

// What an install with this ref tracks, given what the remote actually has:
// no ref → the default branch; a 40-hex sha → pinned commit; a semver tag →
// that release; a known branch → that branch; any other tag → pinned (no
// update prompts); unknown ref → assume branch (build will fail if wrong).
export function deriveTrack(
  ref: string | undefined,
  remote: Pick<InspectGitRemoteData, 'defaultBranch' | 'branches' | 'releases'>,
  tags?: Record<string, string>
):
  | { mode: 'release'; version: string }
  | { mode: 'branch'; branch: string }
  | { mode: 'commit' } {
  if (!ref) {
    return { mode: 'branch', branch: remote.defaultBranch ?? 'main' };
  }
  // Known refs win over the sha heuristic so a branch that happens to look
  // hex-ish (e.g. "deadbee") still tracks as a branch.
  if (remote.releases.some((release) => release.tag === ref)) {
    return { mode: 'release', version: ref };
  }
  if (remote.branches.includes(ref)) {
    return { mode: 'branch', branch: ref };
  }
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    return { mode: 'commit' };
  }
  if (tags && ref in tags) {
    return { mode: 'commit' };
  }
  return { mode: 'branch', branch: ref };
}

// --- combined inspection ---

export async function inspectGitRemote(
  url: string
): Promise<InspectGitRemoteData> {
  const [refs, github] = await Promise.all([
    fetchRemoteRefs(url),
    fetchGithubInfo(url),
  ]);

  const releases = releasesFromTags(refs.tags).map((release) => {
    const ghRelease = github?.releases.find((r) => r.tag === release.tag);
    return ghRelease
      ? {
          ...release,
          ...(ghRelease.name ? { name: ghRelease.name } : {}),
          ...(ghRelease.notes ? { notes: ghRelease.notes } : {}),
          ...(ghRelease.publishedAt
            ? { publishedAt: ghRelease.publishedAt }
            : {}),
          ...(ghRelease.prerelease ? { prerelease: true } : {}),
        }
      : release;
  });

  return {
    defaultBranch: refs.defaultBranch,
    branches: Object.keys(refs.branches).sort(),
    branchHeads: refs.branches,
    releases,
    ...(github
      ? {
          github: {
            owner: github.owner,
            repo: github.repo,
            ...(github.description ? { description: github.description } : {}),
          },
        }
      : {}),
  };
}
