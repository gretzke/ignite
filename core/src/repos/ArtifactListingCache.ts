import type { ArtifactLocation } from '@ignite/api';
import { statFingerprint } from './fingerprint.js';
import { canonicalGitUrl } from './VersionStore.js';

export function artifactCacheIdentity(pathOrUrl: string): string {
  return canonicalGitUrl(pathOrUrl);
}

export interface ArtifactListingCacheKeyParts {
  profileId?: string;
  canonicalIdentity: string;
  frameworkId: string;
  pluginId: string;
  pluginVersion: string;
  generation: number;
}

/** A stable, deliberately non-human cache key. */
export function artifactListingCacheKey(parts: ArtifactListingCacheKeyParts): string {
  return [
    parts.profileId ?? '',
    parts.canonicalIdentity,
    parts.frameworkId,
    `${parts.pluginId}@${parts.pluginVersion}`,
    String(parts.generation),
  ].join('\0');
}

export interface ArtifactListingLoadOptions {
  key: string;
  workspacePath: string;
  artifactPaths: string[];
  load: () => Promise<ArtifactLocation[]>;
}

// This cache is intentionally process-local. A generation is only meaningful
// for the server process which minted it, and invalidation is identity-wide so
// stale framework/plugin variants cannot survive a checkout mutation.
export class ArtifactListingCache {
  private readonly entries = new Map<string, ArtifactLocation[]>();
  private generation = 0;

  get(key: string): ArtifactLocation[] | undefined {
    return this.entries.get(key);
  }

  set(key: string, artifacts: ArtifactLocation[]): void {
    this.entries.set(key, artifacts);
  }

  invalidate(identity: string): void {
    for (const key of this.entries.keys()) {
      if (key.split('\0')[1] === identity) this.entries.delete(key);
    }
  }

  nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  async getOrLoad(options: ArtifactListingLoadOptions): Promise<ArtifactLocation[]> {
    const hit = this.get(options.key);
    if (hit) return hit;

    const before = await statFingerprint(options.workspacePath, options.artifactPaths);
    const artifacts = await options.load();
    const after = await statFingerprint(options.workspacePath, options.artifactPaths);
    if (before === after) this.set(options.key, artifacts);
    return artifacts;
  }
}

export const artifactListingCache = new ArtifactListingCache();
