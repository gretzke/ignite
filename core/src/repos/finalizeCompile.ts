import type { ArtifactLocation, RepoFrameworkState } from '@ignite/api';
import type { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { statFingerprint } from './fingerprint.js';
import { ArtifactListingCache, artifactListingCacheKey } from './ArtifactListingCache.js';

export interface FinalizeCompileInput {
  workspacePath: string;
  pathOrUrl: string;
  framework: RepoFrameworkState;
  identity: string;
  profileId?: string;
  pluginId: string;
  pluginVersion: string;
  sourceFingerprint?: string;
  executor: Pick<PluginExecutor, 'execute'>;
  artifactCache: ArtifactListingCache;
  persist: (framework: RepoFrameworkState) => Promise<void>;
  log?: (message: string) => void;
}

// Shared by lifecycle and manual compiler jobs. Listing failure is explicitly
// best effort: a successful compile must remain successful if cache warming
// cannot list artifacts.
export async function finalizeCompile(input: FinalizeCompileInput): Promise<RepoFrameworkState> {
  const watchPaths = input.framework.watchPaths;
  const generation = input.artifactCache.nextGeneration();
  const framework: RepoFrameworkState = {
    ...input.framework,
    compiledAt: input.framework.compiledAt ?? new Date().toISOString(),
    artifactGeneration: generation,
    ...(watchPaths ? { fingerprint: {
      sources: input.sourceFingerprint ?? await statFingerprint(input.workspacePath, [
        ...watchPaths.config, ...watchPaths.sources,
      ]),
      artifacts: await statFingerprint(input.workspacePath, watchPaths.artifacts),
    } } : {}),
  };
  await input.persist(framework);
  try {
    await input.artifactCache.getOrLoad({
      key: artifactListingCacheKey({
        profileId: input.profileId, canonicalIdentity: input.identity,
        frameworkId: framework.id, pluginId: input.pluginId,
        pluginVersion: input.pluginVersion, generation,
      }),
      workspacePath: input.workspacePath,
      artifactPaths: watchPaths?.artifacts ?? [],
      load: async () => {
        const result = await input.executor.execute(input.pluginId, 'listArtifacts',
          { pathOrUrl: input.pathOrUrl }, { workspacePath: input.workspacePath });
        if (!result.success) throw new Error(result.error?.message ?? `Listing artifacts failed for ${framework.id}`);
        return (result.data as { artifacts?: ArtifactLocation[] } | undefined)?.artifacts ?? [];
      },
    });
  } catch (error) {
    input.log?.(`artifact cache warm failed for ${framework.id}: ${String(error)}\n`);
  }
  return framework;
}
